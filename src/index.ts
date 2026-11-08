/**
 * pi-workbench — Transparent LLM context compression for Pi using Headroom.
 *
 * Hooks into Pi's `context` event to compress messages before every LLM call.
 * Restores explicit project compression opt-in and manages its Headroom proxy.
 *
 * Configure proxy and Memory through ~/.pi/pi-workbench/headroom.json.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { convertToLlm, VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { loadPromptRenderer, readPackageVersion, type PromptRendererResult } from "./prompt-renderer.js";
import { compress } from "headroom-ai";
import { compressionSignal, createOwnedHeadroomClient } from "./headroom-client.js";
import { existsSync } from "node:fs";
import type { CompressResult } from "headroom-ai";
import { piToOpenAI, openAIToPiWithOutcome, restoreAgentMessages } from "./format-bridge.js";
import { getHeadroomAiVersion, getManagedHeadroomVersion, ProxyManager, WATCHDOG_HEALTH_TIMEOUT_MS } from "./proxy-manager.js";
import { ManagedHeadroomRuntime } from "./headroom-runtime.js";
import { DEFAULT_HEADROOM_PORT } from "./config.js";
import {
  ensureHeadroomConfigFile,
  headroomRequestTimeoutMs,
  loadHeadroomConfigSync,
  type HeadroomConfig,
} from "./headroom-config.js";
import { WORKBENCH_PATHS, type WorkbenchPaths } from "./paths.js";
import { MemoryManager, MEMORY_SERVER_NAME } from "./memory-manager.js";
import { compressionOptedIn, resolveCompressionProject, setCompressionOptIn } from "./headroom-project.js";
import { assertNoSymlink } from "./managed-lifecycle.js";
import {
  CODE_GRAPH_GUIDANCE_MESSAGE,
  CODE_GRAPH_MCP_SERVER_NAME,
  CodeGraphManager,
} from "./code-graph-manager.js";
import { detectMcpConflict } from "./mcp-conflict.js";
import { enabledMessage, formatStatus, offMessage } from "./command-messages.js";
import { TOOL_NAMES } from "./tool-names.js";
import { CODE_GRAPH_COMPLETIONS, completions, MEMORY_COMPLETIONS, PROXY_COMPLETIONS, STUDY_COMPLETIONS } from "./command-completions.js";
import {
  CodeGraphInstaller,
  detectCodeGraphPlatform,
  unsupportedPlatformMessage,
} from "./code-graph-installer.js";
import { getAsset } from "./code-graph-assets.js";
import {
  formatCodeGraphStatus,
  resolveCodeGraphProject,
  validateManagedProjectPath,
  validateCodeGraphState,
} from "./code-graph-config.js";
import { configureMemoryGit } from "./memory-git.js";
import { applyMemoryGuidance, MEMORY_PROMPT_SECTION, resolveMemoryGuidanceMode } from "./memory-guidance.js";
import { createPlaywrightIntegration, PLAYWRIGHT_PROMPT_SECTION } from "./playwright-integration.js";
import {
  STUDY_ENTRY_TYPE,
  STUDY_GUIDANCE,
  STUDY_PROMPT_SECTION,
  STUDY_STATUS_KEY,
  restoreStudyModeState,
} from "./study-mode.js";

const CODE_GRAPH_PROMPT_SECTION = "pi-workbench-code-graph";

/** After a failed compression, skip Headroom this long before probing the proxy again. */
const PROXY_RETRY_BACKOFF_MS = 30_000;
/** The watchdog restarts a live-but-unresponsive proxy only after this many failed probes in a row. */
const WATCHDOG_FAILURES_BEFORE_RESTART = 3;

