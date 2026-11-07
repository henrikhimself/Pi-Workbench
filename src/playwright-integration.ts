import { getAgentDir, type BuildSystemPromptOptions, type ExtensionAPI, type ExtensionContext, type ToolCallEvent, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { PlaywrightManager, type PlaywrightManagerDependencies, type PlaywrightStatus } from "./playwright-manager.js";
import { executePlaywrightCommand, parsePlaywrightCommand } from "./playwright-command.js";
import { PLAYWRIGHT_SERVER_NAME, resolvePlaywrightProject } from "./playwright-config.js";
import { PLAYWRIGHT_NORMAL_TOOLS, assertPlaywrightToolCall } from "./playwright-policy.js";
import type { WorkbenchPaths } from "./paths.js";
export const PLAYWRIGHT_STATUS_KEY = "playwright";
export const PLAYWRIGHT_PROMPT_SECTION = "pi-workbench-playwright";
export interface PlaywrightIntegrationOptions {
  paths: WorkbenchPaths;
  signal?: () => AbortSignal;
  agentDir?: () => string;
  manager?: (cwd: string, deps: PlaywrightManagerDependencies) => PlaywrightManager;
  observationMs?: number;
}

/** No backend work, timers, or root preparation until lifecycle/command entry. */
export function createPlaywrightIntegration(pi: ExtensionAPI, options: PlaywrightIntegrationOptions) {
  let manager: PlaywrightManager | undefined, context: ExtensionContext | undefined;
  let generation = 0, closed = false, available = false, view = 0, polling = 0, action = 0;
  let creating: Promise<PlaywrightManager> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = new AbortController();
  const active = (epoch: number, candidate = manager) => !closed && epoch === generation && candidate === manager;
  const stopObservation = () => { polling++; clearTimeout(timer); timer = undefined; };
  const names = () => {
    if (typeof pi.getActiveTools !== "function" || typeof pi.getAllTools !== "function") return [];
    const selected = new Set(pi.getActiveTools());
    return pi.getAllTools().filter(tool => tool.exposure !== "hidden" && (tool.exposure === "codemode" || tool.exposure === "deferred" || selected.has(tool.name)) && PLAYWRIGHT_NORMAL_TOOLS.some(name => tool.name === `mcp__playwright__${name}`)).map(tool => tool.name);
  };
  function footer(ctx: ExtensionContext, state: "off" | "preparing" | "available" | "failed", detail?: string) {
    const color = state === "available" ? "success" : state === "failed" ? "warning" : "dim";
    const text = state === "available" ? "✓ Playwright" : state === "off" ? "○ Playwright off" : state === "failed" ? "⚠ Playwright unavailable" : `⏳ ${detail ?? "Playwright preparing..."}`;
    ctx.ui.setStatus(PLAYWRIGHT_STATUS_KEY, ctx.ui.theme?.fg?.(color, text) ?? text);
  }
  async function conflict(cwd: string): Promise<string | null> {
    if (typeof pi.registerMcpServer !== "function" || typeof pi.unregisterMcpServer !== "function" || typeof pi.getMcpServers !== "function" || typeof pi.getAllTools !== "function" || typeof pi.getActiveTools !== "function") return "required public Pi MCP APIs unavailable";
    const existing = pi.getMcpServers().find(server => server.name === PLAYWRIGHT_SERVER_NAME);
    if (existing && !manager?.isManagedRegistration) return "same-name extension MCP registration";
    for (const path of [join((options.agentDir ?? getAgentDir)(), "mcp.json"), join(cwd, ".pi", "mcp.json")]) {
      let raw: string;
      try { raw = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; return "MCP configuration cannot be inspected safely"; }
      let config: any;
      try { config = JSON.parse(raw); } catch { return "MCP configuration is invalid; conflict cannot be ruled out"; }
      if (!config || typeof config !== "object" || Array.isArray(config) || config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers))) return "MCP configuration shape is invalid";
      if (config?.mcpServers && Object.hasOwn(config.mcpServers, PLAYWRIGHT_SERVER_NAME)) return `same-name MCP declaration in ${path}`;
    }
    return null;
  }
  async function managerFor(ctx: ExtensionContext): Promise<PlaywrightManager> {
    while (creating) await creating.catch(() => {});
    if (manager?.project.identifier === resolvePlaywrightProject(ctx.cwd ?? process.cwd(), options.paths).identifier) { context = ctx; return manager; }
    const operation = createManager(ctx); creating = operation;
    try { return await operation; } finally { if (creating === operation) creating = undefined; }
  }
  async function createManager(ctx: ExtensionContext): Promise<PlaywrightManager> {
    const epoch = generation;
    const project = resolvePlaywrightProject(ctx.cwd ?? process.cwd(), options.paths);
    if (manager?.project.identifier === project.identifier) { context = ctx; return manager; }
    const old = manager; manager = undefined; available = false; stopObservation(); ++view;
    await old?.shutdown();
    if (closed || epoch !== generation) throw new Error("Playwright session is closed or replaced");
    context = ctx;
    let created: PlaywrightManager;
    const deps: PlaywrightManagerDependencies = {
      paths: options.paths, signal: options.signal ? AbortSignal.any([abort.signal, options.signal()]) : abort.signal,
      register: (name, config) => pi.registerMcpServer(name, config), unregister: name => pi.unregisterMcpServer(name),
      isCurrent: config => typeof pi.getMcpServers === "function" && pi.getMcpServers().some(server => server.name === PLAYWRIGHT_SERVER_NAME && isDeepStrictEqual(server.config, config)),
      conflict: () => conflict(project.projectPath), tools: () => typeof pi.getAllTools === "function" ? pi.getAllTools().filter(tool => tool.exposure !== "hidden").map(tool => tool.name) : [],
      progress: message => {
        if (!active(epoch, created)) return;
        ++view;
        if (/failed|unavailable|incomplete|uncertain/i.test(message)) footer(context ?? ctx, "failed");
        else if (message.startsWith("Playwright off;")) footer(context ?? ctx, "off");
        else footer(context ?? ctx, "preparing", message);
      },
    };
    created = (options.manager ?? ((cwd, deps) => new PlaywrightManager(cwd, deps)))(project.projectPath, deps);
    if (epoch !== generation || closed) { await created.shutdown(); throw new Error("Playwright session replaced"); }
    manager = created; return created;
  }
  async function refresh(ctx: ExtensionContext): Promise<PlaywrightStatus | undefined> {
    const candidate = manager, epoch = generation, request = ++view;
    if (!candidate) { available = false; return; }
    let status: PlaywrightStatus;
    try { status = await candidate.status(); }
    catch { if (active(epoch, candidate) && request === view) { available = false; footer(ctx, "failed"); } return; }
    if (!active(epoch, candidate) || request !== view) return;
    available = status.currentRegistration && status.ownedChild && names().length > 0 && resolvePlaywrightProject(ctx.cwd ?? process.cwd(), options.paths).identifier === candidate.project.identifier;
    footer(ctx, available ? "available" : status.failures.length || status.intent === "invalid" || status.intent === "on" && !status.currentRegistration ? "failed" : status.currentRegistration ? "preparing" : "off", "Playwright connecting...");
    return status;
  }
  function observe(ctx: ExtensionContext) {
    stopObservation(); const token = polling, epoch = generation, candidate = manager, deadline = Date.now() + (options.observationMs ?? 30000);
    const check = async () => {
      try {
        const status = await refresh(ctx);
        if (token !== polling || !active(epoch, candidate) || available || !status?.currentRegistration) return;
        if (Date.now() >= deadline) { footer(ctx, "failed"); return; }
        timer = setTimeout(() => { void check(); }, 100);
      } catch { if (token === polling && active(epoch, candidate)) footer(ctx, "failed"); }
    };
    void check();
  }
  function guidance(ctx?: ExtensionContext): string | undefined {
    if (!ctx || !available || !manager?.isManagedRegistration || resolvePlaywrightProject(ctx.cwd ?? process.cwd(), options.paths).identifier !== manager.project.identifier) return;
    const exposed = names(); if (!exposed.length) return;
    return "Managed Playwright is available for this workspace through " + exposed.join(", ") + ". " +
      "Use accessibility snapshots for structure and normal browser tools for requested web tasks. browser_navigate and other action tools only link to a snapshot file; call browser_snapshot to read page content. Screenshots require an image-capable model for visual interpretation; vision tools provide coordinate interactions. " +
      "Each Pi session owns an isolated headless Chromium; browser state lasts until browser closure or runtime/session teardown, not a persistent login profile. " +
      `Write explicit output filenames only inside ${manager.managedSession?.artifacts ?? "the managed session artifact directory"}; project/external output destinations are rejected. Workspace uploads retain upstream file guardrails. ` +
      "Sandbox is mandatory; never retry unsandboxed. HTTP(S) targets include local/LAN/public sites without an origin allowlist. Browser sandboxing does not sandbox the MCP Node process; page/file/origin guardrails are not hard security boundaries. " +
      "browser_evaluate runs page-context JavaScript; server-side unsafe code and page-authored WebMCP tools are unavailable.";
  }
  pi.registerCommand("wb:playwright", {
    description: "Managed Playwright: on, off [--confirm-delete], or status",
    handler: async (raw, ctx) => {
      let command: ReturnType<typeof parsePlaywrightCommand>;
      try { command = parsePlaywrightCommand(raw); } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Invalid Playwright arguments", "warning"); return; }
      const epoch = generation; let commandAction = action;
      try {
        const candidate = await managerFor(ctx);
        if (!active(epoch, candidate)) return;
        if (command.action === "on") { commandAction = ++action; stopObservation(); ++view; footer(ctx, "preparing"); }
        const message = await executePlaywrightCommand(raw, { hasUI: !!ctx.hasUI, confirm: (title, text) => ctx.ui.confirm(title, text), manager: {
          on: () => candidate.on(), status: () => candidate.status(),
          off: async confirmed => { if (confirmed) { commandAction = ++action; available = false; stopObservation(); ++view; footer(ctx, "preparing", "Playwright stopping..."); } return candidate.off(confirmed); },
        } });
        if (!active(epoch, candidate) || commandAction !== action) return;
        ctx.ui.notify(message, "info"); await refresh(ctx);
        if (command.action === "on") observe(ctx);
      } catch (error) {
        if (active(epoch) && commandAction === action) { available = false; footer(ctx, "failed"); ctx.ui.notify(error instanceof Error ? error.message : "Playwright command failed", "warning"); }
      }
    },
  });
  return {
    async start(ctx: ExtensionContext) {
      closed = false; ++generation; ++view; abort.abort(); abort = new AbortController(); stopObservation(); available = false;
      const old = manager; manager = undefined; const epoch = generation, requestAction = action;
      await old?.shutdown(); if (!active(epoch)) return;
      try { const candidate = await managerFor(ctx); await candidate.restore(); if (active(epoch, candidate) && action === requestAction) { await refresh(ctx); observe(ctx); } }
      catch (error) { if (active(epoch) && action === requestAction) { footer(ctx, "failed"); ctx.ui.notify(error instanceof Error ? error.message : "Managed Playwright startup failed", "warning"); } }
    },
    async shutdown() {
      closed = true; ++generation; ++view; available = false; abort.abort(); stopObservation();
      context?.ui.setStatus(PLAYWRIGHT_STATUS_KEY, undefined); context = undefined;
      const old = manager; manager = undefined; await old?.shutdown();
    },
    async beforeAgent(options: BuildSystemPromptOptions, ctx?: ExtensionContext) {
      if (ctx) await refresh(ctx);
      const sections = options.sections ??= {}, text = guidance(ctx);
      if (text) sections[PLAYWRIGHT_PROMPT_SECTION] = text; else delete sections[PLAYWRIGHT_PROMPT_SECTION];
    },
    async toolCall(event: ToolCallEvent, ctx: ExtensionContext) {
      const candidate = manager;
      if (!event.toolName.startsWith("mcp__playwright__") || !candidate?.isManagedRegistration) return;
      const metadata = typeof pi.getAllTools === "function" ? pi.getAllTools().find(tool => tool.name === event.toolName) : undefined;
      if (metadata?.namespace?.name && metadata.namespace.name !== "mcp__playwright") return; // Prefix-adjacent external namespaces are not ours.
      if (!await candidate.ownsToolRoute() || !candidate.isManagedRegistration) return;
      if (!candidate.managedSession || resolvePlaywrightProject(ctx.cwd ?? process.cwd(), options.paths).identifier !== candidate.project.identifier) return { block: true, reason: "Managed Playwright workspace/session changed" };
      try { await assertPlaywrightToolCall(candidate.managedSession, event.toolName, event.input); }
      catch (error) { return { block: true, reason: error instanceof Error ? error.message : "Managed Playwright tool blocked" }; }
    },
    async toolResult(event: ToolResultEvent, ctx: ExtensionContext) {
      if (!event.toolName.startsWith("mcp__playwright__") || !manager?.isManagedRegistration || resolvePlaywrightProject(ctx.cwd ?? process.cwd(), options.paths).identifier !== manager.project.identifier) return;
      const status = await refresh(ctx);
      if (status?.currentRegistration && !available) observe(ctx); // Observe reconnect only; never retry activation.
    },
    refresh, guidance,
  };
}
