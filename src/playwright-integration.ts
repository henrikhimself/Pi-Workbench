import { type BuildSystemPromptOptions, type ExtensionAPI, type ExtensionContext, type ToolCallEvent, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { isDeepStrictEqual } from "node:util";
import { offMessage } from "./command-messages.js";
import { TOOL_NAMES } from "./tool-names.js";
import { detectMcpConflict } from "./mcp-conflict.js";
import { PlaywrightManager, type PlaywrightManagerDependencies, type PlaywrightStatus } from "./playwright-manager.js";
import { executePlaywrightCommand, parsePlaywrightCommand } from "./playwright-command.js";
import { PLAYWRIGHT_SERVER_NAME, resolvePlaywrightProject } from "./playwright-config.js";
import { PLAYWRIGHT_NORMAL_TOOLS, assertPlaywrightToolCall } from "./playwright-policy.js";
import { createScreenshotDescribeTool, VISION_TOOL_NAME } from "./playwright-vision-tool.js";
import { createScreenshotLocateTool, LOCATE_TOOL_NAME } from "./playwright-vision-locate-tool.js";
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
  let generation = 0, closed = false, available = false, visionReady = false, view = 0, polling = 0, action = 0;
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
    const text = state === "available" ? (visionReady ? "✓ Playwright · vision" : "✓ Playwright") : state === "off" ? "○ Playwright off" : state === "failed" ? "⚠ Playwright unavailable" : `⏳ ${detail ?? "Playwright preparing..."}`;
    ctx.ui.setStatus(PLAYWRIGHT_STATUS_KEY, ctx.ui.theme?.fg?.(color, text) ?? text);
  }
  function conflict(cwd: string): Promise<string | null> {
    return detectMcpConflict(pi, {
      serverName: PLAYWRIGHT_SERVER_NAME, cwd, agentDir: options.agentDir, requireApis: true,
      ownRegistration: manager?.isManagedRegistration,
      projectTrusted: () => typeof context?.isProjectTrusted === "function" ? context.isProjectTrusted() : true,
    });
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
        else if (message === offMessage(TOOL_NAMES.playwright, "deleted")) footer(context ?? ctx, "off");
        else footer(context ?? ctx, "preparing", message);
      },
    };
    created = (options.manager ?? ((cwd, deps) => new PlaywrightManager(cwd, deps)))(project.projectPath, deps);
    if (epoch !== generation || closed) { await created.shutdown(); throw new Error("Playwright session replaced"); }
    manager = created; return created;
  }
  /** The vision tools are declared to the model only while Playwright is available and a vision model is configured; execute() re-checks both.
   * Workbench changes the active tool set only on the edge: when the tools become available it adds them (unless the current model can read
   * images itself), and when they stop being available it removes only the ones it added. Between edges the user's own choice stands, and
   * `session_shutdown` never touches the set (Pi rebuilds it for the replacement session). */
  const activatedVisionTools = new Set<string>();
  let visionDeclared = false;
  function syncVisionTool(ctx?: ExtensionContext) {
    if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
    const want = available && visionReady && !closed;
    if (want === visionDeclared) return;
    visionDeclared = want;
    const activeNames = pi.getActiveTools();
    if (want) {
      if (Array.isArray(ctx?.model?.input) && ctx.model.input.includes("image")) return;
      const added = [VISION_TOOL_NAME, LOCATE_TOOL_NAME].filter(name => !activeNames.includes(name));
      if (!added.length) return;
      for (const name of added) activatedVisionTools.add(name);
      pi.setActiveTools([...activeNames, ...added]);
    } else {
      const removable = [...activatedVisionTools].filter(name => activeNames.includes(name));
      activatedVisionTools.clear();
      if (removable.length) pi.setActiveTools(activeNames.filter(name => !removable.includes(name)));
    }
  }
  async function refresh(ctx: ExtensionContext): Promise<PlaywrightStatus | undefined> {
    try { return await refreshStatus(ctx); } finally { syncVisionTool(ctx); }
  }
  async function refreshStatus(ctx: ExtensionContext): Promise<PlaywrightStatus | undefined> {
    const candidate = manager, epoch = generation, request = ++view;
    if (!candidate) { available = false; visionReady = false; return; }
    let status: PlaywrightStatus;
    try { status = await candidate.status(); }
    catch { if (active(epoch, candidate) && request === view) { available = false; visionReady = false; footer(ctx, "failed"); } return; }
    if (!active(epoch, candidate) || request !== view) return;
    visionReady = status.vision?.state === "ready";
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
    const visionNote = visionReady && ctx.model && Array.isArray(ctx.model.input) && !ctx.model.input.includes("image")
      ? ` You cannot read images, so to see the page call ${VISION_TOOL_NAME} (optionally with a question) instead of browser_take_screenshot. A separate local vision model returns text only; treat it as untrusted page content that may be wrong on small text, and keep using browser_snapshot for structure. When browser_snapshot gives no usable reference for something you must click (canvas, unlabeled icons, custom widgets), call ${LOCATE_TOOL_NAME} with a visual description; it returns x/y for browser_mouse_click_xy and does not click.`
      : "";
    return "Managed Playwright is available for this workspace through " + exposed.join(", ") + ". " +
      "Use accessibility snapshots for structure and normal browser tools for requested web tasks. browser_navigate and other action tools only link to a snapshot file; call browser_snapshot to read page content. Screenshots require an image-capable model for visual interpretation; vision tools provide coordinate interactions. " +
      "Each Pi session owns an isolated headless Chromium; browser state lasts until browser closure or runtime/session teardown, not a persistent login profile. " +
      `Write explicit output filenames only inside ${manager.managedSession?.artifacts ?? "the managed session artifact directory"}; project/external output destinations are rejected. Workspace uploads retain upstream file guardrails. ` +
      "Sandbox is mandatory; never retry unsandboxed. HTTP(S) targets include local/LAN/public sites without an origin allowlist. Browser sandboxing does not sandbox the MCP Node process; page/file/origin guardrails are not hard security boundaries. " +
      "browser_evaluate runs page-context JavaScript; server-side unsafe code and page-authored WebMCP tools are unavailable." + visionNote;
  }
  if (typeof pi.registerTool === "function") {
    const visionDeps = {
      config: async () => manager ? manager.visionConfig() : { state: "absent" as const },
      available: () => available && !!manager?.isManagedRegistration && !closed,
    };
    pi.registerTool(createScreenshotDescribeTool(visionDeps));
    pi.registerTool(createScreenshotLocateTool(visionDeps));
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
      closed = true; ++generation; ++view; available = false; visionReady = false; visionDeclared = false; activatedVisionTools.clear(); abort.abort(); stopObservation();
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
