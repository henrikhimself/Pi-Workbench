/**
 * pi-workbench — Transparent LLM context compression for Pi using Headroom.
 *
 * Hooks into Pi's `context` event to compress messages before every LLM call.
 * Restores explicit project compression opt-in and manages its Headroom proxy.
 *
 * Configure proxy and Memory through ~/.pi/pi-workbench/headroom.json.
 */

import type {
  BuildSystemPromptOptions,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { compress } from "headroom-ai";
import { createOwnedHeadroomClient } from "./headroom-client.js";
import { Text } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { CompressResult } from "headroom-ai";
import { piToOpenAI, openAIToPiWithOutcome } from "./format-bridge.js";
import { getHeadroomAiVersion, getManagedHeadroomVersion, ProxyManager } from "./proxy-manager.js";
import { ManagedHeadroomRuntime } from "./headroom-runtime.js";
import { DEFAULT_HEADROOM_PORT } from "./config.js";
import {
  ensureHeadroomConfigFile,
  loadHeadroomConfigSync,
  type HeadroomConfig,
} from "./headroom-config.js";
import { WORKBENCH_PATHS, type WorkbenchPaths } from "./paths.js";
import { MemoryManager, MEMORY_SERVER_NAME } from "./memory-manager.js";
import { compressionOptedIn, resolveCompressionProject, setCompressionOptIn } from "./headroom-project.js";
import { assertNoSymlink } from "./managed-lifecycle.js";
import {
  CODE_GRAPH_GUIDANCE_MESSAGE,
  CodeGraphManager,
} from "./code-graph-manager.js";
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
import { applyMemoryGuidance, resolveMemoryGuidanceMode } from "./memory-guidance.js";
import { createPlaywrightIntegration, PLAYWRIGHT_PROMPT_SECTION } from "./playwright-integration.js";
import {
  STUDY_ENTRY_TYPE,
  STUDY_GUIDANCE,
  STUDY_PROMPT_SECTION,
  STUDY_STATUS_KEY,
  restoreStudyModeState,
} from "./study-mode.js";

const CODE_GRAPH_PROMPT_SECTION = "pi-workbench-code-graph";

export default function piWorkbenchExtension(
  pi: ExtensionAPI,
  options?: { headroomConfigPath?: string; workbenchPaths?: WorkbenchPaths; codeGraphPlatform?: () => { os: string; arch: string }; headroomRuntime?: ManagedHeadroomRuntime; proxyManager?: ProxyManager },
) {
  // Test seam: production always uses the canonical WORKBENCH_PATHS.
  const paths = options?.workbenchPaths ?? WORKBENCH_PATHS;
  let lifecycleGeneration = 0;
  let sessionClosed = false;
  let sessionAbort = new AbortController();
  const playwright = createPlaywrightIntegration(pi, { paths, signal: () => sessionAbort.signal });
  const startupJobs = new Set<Promise<unknown>>();
  const currentGeneration = (generation: number) => !sessionClosed && generation === lifecycleGeneration;
  function background(job: Promise<unknown>, ctx: ExtensionContext, label: string, generation = lifecycleGeneration): void {
    const tracked = job.catch((error) => {
      if (currentGeneration(generation)) ctx.ui.notify(`${label}: ${String(error)}`, "warning");
    }).catch(() => {});
    startupJobs.add(tracked); void tracked.finally(() => startupJobs.delete(tracked));
  }
  // ─── State ──────────────────────────────────────────────────────────

  let enabled = false;
  let compressionGeneration = 0;
  let compressionPreferenceWork: Promise<void> = Promise.resolve();
  let proxyAvailable: boolean | null = null;
  let proxyWarningShown = false;
  let compressionWarningShown = false;
  let restartAttempted = false;
  let proxyWatchdog: ReturnType<typeof setInterval> | null = null;
  let proxyWatchdogGeneration = 0;

  let lastStats: {
    tokensBefore: number;
    tokensAfter: number;
    tokensSaved: number;
    ratio: number;
    transforms: string[];
  } = { tokensBefore: 0, tokensAfter: 0, tokensSaved: 0, ratio: 1.0, transforms: [] };

  let sessionTotals = { calls: 0, tokensSaved: 0 };
  let memoryRegistered = false;
  let memoryRegistrationDirectory: string | null = null;
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
  const proxyManager = !portConfigError ? (options?.proxyManager ?? new ProxyManager({ port, runtime: headroomRuntime })) : null;
  const baseUrl = `http://127.0.0.1:${port}`;
  // Keep SDK fallback disabled so proxy failures reach the context handler,
  // which marks the proxy offline, attempts managed recovery, and fails open.
  const client = createOwnedHeadroomClient(proxyManager);

  async function checkActiveProxy(): Promise<{ ok: boolean }> {
    return { ok: !!proxyManager?.isManaged && await proxyManager.healthCheck() };
  }

  function stopProxyWatchdog(): void {
    proxyWatchdogGeneration += 1;
    if (proxyWatchdog) clearInterval(proxyWatchdog);
    proxyWatchdog = null;
  }

  function startProxyWatchdog(ctx: ExtensionContext): void {
    stopProxyWatchdog();
    if (!proxyManager) return;
    const generation = proxyWatchdogGeneration;
    proxyWatchdog = setInterval(() => {
      void (async () => {
        // Only extension-owned children qualify. External proxies are never probed,
        // restarted, stopped, or otherwise modified by this watchdog.
        if (!proxyManager.isManaged || await proxyManager.healthCheck()) return;
        // A shutdown, disable, or replacement session may have occurred while
        // healthCheck awaited. Never restart after this watchdog was cancelled.
        if (generation !== proxyWatchdogGeneration || !enabled) return;
        proxyAvailable = false;
        ctx.ui.setStatus("headroom-proxy", colorText(ctx, "dim", "⏳ Headroom restarting..."));
        const recovered = await proxyManager.tryRestart((msg) => {
          if (generation === proxyWatchdogGeneration) ctx.ui.setStatus("headroom-proxy", colorText(ctx, "dim", `⏳ ${msg}`));
        });
        if (generation !== proxyWatchdogGeneration || !enabled) return;
        if (recovered) {
          proxyAvailable = true;
          proxyWarningShown = false;
          ctx.ui.setStatus(
            "headroom-proxy",
            colorText(ctx, "success", "✓") + colorText(ctx, "dim", " Headroom"),
          );
        } else {
          proxyAvailable = false;
          ctx.ui.setStatus(
            "headroom-proxy",
            colorText(ctx, "warning", "⚠") + colorText(ctx, "dim", " Headroom offline"),
          );
        }
      })().catch(() => {});
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

  async function buildSystemPromptPreview(ctx: ExtensionCommandContext): Promise<string> {
    // Pi exposes options publicly but not its renderer. Resolve renderer beside
    // Pi's public entry so preview matches installed Pi runtime exactly.
    const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
    const renderer = (await import(new URL("./core/system-prompt.js", piEntry).href)) as {
      buildSystemPrompt: (options: BuildSystemPromptOptions) => string;
    };
    await playwright.refresh(ctx);
    const options = ctx.getSystemPromptOptions();
    const sections = { ...options.sections };
    if (studyEnabled) {
      sections[STUDY_PROMPT_SECTION] = STUDY_GUIDANCE;
    } else {
      delete sections[STUDY_PROMPT_SECTION];
    }
    applyMemoryGuidance(sections, memoryGuidanceMode());
    const graphGuidance = activeCodeGraphGuidance();
    if (graphGuidance) sections[CODE_GRAPH_PROMPT_SECTION] = graphGuidance;
    else delete sections[CODE_GRAPH_PROMPT_SECTION];
    const playwrightGuidance = playwright.guidance(ctx);
    if (playwrightGuidance) sections[PLAYWRIGHT_PROMPT_SECTION] = playwrightGuidance;
    else delete sections[PLAYWRIGHT_PROMPT_SECTION];
    return renderer.buildSystemPrompt({ ...options, sections });
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
    let succeeded = false;
    try {
      const python = await manager.ensureRuntime((message) => {
        ctx.ui.setStatus("headroom-memory", colorText(ctx, "dim", `⏳ ${message}`));
      });
      if (!python) {
        ctx.ui.notify("Headroom Memory runtime unavailable", "error");
        return null;
      }
      const result = await action(python); succeeded = true; return result;
    } finally {
      if (restoreRegistration && succeeded && currentGeneration(generation)) await startMemory(ctx, false);
      else if (restoreRegistration && currentGeneration(generation)) setMemoryStatus(ctx, "offline");
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
    enabled = true; proxyAvailable = false;
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
    const previousCompression = enabled;
    enabled = false; proxyAvailable = false;
    if (previousCompression && proxyManager) background(proxyManager.stop(), ctx, "Previous managed proxy stop", generation);
    const previousGraph = codeGraphManager; codeGraphManager = null;
    if (previousGraph) background(previousGraph.shutdown(), ctx, "Previous graph shutdown", generation);
    if (memoryRegistered) pi.unregisterMcpServer(MEMORY_SERVER_NAME);
    memoryRegistered = false; memoryRegistrationDirectory = null;
    restoreStudyState(ctx); codeGraphGuidanceActive = false;
    proxyWarningShown = false; compressionWarningShown = false; restartAttempted = false;
    memoryRootWarningShown = false; sessionTotals = { calls: 0, tokensSaved: 0 };
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

  pi.on("session_shutdown", async () => {
    sessionClosed = true; lifecycleGeneration++; sessionAbort.abort(); stopProxyWatchdog();
    codeGraphGuidanceActive = false;
    if (memoryRegistered) {
      try { pi.unregisterMcpServer(MEMORY_SERVER_NAME); } catch { /* Continue independent cleanup. */ }
    }
    memoryRegistered = false; memoryRegistrationDirectory = null;
    const graph = codeGraphManager; codeGraphManager = null;
    await Promise.allSettled([graph?.shutdown(), proxyManager?.stop(), playwright.shutdown()]);
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
    if (!active() || proxyAvailable === false) return;

    // Never send context without a current managed consumer lease and attested health.
    const health = portConfigError ? { ok: false } : await checkActiveProxy();
    if (!active()) return;
    if (!health.ok) {
      proxyAvailable = false;
      ctx.ui.notify(`Headroom proxy unavailable: ${portConfigError ?? "managed ownership/health could not be verified"}`, "warning");
      ctx.ui.setStatus("headroom-proxy", colorText(ctx, "warning", "⚠ Headroom offline"));
      return;
    }
    proxyAvailable = true;

    // Convert AgentMessage[] → Pi-AI Message[] → OpenAI format
    const piMessages = convertToLlm(event.messages);
    if (piMessages.length === 0) return;

    const openaiMessages = piToOpenAI(piMessages);
    if (openaiMessages.length === 0) return;

    try {
      const result: CompressResult = await compress(openaiMessages, {
        client,
        model: ctx.model?.id ?? "gpt-4o",
        ...(headroomConfig.compression ? { config: headroomConfig.compression } : {}),
      });

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

      // Convert compressed OpenAI → Pi-AI Message[]. Image-count safety fallback
      // retains original context, so reported proxy savings were not applied.
      const conversion = openAIToPiWithOutcome(result.messages, piMessages);
      if (!conversion.applied) {
        ctx.ui.setStatus(
          "headroom-proxy",
          colorText(ctx, "warning", "⚠") +
            colorText(ctx, "dim", " Headroom safety fallback (images retained)"),
        );
        return;
      }
      const compressedPiMessages = conversion.messages;

      // Update stats
      lastStats = {
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        tokensSaved: result.tokensSaved,
        ratio: result.compressionRatio,
        transforms: result.transformsApplied,
      };
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
      const errMsg = error instanceof Error ? error.message : String(error);
      const health = await checkActiveProxy();
      if (!active()) return;

      if (health.ok) {
        proxyAvailable = true;
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

      if (!proxyWarningShown) {
        proxyWarningShown = true;
        proxyAvailable = false;
        const diagnostic = "Headroom proxy unavailable";
        ctx.ui.notify(`${diagnostic}: ${errMsg}`, "warning");
        ctx.ui.setStatus(
          "headroom-proxy",
          colorText(ctx, "warning", "⚠") + colorText(ctx, "dim", " Headroom offline"),
        );
      }

      // Mid-session crash recovery (one attempt per session)
      if (proxyManager && !restartAttempted) {
        restartAttempted = true;
        const recovered = await proxyManager.tryRestart((msg) => {
          if (active()) ctx.ui.setStatus("headroom-proxy", colorText(ctx, "dim", `⏳ ${msg}`));
        });
        if (!active()) return;
        if (recovered) {
          proxyAvailable = true;
          proxyWarningShown = false;
          ctx.ui.setStatus(
            "headroom-proxy",
            colorText(ctx, "success", "✓") + colorText(ctx, "dim", " Headroom"),
          );
          // Don't retry compression this call — next context event will use it
        }
      }

      return;
    }
  });

  // ─── /wb:headroom-proxy command — toggle and status ────────────────

  pi.registerCommand("wb:headroom-proxy", {
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
        const update = compressionPreferenceWork.then(async () => {
          if (!compressionCurrent(generation, epoch)) return false;
          await setCompressionOptIn(resolveCompressionProject(ctx.cwd ?? process.cwd(), paths), action === "on", signal);
          return true;
        });
        compressionPreferenceWork = update.then(() => {}, () => {});
        try {
          if (!await update || !compressionCurrent(generation, epoch)) return;
          if (action === "off") {
            ctx.ui.notify("Headroom compression disabled for this project and session; Memory and active peers are unchanged", "info");
            return;
          }
          proxyWarningShown = false; compressionWarningShown = false; restartAttempted = false;
          const ok = await activateCompression(ctx, generation, epoch);
          if (!compressionCurrent(generation, epoch)) return;
          ctx.ui.notify(ok ? "Headroom compression enabled for this project" : "Managed Headroom unavailable; project opt-in retained and context remains usable",
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
      let projectStartup: string;
      try { projectStartup = await compressionOptedIn(resolveCompressionProject(ctx.cwd ?? process.cwd(), paths)) ? "on" : "off"; }
      catch (error) { projectStartup = `unavailable (${String(error)})`; }
      const healthy = (await checkActiveProxy()).ok;
      const expected = await getHeadroomAiVersion();
      ctx.ui.notify([
        `Headroom compression: ${enabled ? "on" : "off"} (this session)`,
        `Project startup: ${projectStartup}`,
        "On/off persists for this project. Active peers keep their current session state.",
        "Mode: extension-managed only", `URL: ${baseUrl}`,
        `Version: ${healthy ? expected : "unavailable"} (managed /health)`, `Expected: ${expected} (extension)`,
        `Config: ${compressionStatus()}`, `Compressed calls: ${sessionTotals.calls}`,
        `Tokens saved: ${sessionTotals.tokensSaved.toLocaleString()}`,
        ...(portConfigError ? [`Configuration error: ${portConfigError}`] : []),
      ].join("\n"), "info");
    },
  });

  // ─── /wb:study-mode command — tutor-only lifecycle ───────────────

  pi.registerCommand("wb:study-mode", {
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
          ctx.ui.notify("Headroom Memory enabled for this project", "info");
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
            `Import replaces all ${manager.store.userId} Memory records from ${manager.store.exportDirectory}. A retained backup will be created.`,
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
            const imported = await manager.importBundle(python);
            return `${imported.result}\nbackup: ${imported.backupDirectory}`;
          });
          if (result !== null) ctx.ui.notify(`Headroom Memory ${action}: ${result}`, "info");
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
          ctx.ui.notify("Headroom Memory is already disabled for this project", "info");
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
          ctx.ui.notify("Headroom Memory deleted for this project", "info");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Could not delete Headroom Memory: ${message}`, "error");
        }
        return;
      }

      const lines = [
        "Headroom Memory",
        `  Enabled: ${manager.enabled ? "yes" : "no"}`,
        `  MCP:     ${memoryRegistered ? "registered" : manager.enabled ? "not connected" : "not registered"}`,
        "  Backend: ONNX Runtime CPU",
        `  Store:   ${manager.store.identifier}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ─── /wb:code-graph command — standalone codebase-memory-mcp ────────

  pi.registerCommand("wb:code-graph", {
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
        const validation = validateCodeGraphState(project);
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
            ctx.ui.notify(`Code graph enabled for ${project.identifier}`, "info");
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
          ctx.ui.notify("Code graph is already off for this workspace", "info");
          return;
        }
        const validation = validateCodeGraphState(project);
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
              `  Includes: state.json, _config.db, and every index database for ${project.identifier}`,
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
        // Brief grace period so the owned child can exit before unlink.
        await new Promise((resolve) => setTimeout(resolve, 500));
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
        ctx.ui.notify(`Code graph deleted for ${project.identifier}`, "info");
        return;
      }

      // status
      const manifest = platform ? getAsset(platform).asset : undefined;
      const installed = platform ? await codeGraphInstaller.inspectInstalled().catch(() => null) : null;
      const statusPathValidation = validateManagedProjectPath(project, paths);
      const stateValidation = statusPathValidation.ok ? validateCodeGraphState(project) : null;
      const binaryCompatible = stateValidation?.ok && installed
        ? installed.version === stateValidation.state.version
          && installed.resolvedUrl === stateValidation.state.resolvedUrl
          && installed.sha256 === stateValidation.state.sha256
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

  // ─── /wb:headroom-health command — proxy diagnostics ────────────────

  pi.registerCommand("wb:headroom-health", {
    description: "Check owned Headroom health and managed runtime diagnostics",
    handler: async (_args, ctx) => {
      const healthy = !portConfigError && (await checkActiveProxy()).ok;
      const expected = await getHeadroomAiVersion();
      const installed = await getManagedHeadroomVersion(headroomRuntime).catch(() => null);
      ctx.ui.notify([
        `Headroom proxy: ${healthy ? "online (managed)" : "offline"}`, `URL: ${baseUrl}`,
        `Expected: ${expected} (extension)`, `Runtime: ${installed ?? "not prepared"}`,
        ...(portConfigError ? [`Configuration error: ${portConfigError}`] : []),
        ...(!healthy ? ["No external proxy is adopted. Check managed diagnostics or retry /wb:headroom-proxy on."] : []),
      ].join("\n"), healthy ? "info" : "warning");
      ctx.ui.setStatus("headroom-proxy", colorText(ctx, healthy ? "success" : "warning", healthy ? "✓ Headroom" : "⚠ Headroom offline"));
    },
  });
}