export default function piWorkbenchExtension(
  pi: ExtensionAPI,
  options?: { headroomConfigPath?: string; workbenchPaths?: WorkbenchPaths; codeGraphPlatform?: () => { os: string; arch: string }; headroomRuntime?: ManagedHeadroomRuntime; proxyManager?: ProxyManager; agentDir?: () => string; promptRenderer?: () => Promise<PromptRendererResult> },
) {
  const promptRendererLoader = options?.promptRenderer;
  // Test seam: production always uses the canonical WORKBENCH_PATHS.
  const paths = options?.workbenchPaths ?? WORKBENCH_PATHS;
  let lifecycleGeneration = 0;
  let sessionClosed = false;
  let sessionAbort = new AbortController();
  const playwright = createPlaywrightIntegration(pi, { paths, signal: () => sessionAbort.signal });
  const currentGeneration = (generation: number) => !sessionClosed && generation === lifecycleGeneration;
  function background(job: Promise<unknown>, ctx: ExtensionContext, label: string, generation = lifecycleGeneration): void {
    void job.catch((error) => {
      if (currentGeneration(generation)) ctx.ui.notify(`${label}: ${String(error)}`, "warning");
    }).catch(() => {});
  }
  // ─── State ──────────────────────────────────────────────────────────

  let enabled = false;
  let compressionGeneration = 0;
  let compressionPreferenceWork: Promise<void> = Promise.resolve();
  let proxyAvailable: boolean | null = null;
  let proxyWarningShown = false;
  let compressionWarningShown = false;
  let restartAttempted = false;
  /** When set, a failed proxy may be probed again from the context handler at this time. */
  let proxyRetryAt: number | null = null;
  let proxyWatchdog: ReturnType<typeof setInterval> | null = null;
  let proxyWatchdogGeneration = 0;

  let sessionTotals = { calls: 0, tokensSaved: 0 };
  let memoryRegistered = false;
  let memoryRegistrationDirectory: string | null = null;
  let memoryConflict: string | null = null;
  let memoryRootWarningShown = false;
  let codeGraphManager: CodeGraphManager | null = null;
  let codeGraphActivationQuiet = false;
  let codeGraphStatusContext: ExtensionContext | null = null;
  let codeGraphGuidanceActive = false;

  // Standalone codebase-memory-mcp lifecycle. Independent from the
  // Headroom proxy and Memory; never modifies external services.
  const codeGraphPlatform = options?.codeGraphPlatform ?? (() => ({ os: process.platform, arch: process.arch }));
  const codeGraphInstaller = new CodeGraphInstaller({ paths, platform: codeGraphPlatform, signal: sessionAbort.signal });
  const CODE_GRAPH_STATUS_KEY = "code-graph";
  let studyEnabled = false;

  // ─── Configuration ──────────────────────────────────────────────────

  const headroomRuntime = options?.headroomRuntime ?? new ManagedHeadroomRuntime({ paths, signal: sessionAbort.signal });
  const headroomConfigPath = options?.headroomConfigPath ?? paths.headroomConfig;
  let headroomConfig: HeadroomConfig = { schemaVersion: 1 };
  let port = DEFAULT_HEADROOM_PORT;
  let portConfigError: string | null = null;
  try {
    headroomConfig = loadHeadroomConfigSync(headroomConfigPath);
    port = headroomConfig.port ?? DEFAULT_HEADROOM_PORT;
  } catch (error) {
    portConfigError = error instanceof Error ? error.message : String(error);
  }
  // The client always waits longer than the proxy's own (configurable) compression timeout.
  const requestTimeoutMs = headroomRequestTimeoutMs(headroomConfig.proxy);
  const proxyManager = !portConfigError ? (options?.proxyManager ?? new ProxyManager({ port, runtime: headroomRuntime, tuning: headroomConfig.proxy, requestTimeoutMs })) : null;
  const baseUrl = `http://127.0.0.1:${port}`;
  // Keep SDK fallback disabled so proxy failures reach the context handler,
  // which marks the proxy offline, attempts managed recovery, and fails open.
  const client = createOwnedHeadroomClient(proxyManager, requestTimeoutMs);

  async function checkActiveProxy(): Promise<{ ok: boolean }> {
    return { ok: !!proxyManager?.isManaged && await proxyManager.healthCheck() };
  }

  function stopProxyWatchdog(): void {
    proxyWatchdogGeneration += 1;
    if (proxyWatchdog) clearInterval(proxyWatchdog);
    proxyWatchdog = null;
  }

  /** Compression is available again: undo the offline state and say so. */
  function markProxyAvailable(ctx: ExtensionContext): void {
    if (!enabled) return;
    const recovered = proxyAvailable !== true;
    proxyAvailable = true;
    proxyRetryAt = null;
    if (!recovered) return;
    proxyWarningShown = false;
    ctx.ui.setStatus("headroom-proxy", colorText(ctx, "success", "✓") + colorText(ctx, "dim", " Headroom"));
  }

  function markProxyUnavailable(): void {
    proxyAvailable = false;
    proxyRetryAt = Date.now() + PROXY_RETRY_BACKOFF_MS;
  }

  function startProxyWatchdog(ctx: ExtensionContext): void {
    stopProxyWatchdog();
    if (!proxyManager) return;
    const generation = proxyWatchdogGeneration;
    let failures = 0, busy = false;
    proxyWatchdog = setInterval(() => {
      if (busy) return; // a restart can outlast the interval
      busy = true;
      void (async () => {
        // Only extension-owned children qualify. External proxies are never probed,
        // restarted, stopped, or otherwise modified by this watchdog.
        if (!proxyManager.isManaged) return;
        if (await proxyManager.healthCheck(WATCHDOG_HEALTH_TIMEOUT_MS)) {
          failures = 0;
          if (generation === proxyWatchdogGeneration) markProxyAvailable(ctx);
          return;
        }
        // A shutdown, disable, or replacement session may have occurred while
        // healthCheck awaited. Never restart after this watchdog was cancelled.
        if (generation !== proxyWatchdogGeneration || !enabled) return;
        // A proxy that is busy compressing can miss a health probe. Restart only when the
        // process is gone, or after several consecutive failed probes.
        failures++;
        if (failures < WATCHDOG_FAILURES_BEFORE_RESTART && await proxyManager.processAlive()) return;
        if (generation !== proxyWatchdogGeneration || !enabled) return;
        failures = 0;
        proxyAvailable = false;
        proxyRetryAt = null; // the restart below decides when compression is available again
        ctx.ui.setStatus("headroom-proxy", colorText(ctx, "dim", "⏳ Headroom restarting..."));
        const recovered = await proxyManager.tryRestart((msg) => {
          if (generation === proxyWatchdogGeneration) ctx.ui.setStatus("headroom-proxy", colorText(ctx, "dim", `⏳ ${msg}`));
        });
        if (generation !== proxyWatchdogGeneration || !enabled) return;
        if (recovered) {
          markProxyAvailable(ctx);
        } else {
          markProxyUnavailable();
          ctx.ui.setStatus(
            "headroom-proxy",
            colorText(ctx, "warning", "⚠") + colorText(ctx, "dim", " Headroom offline"),
          );
        }
      })().catch(() => {}).finally(() => { busy = false; });
    }, 30_000);
  }

  function colorText(ctx: ExtensionContext, color: "dim" | "warning" | "success" | "error", text: string): string {
    return ctx.ui.theme?.fg?.(color, text) ?? text;
  }

  function compressionStatus(): string {
    return headroomConfig.compression ? JSON.stringify(headroomConfig.compression) : "defaults";
  }

  function memoryGuidanceMode() {
    const activeToolNames = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
    return resolveMemoryGuidanceMode({
      memoryRegistered,
      studyEnabled,
      activeToolNames,
    });
  }

  function activeCodeGraphGuidance(): string | undefined {
    if (!codeGraphGuidanceActive || !codeGraphManager?.isMcpRegistered) return undefined;
    if (typeof pi.getActiveTools !== "function") return CODE_GRAPH_GUIDANCE_MESSAGE; // Injected minimal test API only.
    const active = new Set(pi.getActiveTools());
    const known = ["search_graph", "trace_path", "get_architecture", "get_code_snippet", "get_file_outline", "query_graph"];
    const available = known.filter(name => active.has(`mcp__codebase-memory__${name}`) || active.has(`mcp__codebase_memory__${name}`));
    if (!available.length) return undefined;
    return CODE_GRAPH_GUIDANCE_MESSAGE.replace("(" + known.join(", ") + ")", "(" + available.join(", ") + ")");
  }

  function setMemoryStatus(ctx: ExtensionContext, state: "starting" | "ready" | "offline" | "off"): void {
    const label = state === "starting"
      ? "⏳ Headroom Memory preparing..."
      : state === "ready"
        ? "✓ Headroom Memory"
        : state === "offline"
          ? "⚠ Headroom Memory offline"
          : "○ Headroom Memory off";
    const color = state === "ready" ? "success" : state === "off" ? "dim" : state === "offline" ? "warning" : "dim";
    ctx.ui.setStatus("headroom-memory", colorText(ctx, color, label));
  }

  function setStudyStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(STUDY_STATUS_KEY, studyEnabled ? colorText(ctx, "success", "✓ Study") : colorText(ctx, "dim", "○ Study off"));
  }

  function restoreStudyState(ctx: ExtensionContext): void {
    studyEnabled = restoreStudyModeState(ctx.sessionManager.getBranch()).enabled;
    setStudyStatus(ctx);
  }

  function persistStudyState(): void {
    pi.appendEntry(STUDY_ENTRY_TYPE, { enabled: studyEnabled });
  }

  /** Workbench's own prompt sections as they would be built now (study, memory, Code Graph, Playwright). */
  function workbenchSections(ctx: ExtensionCommandContext, base: Record<string, string> | undefined): Record<string, string> {
    const sections = { ...base };
    if (studyEnabled) sections[STUDY_PROMPT_SECTION] = STUDY_GUIDANCE;
    else delete sections[STUDY_PROMPT_SECTION];
    applyMemoryGuidance(sections, memoryGuidanceMode());
    const graphGuidance = activeCodeGraphGuidance();
    if (graphGuidance) sections[CODE_GRAPH_PROMPT_SECTION] = graphGuidance;
    else delete sections[CODE_GRAPH_PROMPT_SECTION];
    const playwrightGuidance = playwright.guidance(ctx);
    if (playwrightGuidance) sections[PLAYWRIGHT_PROMPT_SECTION] = playwrightGuidance;
    else delete sections[PLAYWRIGHT_PROMPT_SECTION];
    return sections;
  }

  /**
   * The effective prompt (`ctx.getSystemPrompt()`) is the source of truth. Pi's
   * internal renderer is used only when it loads and matches the running Pi, so
   * the preview can also reflect changes made since the last turn. Otherwise the
   * effective prompt is shown, with any Workbench guidance it lacks appended.
   */
  async function buildSystemPromptPreview(ctx: ExtensionCommandContext): Promise<string> {
    await playwright.refresh(ctx);
    const options = ctx.getSystemPromptOptions();
    const sections = workbenchSections(ctx, options.sections);
    let loaded = await (promptRendererLoader ?? (() => loadPromptRenderer({
      resolve: (specifier) => import.meta.resolve(specifier),
      load: (url) => import(url),
      readVersion: readPackageVersion,
      runningVersion: PI_VERSION,
    })))();
    if ("renderer" in loaded) {
      try { return loaded.renderer({ ...options, sections }); }
      catch (error) { loaded = { note: `Pi renderer not used: ${error instanceof Error ? error.message : String(error)}` }; }
    }
    const effective = ctx.getSystemPrompt();
    const owned = [STUDY_PROMPT_SECTION, MEMORY_PROMPT_SECTION, CODE_GRAPH_PROMPT_SECTION, PLAYWRIGHT_PROMPT_SECTION];
    const extra = owned
      .filter((key) => sections[key] && !effective.includes(sections[key]!))
      .map((key) => `<${key}>\n${sections[key]}\n</${key}>`).join("\n\n");
    return [`[${loaded.note}]`, effective, extra && `[Workbench guidance not yet in the effective prompt]\n\n${extra}`].filter(Boolean).join("\n\n");
  }

  function managerFor(ctx: ExtensionContext, passive = false): MemoryManager | null {
    if (portConfigError) { setMemoryStatus(ctx, "off"); return null; }
    try {
      const manager = new MemoryManager({
        cwd: ctx.cwd ?? process.cwd(),
        root: headroomConfig.memory?.root,
        defaultRoot: paths.headroomMemory,
        runtime: headroomRuntime,
        signal: sessionAbort.signal,
        userId: headroomConfig.memory?.namespace,
        exportPath: headroomConfig.memory?.export,
      });
      if (memoryRegistered && memoryRegistrationDirectory !== manager.store.directory) {
        pi.unregisterMcpServer(MEMORY_SERVER_NAME); memoryRegistered = false; memoryRegistrationDirectory = null;
      }
      if ((!passive || manager.enabled) && manager.store.rootConfigured && manager.store.rootInsideProject && !memoryRootWarningShown) {
        memoryRootWarningShown = true;
        ctx.ui.notify(
          "headroom.json memory.root resolves inside this project. Memory SQLite data may enter repository tooling; Git LFS stores blobs but cannot merge database writes.",
          "warning",
        );
      }
      return manager;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!passive) ctx.ui.notify(`Headroom Memory disabled: ${message}`, "error");
      setMemoryStatus(ctx, passive ? "off" : "offline");
      return null;
    }
  }

  // ─── Code graph (standalone codebase-memory-mcp) ──────────────────

  function codeGraphManagerFor(ctx: ExtensionContext): CodeGraphManager {
    codeGraphStatusContext = ctx;
    const project = resolveCodeGraphProject(ctx.cwd ?? process.cwd(), paths);
    if (codeGraphManager && codeGraphManager.registeredProjectDirectory && codeGraphManager.registeredProjectDirectory !== project.directory) {
      background(codeGraphManager.shutdown(), ctx, "Previous workspace graph shutdown");
      codeGraphManager = null; codeGraphGuidanceActive = false;
    }
    if (!codeGraphManager) {
      const generation = lifecycleGeneration;
      codeGraphManager = new CodeGraphManager({
        paths, signal: sessionAbort.signal,
        // Production path: packaged manifest only; no test-seam asset.
        ensureInstalled: (onStatus) => codeGraphInstaller.ensureInstalled(onStatus),
        onStatus: (message) => {
          if (currentGeneration(generation) && !codeGraphActivationQuiet) {
            const statusContext = codeGraphStatusContext ?? ctx;
            statusContext.ui.setStatus(CODE_GRAPH_STATUS_KEY, colorText(statusContext, "dim", `⏳ ${message}`));
          }
        },
        registerMcp: (name, config) => pi.registerMcpServer(name, config),
        unregisterMcp: (name) => pi.unregisterMcpServer(name),
        conflict: () => detectMcpConflict(pi, {
          serverName: CODE_GRAPH_MCP_SERVER_NAME, cwd: ctx.cwd ?? process.cwd(), agentDir: options?.agentDir,
          projectTrusted: () => { const current = codeGraphStatusContext ?? ctx; return typeof current.isProjectTrusted === "function" ? current.isProjectTrusted() : true; },
        }),
      });
    }
    return codeGraphManager;
  }

  function codeGraphProjectFor(ctx: ExtensionContext) {
    return resolveCodeGraphProject(ctx.cwd ?? process.cwd(), paths);
  }

  function codeGraphStatusOn(ctx: ExtensionContext): void {
    ctx.ui.setStatus(
      CODE_GRAPH_STATUS_KEY,
      colorText(ctx, "success", "✓") + colorText(ctx, "dim", " Code Graph"),
    );
  }

  function codeGraphStatusOff(ctx: ExtensionContext): void {
    ctx.ui.setStatus(
      CODE_GRAPH_STATUS_KEY,
      colorText(ctx, "dim", "○ Code Graph off"),
    );
  }

  /**
   * Restore this workspace's code graph at session start. Independent of
   * the Headroom proxy and Memory; callers use it fire-and-forget so it
   * can never delay their startup. Fail-open: any problem leaves the
   * feature off with a diagnostic.
   */
  async function restoreCodeGraph(ctx: ExtensionContext): Promise<void> {
    const generation = lifecycleGeneration;
    try {
      const manager = codeGraphManagerFor(ctx);
      const result = await manager.restore(codeGraphProjectFor(ctx));
      if (!currentGeneration(generation)) return;
      if (result.ok) {
        codeGraphGuidanceActive = true;
        codeGraphStatusOn(ctx);
        return;
      }
      codeGraphGuidanceActive = false;
      codeGraphStatusOff(ctx);
      if (result.kind !== "off") {
        ctx.ui.notify(`Code graph ${result.kind}: ${result.detail}`, "warning");
      }
    } catch (error) {
      if (!currentGeneration(generation)) return;
      codeGraphGuidanceActive = false;
      codeGraphStatusOff(ctx);
      ctx.ui.notify(`Code graph restore failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  }

  /** `show` can print megabytes; keep the notification readable and point at the full bundle. */
  function truncateForDisplay(text: string, limit = 100_000): string {
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}\n… output truncated (${text.length} characters in total). Run /wb:headroom-memory export to write the full bundle to the configured export directory.`;
  }

  /** Prepare and register project Memory. Missing store is intentionally a no-op. */
  async function startMemory(ctx: ExtensionContext, createStore: boolean): Promise<boolean> {
    const generation = lifecycleGeneration;
    const manager = managerFor(ctx, !createStore);
    if (!manager) return false;
    if (!createStore && !manager.enabled) {
      setMemoryStatus(ctx, "off");
      return false;
    }

    try {
      await manager.ensureRoot();
      if (!currentGeneration(generation)) return false;
      await ensureConfiguration(ctx);
      if (!currentGeneration(generation)) return false;
    } catch (error) {
      if (!currentGeneration(generation)) return false;
      const message = error instanceof Error ? error.message : String(error);
      setMemoryStatus(ctx, "offline");
      ctx.ui.notify(`Headroom Memory root unavailable: ${message}`, "warning");
      return false;
    }

    setMemoryStatus(ctx, "starting");
    const python = await manager.prepare((message) => {
      if (currentGeneration(generation)) ctx.ui.setStatus("headroom-memory", colorText(ctx, "dim", `⏳ ${message}`));
    });
    if (!currentGeneration(generation)) return false;
    if (!python) {
      setMemoryStatus(ctx, "offline");
      ctx.ui.notify("Headroom Memory unavailable; context compression remains available.", "warning");
      return false;
    }

    try {
      if (createStore) await manager.createStore();
      if (!currentGeneration(generation)) return false;
      // Pi gives mcp.json precedence and silently drops a same-name extension registration.
      memoryConflict = await detectMcpConflict(pi, {
        serverName: MEMORY_SERVER_NAME, cwd: ctx.cwd ?? process.cwd(), ownRegistration: memoryRegistered, agentDir: options?.agentDir,
        projectTrusted: () => typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : true,
      });
      if (!currentGeneration(generation)) return false;
      if (memoryConflict) {
        setMemoryStatus(ctx, "offline");
        ctx.ui.notify(`Headroom Memory not registered: ${memoryConflict}. The existing server was left untouched.`, "warning");
        return false;
      }
      pi.registerMcpServer(MEMORY_SERVER_NAME, manager.getMcpConfig(python));
      memoryRegistered = true; memoryRegistrationDirectory = manager.store.directory;
      setMemoryStatus(ctx, "ready");
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMemoryStatus(ctx, "offline");
      if (!currentGeneration(generation)) return false;
      ctx.ui.notify(`Headroom Memory unavailable: ${message}`, "warning");
      return false;
    }
  }

  /** Stop active Memory MCP around direct-store work, then restore it if needed. */
  async function withMemoryStore<T>(
    ctx: ExtensionContext,
    manager: MemoryManager,
    action: (python: string) => Promise<T>,
  ): Promise<T | null> {
    const generation = lifecycleGeneration;
    const restoreRegistration = memoryRegistered && memoryRegistrationDirectory === manager.store.directory;
    if (restoreRegistration) {
      pi.unregisterMcpServer(MEMORY_SERVER_NAME);
      memoryRegistered = false;
    }
    try {
      const python = await manager.ensureRuntime((message) => {
        ctx.ui.setStatus("headroom-memory", colorText(ctx, "dim", `⏳ ${message}`));
      });
      if (!python) {
        ctx.ui.notify("Headroom Memory runtime unavailable", "error");
        return null;
      }
      return await action(python);
    } finally {
      // Restore the registration whether or not the action succeeded: a failing `show` must not leave
      // Memory unregistered. startMemory reports "offline" itself when the restart fails or the store is gone.
      if (restoreRegistration && currentGeneration(generation)) await startMemory(ctx, false);
    }
  }

  /** Only opted-in features create configuration or prepare managed storage. */
  async function ensureConfiguration(ctx: ExtensionContext): Promise<void> {
    await assertNoSymlink(headroomConfigPath);
    if (await ensureHeadroomConfigFile(headroomConfigPath)) ctx.ui.notify("Created managed Headroom configuration.", "info");
  }

  const compressionCurrent = (generation: number, epoch: number) =>
    currentGeneration(generation) && epoch === compressionGeneration;

  async function activateCompression(ctx: ExtensionContext, generation: number, epoch: number): Promise<boolean> {
    if (!compressionCurrent(generation, epoch)) return false;
    if (portConfigError || !proxyManager) {
      enabled = false; proxyAvailable = false;
      ctx.ui.setStatus("headroom-proxy", colorText(ctx, "warning", "⚠ Headroom offline"));
      ctx.ui.notify(`Headroom compression disabled: ${portConfigError}`, "error");
      return false;
    }
    await ensureConfiguration(ctx);
    if (!compressionCurrent(generation, epoch)) return false;
    enabled = true; proxyAvailable = false; proxyRetryAt = null;
    await proxyManager.resume();
    if (!compressionCurrent(generation, epoch) || !enabled) return false;
    const ok = await proxyManager.ensureRunning(message => {
      if (compressionCurrent(generation, epoch) && enabled) ctx.ui.setStatus("headroom-proxy", colorText(ctx, "dim", message));
    });
    if (!compressionCurrent(generation, epoch) || !enabled) return false;
    proxyAvailable = ok;
    if (ok) startProxyWatchdog(ctx);
    ctx.ui.setStatus("headroom-proxy", colorText(ctx, ok ? "success" : "warning", ok ? "✓ Headroom" : "⚠ Headroom offline"));
    return ok;
  }

  // ─── Session start: restore explicit per-project choices ───────────

  pi.on("session_start", async (_event, ctx) => {
    sessionAbort.abort(); sessionAbort = new AbortController();
    sessionClosed = false; const generation = ++lifecycleGeneration;
    const epoch = ++compressionGeneration;
    headroomRuntime.setSignal(sessionAbort.signal); codeGraphInstaller.setSignal(sessionAbort.signal);
    stopProxyWatchdog();
    // Guard for SDK hosts that call session_start twice on one instance. In Pi each extension
    // instance gets exactly one session_start (a replacement creates a new instance).
    const previousCompression = enabled;
    enabled = false; proxyAvailable = false;
    if (previousCompression && proxyManager) background(proxyManager.stop(), ctx, "Previous managed proxy stop", generation);
    const previousGraph = codeGraphManager; codeGraphManager = null;
    if (previousGraph) background(previousGraph.shutdown(), ctx, "Previous graph shutdown", generation);
    if (memoryRegistered) pi.unregisterMcpServer(MEMORY_SERVER_NAME);
    memoryRegistered = false; memoryRegistrationDirectory = null;
    restoreStudyState(ctx); codeGraphGuidanceActive = false;
    proxyWarningShown = false; compressionWarningShown = false; restartAttempted = false; proxyRetryAt = null;
    memoryRootWarningShown = false; memoryConflict = null; sessionTotals = { calls: 0, tokensSaved: 0 };
    ctx.ui.setStatus("headroom-proxy", colorText(ctx, "dim", "○ Headroom off"));
    codeGraphStatusOff(ctx);
    const proxyJob = async () => {
      try {
        const optedIn = await compressionOptedIn(resolveCompressionProject(ctx.cwd ?? process.cwd(), paths));
        if (!compressionCurrent(generation, epoch) || !optedIn) return;
        const ok = await activateCompression(ctx, generation, epoch);
        if (!ok && compressionCurrent(generation, epoch) && !portConfigError) {
          ctx.ui.notify("Managed Headroom unavailable; original context remains usable. Project opt-in retained; retry /wb:headroom-proxy on.", "warning");
        }
      } catch (error) {
        if (!compressionCurrent(generation, epoch)) return;
        enabled = false; proxyAvailable = false;
        ctx.ui.setStatus("headroom-proxy", colorText(ctx, "warning", "⚠ Headroom offline"));
        ctx.ui.notify(`Project Headroom compression unavailable: ${String(error)}`, "warning");
      }
    };
    // Passive off checks never create roots/config or start backend preparation.
    background(proxyJob(), ctx, "Managed proxy startup", generation);
    background(startMemory(ctx, false), ctx, "Memory startup", generation);
    background(restoreCodeGraph(ctx), ctx, "Code Graph startup", generation);
    background(playwright.start(ctx), ctx, "Playwright startup", generation);
  });

  pi.on("session_tree", (_event, ctx) => {
    restoreStudyState(ctx);
  });

  pi.on("session_shutdown", async (event) => {
    // Pi 1.5.0: "quit" ends the process; "reload", "new", "resume" and "fork" replace this extension
    // instance. For a replacement the proxy is handed over: release the lease, keep it running.
    // Memory, Code Graph and Playwright are MCP servers that Pi itself stops and restarts.
    const keepProxy = typeof event?.reason === "string" && event.reason !== "quit";
    sessionClosed = true; lifecycleGeneration++; sessionAbort.abort(); stopProxyWatchdog();
    codeGraphGuidanceActive = false;
    if (memoryRegistered) {
      try { pi.unregisterMcpServer(MEMORY_SERVER_NAME); } catch { /* Continue independent cleanup. */ }
    }
    memoryRegistered = false; memoryRegistrationDirectory = null;
    const graph = codeGraphManager; codeGraphManager = null;
    await Promise.allSettled([graph?.shutdown(), proxyManager?.stop(keepProxy ? { terminate: false } : undefined), playwright.shutdown()]);
  });

  // ─── Prompt guidance before every agent run ────────────────────────

  pi.on("before_agent_start", async (event, ctx) => {
    if (studyEnabled) {
      event.systemPromptOptions.sections[STUDY_PROMPT_SECTION] = STUDY_GUIDANCE;
    } else {
      delete event.systemPromptOptions.sections[STUDY_PROMPT_SECTION];
    }
    applyMemoryGuidance(event.systemPromptOptions.sections, memoryGuidanceMode());
    const graphGuidance = activeCodeGraphGuidance();
    if (graphGuidance) event.systemPromptOptions.sections[CODE_GRAPH_PROMPT_SECTION] = graphGuidance;
    else delete event.systemPromptOptions.sections[CODE_GRAPH_PROMPT_SECTION];
    await playwright.beforeAgent(event.systemPromptOptions, ctx);
  });

  pi.on("tool_call", (event, ctx) => playwright.toolCall(event, ctx));
  pi.on("tool_result", (event, ctx) => playwright.toolResult(event, ctx));

  // ─── Core: compress context before every LLM call ───────────────────

  pi.on("context", async (event, ctx) => {
    const generation = lifecycleGeneration, epoch = compressionGeneration;
    const active = () => compressionCurrent(generation, epoch) && enabled;
    if (!active()) return;
    if (portConfigError) {
      proxyAvailable = false;
      ctx.ui.notify(`Headroom proxy unavailable: ${portConfigError}`, "warning");
      ctx.ui.setStatus("headroom-proxy", colorText(ctx, "warning", "⚠ Headroom offline"));
      return;
    }
    if (proxyAvailable === false) {
      // Offline after a failure: skip compression during the back-off, then probe once per
      // call. Activation and watchdog restarts leave no retry time, so they are never probed.
      if (proxyRetryAt === null || Date.now() < proxyRetryAt) return;
      const health = await checkActiveProxy();
      if (!active()) return;
      if (!health.ok) { markProxyUnavailable(); return; }
      markProxyAvailable(ctx);
    }
    // No per-call health request: requestOwned verifies the owner record, process identity,
    // consumer lease and the authenticated response. Health is checked only after a failure.

    // Convert AgentMessage[] → Pi-AI Message[] → OpenAI format. Convert one message at a
    // time so each converted message keeps its source (convertToLlm may drop or rewrite
    // custom, bash-execution and summary messages).
    const sources = event.messages.flatMap((agent) => convertToLlm([agent]).map((llm) => ({ agent, llm })));
    const piMessages = sources.map((source) => source.llm);
    if (piMessages.length === 0) return;

    const openaiMessages = piToOpenAI(piMessages);
    if (openaiMessages.length === 0) return;

    try {
      const signal = ctx.signal;
      if (signal?.aborted) return;
      const result: CompressResult = await compressionSignal.run(signal, () => compress(openaiMessages, {
        client,
        model: ctx.model?.id ?? "gpt-4o",
        ...(headroomConfig.compression ? { config: headroomConfig.compression } : {}),
      }));

      if (!active()) return;
      compressionWarningShown = false;

      if (!result.compressed || result.tokensSaved <= 0) {
        ctx.ui.setStatus(
          "headroom-proxy",
          colorText(ctx, "success", "✓") +
            colorText(ctx, "dim", ` Headroom (${openaiMessages.length} msgs, no compression needed)`),
        );
        return;
      }

      // Convert compressed OpenAI → Pi-AI Message[]. A safety fallback retains the
      // original context, so reported proxy savings were not applied.
      const conversion = openAIToPiWithOutcome(result.messages, piMessages);
      if (!conversion.applied) {
        const detail = conversion.reason === "unmatched-after-count-change" ? "message count changed" : "images retained";
        ctx.ui.setStatus(
          "headroom-proxy",
          colorText(ctx, "warning", "⚠") +
            colorText(ctx, "dim", ` Headroom safety fallback (${detail})`),
        );
        return;
      }
      // When the message count is unchanged, hand back the original agent messages
      // wherever Headroom changed nothing, so later `context` handlers still see
      // their custom roles. A changed count has no per-message source to restore.
      const compressedPiMessages = restoreAgentMessages(
        sources.map((source) => source.agent),
        piMessages,
        conversion.messages,
      );

      // Update stats
      sessionTotals.calls++;
      sessionTotals.tokensSaved += result.tokensSaved;

      // Update status bar
      const saved = result.tokensSaved.toLocaleString();
      const pct = Math.round((1 - result.compressionRatio) * 100);
      ctx.ui.setStatus(
        "headroom-proxy",
        colorText(ctx, "success", "✓") + colorText(ctx, "dim", ` Headroom -${pct}% (${saved} saved)`),
      );

      return { messages: compressedPiMessages as any };
    } catch (error) {
      if (!active()) return;
      // The agent run was aborted: use the original context. This is not a proxy failure.
      if (ctx.signal?.aborted) return;
      const errMsg = error instanceof Error ? error.message : String(error);
      const health = await checkActiveProxy();
      if (!active()) return;

      if (health.ok) {
        proxyAvailable = true;
        proxyRetryAt = null;
        if (!compressionWarningShown) {
          compressionWarningShown = true;
          ctx.ui.notify(`Headroom compression request failed: ${errMsg}`, "warning");
        }
        ctx.ui.setStatus(
          "headroom-proxy",
          colorText(ctx, "warning", "⚠") + colorText(ctx, "dim", " Headroom request failed"),
        );
        return;
      }

      markProxyUnavailable();
      if (!proxyWarningShown) {
        proxyWarningShown = true;
        const diagnostic = "Headroom proxy unavailable";
        ctx.ui.notify(`${diagnostic}: ${errMsg}`, "warning");
        ctx.ui.setStatus(
          "headroom-proxy",
          colorText(ctx, "warning", "⚠") + colorText(ctx, "dim", " Headroom offline"),
        );
      }

      // Mid-session crash recovery (one attempt per session). Only when the proxy process is
      // gone: an unresponsive but live proxy may just be busy, and the watchdog decides later.
      if (proxyManager && !restartAttempted && !await proxyManager.processAlive()) {
        restartAttempted = true;
        proxyRetryAt = null; // the restart decides when compression is available again
        const recovered = await proxyManager.tryRestart((msg) => {
          if (active()) ctx.ui.setStatus("headroom-proxy", colorText(ctx, "dim", `⏳ ${msg}`));
        });
        if (!active()) return;
        if (recovered) {
          markProxyAvailable(ctx);
          // Don't retry compression this call — next context event will use it
        } else {
          markProxyUnavailable();
        }
      }

      return;
    }
  });

  // ─── /wb:headroom-proxy command — toggle and status ────────────────

  pi.registerCommand("wb:headroom-proxy", {
    getArgumentCompletions: completions(PROXY_COMPLETIONS),
    description: "Persist project compression on/off, or show status. Usage: /wb:headroom-proxy [on|off|status]",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "off" || action === "on") {
        const generation = lifecycleGeneration, epoch = ++compressionGeneration;
        const signal = sessionAbort.signal;
        enabled = false; proxyAvailable = false; stopProxyWatchdog();
        if (action === "off") {
          if (proxyManager) background(proxyManager.stop(), ctx, "Managed proxy stop");
          ctx.ui.setStatus("headroom-proxy", colorText(ctx, "dim", "○ Headroom off"));
        }
        // Serialize commands in this session; the managed lock coordinates peers.
        let wasOn = true;
        const update = compressionPreferenceWork.then(async () => {
          if (!compressionCurrent(generation, epoch)) return false;
          const project = resolveCompressionProject(ctx.cwd ?? process.cwd(), paths);
          wasOn = await compressionOptedIn(project);
          await setCompressionOptIn(project, action === "on", signal);
          return true;
        });
        compressionPreferenceWork = update.then(() => {}, () => {});
        try {
          if (!await update || !compressionCurrent(generation, epoch)) return;
          if (action === "off") {
            ctx.ui.notify(offMessage(TOOL_NAMES.compression, wasOn ? "disabled" : "already-off"), "info");
            return;
          }
          proxyWarningShown = false; compressionWarningShown = false; restartAttempted = false; proxyRetryAt = null;
          const ok = await activateCompression(ctx, generation, epoch);
          if (!compressionCurrent(generation, epoch)) return;
          ctx.ui.notify(ok ? enabledMessage(TOOL_NAMES.compression) : "Managed Headroom unavailable; project opt-in retained and context remains usable",
            ok ? "info" : "warning");
        } catch (error) {
          if (!compressionCurrent(generation, epoch)) return;
          enabled = false; proxyAvailable = false;
          ctx.ui.setStatus("headroom-proxy", colorText(ctx, action === "off" ? "dim" : "warning", action === "off" ? "○ Headroom off" : "⚠ Headroom offline"));
          ctx.ui.notify(action === "off"
            ? `Compression disabled for this session, but project opt-out could not be saved; startup may retry. ${String(error)}`
            : `Project compression opt-in/activation failed; context remains usable. ${String(error)}`, "warning");
        }
        return;
      }
      const project = resolveCompressionProject(ctx.cwd ?? process.cwd(), paths);
      let projectState: string;
      try { projectState = await compressionOptedIn(project) ? "on" : "off"; }
      catch (error) { projectState = `refused (${error instanceof Error ? error.message : String(error)})`; }
      const healthy = (await checkActiveProxy()).ok;
      const expected = await getHeadroomAiVersion();
      const installed = await getManagedHeadroomVersion(headroomRuntime).catch(() => null);
      ctx.ui.notify(formatStatus(TOOL_NAMES.compression, {
        state: projectState,
        projectPath: project.projectPath,
        identifier: project.identifier,
        data: existsSync(project.directory) ? project.directory : null,
        version: { installed, ...(expected ? { expected } : {}) },
        link: healthy ? "running" : "not running",
        ...(portConfigError ? { problem: portConfigError } : {}),
        details: [
          `This session: ${enabled ? "on" : "off"}. On/off persists for this project; active peers keep their current session state.`,
          "Mode: extension-managed only", `URL: ${baseUrl}`,
          `Config: ${compressionStatus()}`, `Compressed calls: ${sessionTotals.calls}`,
          `Tokens saved: ${sessionTotals.tokensSaved.toLocaleString()}`,
        ],
      }).join("\n"), "info");
    },
  });

  // ─── /wb:study-mode command — tutor-only lifecycle ───────────────

  pi.registerCommand("wb:study-mode", {
    getArgumentCompletions: completions(STUDY_COMPLETIONS),
    description: "Toggle tutor-only Study Mode. Usage: /wb:study-mode [on|off]",
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action !== "on" && action !== "off") {
        ctx.ui.notify("Usage: /wb:study-mode [on|off]", "error");
        return;
      }
      if (action === "on") {
        if (!studyEnabled) {
          studyEnabled = true;
          persistStudyState();
        }
        setStudyStatus(ctx);
        ctx.ui.notify(
          "Study Mode enabled. Guidance favors explanation and avoiding changes unless requested.",
          "info",
        );
        return;
      }

      if (studyEnabled) {
        studyEnabled = false;
        persistStudyState();
      }
      setStudyStatus(ctx);
      ctx.ui.notify("Study Mode disabled.", "info");
    },
  });

  // ─── /wb:show-system-prompt command — prompt diagnostics ────────────

  pi.registerCommand("wb:show-system-prompt", {
    description: "Preview current system prompt, including active Workbench guidance",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("System prompt preview requires an interactive Pi UI", "warning");
        return;
      }

      try {
        const prompt = await buildSystemPromptPreview(ctx);
        await ctx.ui.editor("System prompt preview (edits discarded)", prompt);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not render system prompt preview: ${message}`, "error");
      }
    },
  });

  // ─── /wb:headroom-memory command — project Memory lifecycle ────────

  pi.registerCommand("wb:headroom-memory", {
    getArgumentCompletions: completions(MEMORY_COMPLETIONS),
    description: "Manage project Memory. Usage: /wb:headroom-memory [on|off|status|show|export|import --confirm-replace|merge]",
    handler: async (args, ctx) => {
      const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const action = tokens[0] ?? "status";

      if (!["on", "off", "status", "show", "export", "import", "merge"].includes(action)) {
        ctx.ui.notify("Usage: /wb:headroom-memory [on|off|status|show|export|import --confirm-replace|merge]", "error");
        return;
      }
      const manager = managerFor(ctx);
      if (!manager) return;
      if (manager.recoveryPending) { ctx.ui.notify("Incomplete Memory publication; preserve backup/staging and follow manual recovery instructions.", "error"); return; }

      if (action === "on") {
        if (tokens.length > 1) {
          ctx.ui.notify("Usage: /wb:headroom-memory on", "error");
          return;
        }
        const enabledMemory = await startMemory(ctx, true);
        if (enabledMemory) {
          const warning = await configureMemoryGit(manager.store.projectPath, manager.store.exportDirectory);
          if (warning) ctx.ui.notify(warning, "warning");
          ctx.ui.notify(enabledMessage(TOOL_NAMES.memory), "info");
        }
        return;
      }

      if (["show", "export", "import", "merge"].includes(action)) {
        const confirmReplace = tokens.length === 2 && tokens[1] === "--confirm-replace";
        if ((action === "import" && tokens.length > 1 && !confirmReplace) || (action !== "import" && tokens.length > 1)) {
          ctx.ui.notify(action === "import"
            ? "Usage: /wb:headroom-memory import [--confirm-replace]"
            : `Usage: /wb:headroom-memory ${action}`, "error");
          return;
        }
        if (!manager.enabled) {
          ctx.ui.notify("Headroom Memory is disabled for this project. Run /wb:headroom-memory on first.", "warning");
          return;
        }
        if (action === "import" && !confirmReplace) {
          if (!ctx.hasUI) {
            ctx.ui.notify("Import replaces configured namespace. Run /wb:headroom-memory import --confirm-replace.", "warning");
            return;
          }
          const confirmed = await ctx.ui.confirm(
            "Replace Headroom Memory namespace?",
            `Import replaces all ${manager.store.userId} Memory records from ${manager.store.exportDirectory}. Local memories that were never exported are lost.`,
          );
          if (!confirmed) {
            ctx.ui.notify("Headroom Memory import cancelled", "info");
            return;
          }
        }
        try {
          const result = await withMemoryStore(ctx, manager, async (python) => {
            if (action === "show") return manager.showBundle(python);
            if (action === "export") return manager.exportBundle(python);
            if (action === "merge") return manager.mergeBundle(python);
            return manager.importBundle(python);
          });
          if (result !== null) ctx.ui.notify(`Headroom Memory ${action}: ${action === "show" ? truncateForDisplay(result) : result}`, "info");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Headroom Memory ${action} failed: ${message}`, "error");
        }
        return;
      }

      if (action === "off") {
        const confirmDelete = tokens.length === 2 && tokens[1] === "--confirm-delete";
        if (tokens.length > 1 && !confirmDelete) {
          ctx.ui.notify("Usage: /wb:headroom-memory off [--confirm-delete]", "error");
          return;
        }
        if (!manager.enabled) {
          setMemoryStatus(ctx, "off");
          ctx.ui.notify(offMessage(TOOL_NAMES.memory, "already-off"), "info");
          return;
        }

        let confirmed = confirmDelete;
        if (!confirmed) {
          if (!ctx.hasUI) {
            ctx.ui.notify(
              "Headroom Memory deletion needs confirmation. Run /wb:headroom-memory off --confirm-delete.",
              "warning",
            );
            return;
          }
          confirmed = await ctx.ui.confirm(
            "Delete Headroom Memory?",
            `Delete all persistent Headroom Memory for project ${manager.store.identifier}? This cannot be undone.`,
          );
        }
        if (!confirmed) {
          ctx.ui.notify("Headroom Memory deletion cancelled", "info");
          return;
        }

        try {
          if (memoryRegistered) pi.unregisterMcpServer(MEMORY_SERVER_NAME);
          memoryRegistered = false;
          await manager.deleteStore();
          setMemoryStatus(ctx, "off");
          ctx.ui.notify(offMessage(TOOL_NAMES.memory, "deleted"), "info");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Could not delete Headroom Memory: ${message}`, "error");
        }
        return;
      }

      ctx.ui.notify(formatStatus(TOOL_NAMES.memory, {
        state: manager.enabled ? "on" : "off",
        projectPath: manager.store.projectPath,
        identifier: manager.store.identifier,
        data: existsSync(manager.store.directory) ? manager.store.directory : null,
        link: memoryRegistered ? "registered" : memoryConflict ? `not registered (${memoryConflict})` : manager.enabled ? "not connected" : "not registered",
        details: ["Backend: ONNX Runtime CPU"],
      }).join("\n"), "info");
    },
  });

  // ─── /wb:code-graph command — standalone codebase-memory-mcp ────────

  pi.registerCommand("wb:code-graph", {
    getArgumentCompletions: completions(CODE_GRAPH_COMPLETIONS),
    description:
      "Manage the extension-owned code graph (codebase-memory-mcp). Usage: /wb:code-graph [on|off|reindex|status]",
    handler: async (args, ctx) => {
      const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const action = tokens[0] ?? "status";
      if (!["on", "off", "reindex", "status"].includes(action)) {
        ctx.ui.notify("Usage: /wb:code-graph [on|off|reindex|status]", "error");
        return;
      }
      const manager = codeGraphManagerFor(ctx);
      const project = codeGraphProjectFor(ctx);
      const platform = detectCodeGraphPlatform(codeGraphPlatform());

      if (action === "reindex") {
        if (tokens.length > 1) {
          ctx.ui.notify("Usage: /wb:code-graph reindex", "error");
          return;
        }
        codeGraphActivationQuiet = true;
        try {
          const result = await manager.reindex(project);
          codeGraphGuidanceActive = result.ok && manager.isMcpRegistered;
          if (result.ok) {
            codeGraphStatusOn(ctx);
            ctx.ui.notify(`Code graph reindexed for ${project.identifier}`, "info");
          } else {
            ctx.ui.notify(`Code graph reindex failed (${result.kind}): ${result.detail}`, "error");
          }
        } catch (error) {
          codeGraphGuidanceActive = false; codeGraphStatusOff(ctx);
          ctx.ui.notify(`Code graph reindex failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        } finally {
          codeGraphActivationQuiet = false;
        }
        return;
      }

      if (action === "on") {
        if (tokens.length > 1) {
          ctx.ui.notify("Usage: /wb:code-graph on", "error");
          return;
        }
        if (!platform) {
          ctx.ui.notify(
            unsupportedPlatformMessage(process.platform, process.arch),
            "warning",
          );
          return;
        }
        const pathValidation = validateManagedProjectPath(project, paths);
        if (!pathValidation.ok) {
          ctx.ui.notify(`Code graph managed-path containment failure: ${pathValidation.detail}`, "error");
          return;
        }
        const validation = await validateCodeGraphState(project);
        if (!validation.ok && validation.problem !== "missing") {
          ctx.ui.notify(
            `Code graph state is invalid (${validation.problem}): ${validation.detail} Run /wb:code-graph off to clear it, then /wb:code-graph on.`,
            "error",
          );
          return;
        }
        codeGraphActivationQuiet = false;
        const preparing = `Preparing Code Graph ${getAsset(platform).asset.version} for this project...`;
        ctx.ui.setStatus(CODE_GRAPH_STATUS_KEY, colorText(ctx, "dim", `⏳ ${preparing}`));
        ctx.ui.notify(`${preparing} Downloading and indexing may take a while; please wait.`, "info");
        try {
          const result = await manager.activate(project);
          if (result.ok) {
            codeGraphGuidanceActive = true;
            codeGraphStatusOn(ctx);
            ctx.ui.notify(enabledMessage(TOOL_NAMES.codeGraph), "info");
          } else {
            codeGraphGuidanceActive = false; codeGraphStatusOff(ctx);
            ctx.ui.notify(`Code graph activation failed (${result.kind}): ${result.detail}`, "error");
          }
        } catch (error) {
          codeGraphGuidanceActive = false; codeGraphStatusOff(ctx);
          ctx.ui.notify(`Code graph activation failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        } finally {
          codeGraphActivationQuiet = false;
        }
        return;
      }

      if (action === "off") {
        const confirmDelete = tokens.length === 2 && tokens[1] === "--confirm-delete";
        if (tokens.length > 1 && !confirmDelete) {
          ctx.ui.notify("Usage: /wb:code-graph off [--confirm-delete]", "error");
          return;
        }
        const pathValidation = validateManagedProjectPath(project, paths);
        if (!pathValidation.ok) {
          ctx.ui.notify(`Code graph deletion refused: ${pathValidation.detail}`, "error");
          return;
        }
        let directoryExists = false;
        try {
          directoryExists = existsSync(project.directory);
        } catch {
          directoryExists = false;
        }
        if (!directoryExists) {
          ctx.ui.notify(offMessage(TOOL_NAMES.codeGraph, "already-off"), "info");
          return;
        }
        const validation = await validateCodeGraphState(project);
        let confirmed = confirmDelete;
        if (!confirmed) {
          if (!ctx.hasUI) {
            ctx.ui.notify(
              "Code graph deletion needs confirmation. Run /wb:code-graph off --confirm-delete.",
              "warning",
            );
            return;
          }
          confirmed = await ctx.ui.confirm(
            "Delete code graph data?",
            [
              "Permanently delete all codebase-memory-mcp data for this workspace:",
              `  Target:   ${project.directory}`,
              `  Includes: opt-in.json, workbench-identity.json, _config.db, and every index database for ${project.identifier}`,
              `  Retained: shared binary (${paths.codeGraphBin}), downloads, other workspaces, Headroom Memory`,
              ...(validation.ok ? [] : [`  Note: current state is invalid (${validation.problem}); deletion is the recovery path.`]),
            ].join("\n"),
          );
        }
        if (!confirmed) {
          ctx.ui.notify("Code graph deletion cancelled", "info");
          return;
        }
        // Off transaction order: (1) stop owned MCP first, (2) delete the
        // matching project directory only, (3) verify the deletion.
        try {
          await manager.stop(project);
        } catch (error) {
          ctx.ui.notify(
            `Could not stop the owned code graph MCP server: ${error instanceof Error ? error.message : String(error)}. Data was not deleted.`,
            "error",
          );
          return;
        }
        codeGraphGuidanceActive = false; codeGraphStatusOff(ctx);
        const preDeletePathValidation = validateManagedProjectPath(project, paths);
        if (!preDeletePathValidation.ok) {
          ctx.ui.notify(`Code graph deletion refused: ${preDeletePathValidation.detail}`, "error");
          return;
        }
        try {
          await manager.removeProject(project);
        } catch (error) {
          ctx.ui.notify(
            `Code graph deletion failed: ${error instanceof Error ? error.message : String(error)}. Data still present at ${project.directory}; retry /wb:code-graph off --confirm-delete.`,
            "error",
          );
          return;
        }
        let stillExists = false;
        try {
          stillExists = existsSync(project.directory);
        } catch {
          stillExists = false;
        }
        if (stillExists) {
          ctx.ui.notify(
            `Code graph deletion incomplete: ${project.directory} still exists.`,
            "error",
          );
          return;
        }
        codeGraphGuidanceActive = false;
        codeGraphStatusOff(ctx);
        ctx.ui.notify(offMessage(TOOL_NAMES.codeGraph, "deleted"), "info");
        return;
      }

      // status
      const manifest = platform ? getAsset(platform).asset : undefined;
      const installed = platform ? await codeGraphInstaller.inspectInstalled().catch(() => null) : null;
      const statusPathValidation = validateManagedProjectPath(project, paths);
      const stateValidation = statusPathValidation.ok ? await validateCodeGraphState(project) : null;
      const binaryCompatible = stateValidation?.ok && installed
        ? installed.version === stateValidation.identity.codeGraphVersion
          && installed.resolvedUrl === stateValidation.identity.resolvedUrl
          && installed.sha256 === stateValidation.identity.sha256
        : undefined;
      const report = await manager.buildStatusReport({
        project,
        platform: platform ?? unsupportedPlatformMessage(process.platform, process.arch),
        manifestVersion: manifest?.version,
        installedVersion: installed?.version,
        binaryCompatible,
      });
      // Status is filesystem-only unless the workspace has valid enabled,
      // state-compatible binary identity. Off/corrupt/upgrading workspaces
      // must never start CBM.
      if (installed && platform && report.kind === "enabled" && binaryCompatible === true) {
        const binaryPath = installed.path;
        report.indexSummary = (await manager.fetchIndexSummary(project, binaryPath)) ?? undefined;
      }
      ctx.ui.notify(formatCodeGraphStatus(report).join("\n"), "info");
    },
  });
}
