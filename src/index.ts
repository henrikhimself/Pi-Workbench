/**
 * pi-workbench — Transparent LLM context compression for Pi using Headroom.
 *
 * Hooks into Pi's `context` event to compress messages before every LLM call.
 * Automatically installs and manages the Headroom proxy (zero-config).
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
import { HeadroomClient, compress } from "headroom-ai";
import { Text } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { CompressResult } from "headroom-ai";
import { piToOpenAI, openAIToPiWithOutcome } from "./format-bridge.js";
import { getHeadroomAiVersion, getManagedHeadroomVersion, ProxyManager } from "./proxy-manager.js";
import {
  checkHeadroomVersion,
  describeHeadroomVersionCheck,
  type HeadroomVersionCheck,
} from "./headroom-health.js";
import { DEFAULT_HEADROOM_PORT } from "./config.js";
import {
  ensureHeadroomConfigFile,
  loadHeadroomConfigSync,
  type HeadroomConfig,
} from "./headroom-config.js";
import { WORKBENCH_PATHS, type WorkbenchPaths } from "./paths.js";
import { MemoryManager, MEMORY_SERVER_NAME } from "./memory-manager.js";
import {
  CODE_GRAPH_GUIDANCE_MESSAGE,
  CodeGraphManager,
} from "./code-graph-manager.js";
import {
  CodeGraphInstaller,
  detectCodeGraphPlatform,
  discoverInstalled,
  installedBinaryPath,
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
import {
  STUDY_ENTRY_TYPE,
  STUDY_GUIDANCE,
  STUDY_PROMPT_SECTION,
  STUDY_STATUS_KEY,
  restoreStudyModeState,
} from "./study-mode.js";
import {
  PRECEPTOR_ENTRY_TYPE,
  PRECEPTOR_GUIDANCE,
  PRECEPTOR_PROMPT_SECTION,
  PRECEPTOR_STATUS_KEY,
  restorePreceptorEnabled,
} from "./preceptor-mode.js";

const CODE_GRAPH_PROMPT_SECTION = "pi-workbench-code-graph";

export default function piWorkbenchExtension(
  pi: ExtensionAPI,
  options?: { headroomConfigPath?: string; workbenchPaths?: WorkbenchPaths },
) {
  // Test seam: production always uses the canonical WORKBENCH_PATHS.
  const paths = options?.workbenchPaths ?? WORKBENCH_PATHS;
  // ─── State ──────────────────────────────────────────────────────────

  let enabled = true;
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
  let memoryRootWarningShown = false;
  let codeGraphManager: CodeGraphManager | null = null;
  let codeGraphActivationQuiet = false;
  let codeGraphGuidanceActive = false;

  // Standalone codebase-memory-mcp lifecycle. Independent from the
  // Headroom proxy and Memory; never modifies external services.
  const codeGraphInstaller = new CodeGraphInstaller({ paths });
  const CODE_GRAPH_STATUS_KEY = "code-graph";
  let preceptorEnabled = false;
  let studyEnabled = false;
  let legacyPathWarningShown = false;

  // ─── Configuration ──────────────────────────────────────────────────

  const headroomConfigPath = options?.headroomConfigPath ?? WORKBENCH_PATHS.headroomConfig;
  let headroomConfig: HeadroomConfig = {};
  let port = DEFAULT_HEADROOM_PORT;
  let portConfigError: string | null = null;
  try {
    headroomConfig = loadHeadroomConfigSync(headroomConfigPath);
    port = headroomConfig.port ?? DEFAULT_HEADROOM_PORT;
  } catch (error) {
    portConfigError = error instanceof Error ? error.message : String(error);
  }
  const userUrl = headroomConfig.url;
  const autoManage = !userUrl;
  const proxyManager = autoManage && !portConfigError ? new ProxyManager({ port }) : null;
  const baseUrl = userUrl || `http://127.0.0.1:${port}`;
  // Keep SDK fallback disabled so proxy failures reach the context handler,
  // which marks the proxy offline, attempts managed recovery, and fails open.
  const client = new HeadroomClient({ baseUrl, fallback: false, timeout: 15_000 });

  /** Validate external proxy version before sending it Pi context. */
  async function checkExternalProxyVersion(): Promise<HeadroomVersionCheck> {
    return checkHeadroomVersion(baseUrl, await getHeadroomAiVersion(), 5_000);
  }

  async function checkActiveProxy(): Promise<HeadroomVersionCheck | { ok: boolean }> {
    if (proxyManager?.isManaged) return { ok: await proxyManager.healthCheck() };
    return checkExternalProxyVersion();
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
        ctx.ui.setStatus("headroom-proxy", ctx.ui.theme.fg("dim", "⏳ Headroom restarting..."));
        const recovered = await proxyManager.tryRestart((msg) => {
          ctx.ui.setStatus("headroom-proxy", ctx.ui.theme.fg("dim", `⏳ ${msg}`));
        });
        if (recovered) {
          proxyAvailable = true;
          proxyWarningShown = false;
          ctx.ui.setStatus(
            "headroom-proxy",
            ctx.ui.theme.fg("success", "✓") + ctx.ui.theme.fg("dim", " Headroom"),
          );
        } else {
          proxyAvailable = false;
          ctx.ui.setStatus(
            "headroom-proxy",
            ctx.ui.theme.fg("warning", "⚠") + ctx.ui.theme.fg("dim", " Headroom offline"),
          );
        }
      })().catch(() => {});
    }, 30_000);
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

  function setMemoryStatus(ctx: ExtensionContext, state: "starting" | "ready" | "offline" | "off"): void {
    const label = state === "starting"
      ? "⏳ Headroom Memory preparing..."
      : state === "ready"
        ? "✓ Headroom Memory"
        : state === "offline"
          ? "⚠ Headroom Memory offline"
          : "○ Headroom Memory off";
    const color = state === "ready" ? "success" : state === "off" ? "dim" : state === "offline" ? "warning" : "dim";
    ctx.ui.setStatus("headroom-memory", ctx.ui.theme.fg(color, label));
  }

  function setPreceptorStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(
      PRECEPTOR_STATUS_KEY,
      preceptorEnabled ? ctx.ui.theme.fg("success", "✓ Learning") : undefined,
    );
  }

  function restorePreceptorState(ctx: ExtensionContext): void {
    preceptorEnabled = restorePreceptorEnabled(ctx.sessionManager.getBranch());
    setPreceptorStatus(ctx);
  }

  function persistPreceptorState(): void {
    pi.appendEntry(PRECEPTOR_ENTRY_TYPE, { enabled: preceptorEnabled });
  }

  function setStudyStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(STUDY_STATUS_KEY, studyEnabled ? ctx.ui.theme.fg("success", "✓ Study") : undefined);
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
    const options = ctx.getSystemPromptOptions();
    const sections = { ...options.sections };
    if (preceptorEnabled) {
      sections[PRECEPTOR_PROMPT_SECTION] = PRECEPTOR_GUIDANCE;
    } else {
      delete sections[PRECEPTOR_PROMPT_SECTION];
    }
    if (studyEnabled) {
      sections[STUDY_PROMPT_SECTION] = STUDY_GUIDANCE;
    } else {
      delete sections[STUDY_PROMPT_SECTION];
    }
    applyMemoryGuidance(sections, memoryGuidanceMode());
    if (codeGraphGuidanceActive) sections[CODE_GRAPH_PROMPT_SECTION] = CODE_GRAPH_GUIDANCE_MESSAGE;
    else delete sections[CODE_GRAPH_PROMPT_SECTION];
    return renderer.buildSystemPrompt({ ...options, sections });
  }

  function managerFor(ctx: ExtensionContext): MemoryManager | null {
    try {
      const manager = new MemoryManager({
        cwd: ctx.cwd ?? process.cwd(),
        root: headroomConfig.memoryRoot,
        userId: headroomConfig.memoryNamespace,
        exportPath: headroomConfig.memory?.export,
      });
      if (manager.store.rootConfigured && manager.store.rootInsideProject && !memoryRootWarningShown) {
        memoryRootWarningShown = true;
        ctx.ui.notify(
          "headroom.json memoryRoot resolves inside this project. Memory SQLite data may enter repository tooling; Git LFS stores blobs but cannot merge database writes.",
          "warning",
        );
      }
      return manager;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Headroom Memory disabled: ${message}`, "error");
      setMemoryStatus(ctx, "offline");
      return null;
    }
  }

  // ─── Code graph (standalone codebase-memory-mcp) ──────────────────

  function codeGraphManagerFor(ctx: ExtensionContext): CodeGraphManager {
    if (!codeGraphManager) {
      codeGraphManager = new CodeGraphManager({
        paths,
        // Production path: packaged manifest only; no test-seam asset.
        ensureInstalled: (onStatus) => codeGraphInstaller.ensureInstalled(onStatus),
        onStatus: (message) => {
          if (!codeGraphActivationQuiet) {
            ctx.ui.setStatus(CODE_GRAPH_STATUS_KEY, ctx.ui.theme.fg("dim", `⏳ ${message}`));
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
      ctx.ui.theme.fg("success", "✓") + ctx.ui.theme.fg("dim", " Code Graph"),
    );
  }

  function codeGraphStatusOff(ctx: ExtensionContext): void {
    ctx.ui.setStatus(
      CODE_GRAPH_STATUS_KEY,
      ctx.ui.theme.fg("dim", "○ Code Graph off"),
    );
  }

  /**
   * Restore this workspace's code graph at session start. Independent of
   * the Headroom proxy and Memory; callers use it fire-and-forget so it
   * can never delay their startup. Fail-open: any problem leaves the
   * feature off with a diagnostic.
   */
  async function restoreCodeGraph(ctx: ExtensionContext): Promise<void> {
    try {
      const manager = codeGraphManagerFor(ctx);
      const result = await manager.restore(codeGraphProjectFor(ctx));
      if (result.ok) {
        codeGraphGuidanceActive = true;
        codeGraphStatusOn(ctx);
        return;
      }
      if (result.kind !== "off") {
        codeGraphStatusOff(ctx);
        ctx.ui.notify(`Code graph ${result.kind}: ${result.detail}`, "warning");
      }
    } catch (error) {
      codeGraphStatusOff(ctx);
      ctx.ui.notify(`Code graph restore failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  }

  /** Prepare and register project Memory. Missing store is intentionally a no-op. */
  async function startMemory(ctx: ExtensionContext, createStore: boolean): Promise<boolean> {
    const manager = managerFor(ctx);
    if (!manager) return false;

    try {
      await manager.ensureRoot();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMemoryStatus(ctx, "offline");
      ctx.ui.notify(`Headroom Memory root unavailable: ${message}`, "warning");
      return false;
    }

    if (!createStore && !manager.enabled) {
      setMemoryStatus(ctx, "off");
      return false;
    }

    setMemoryStatus(ctx, "starting");
    const python = await manager.prepare((message) => {
      ctx.ui.setStatus("headroom-memory", ctx.ui.theme.fg("dim", `⏳ ${message}`));
    });
    if (!python) {
      setMemoryStatus(ctx, "offline");
      ctx.ui.notify("Headroom Memory unavailable; context compression remains available.", "warning");
      return false;
    }

    try {
      if (createStore) await manager.createStore();
      pi.registerMcpServer(MEMORY_SERVER_NAME, manager.getMcpConfig(python));
      memoryRegistered = true;
      setMemoryStatus(ctx, "ready");
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMemoryStatus(ctx, "offline");
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
    const restoreRegistration = memoryRegistered;
    if (restoreRegistration) {
      pi.unregisterMcpServer(MEMORY_SERVER_NAME);
      memoryRegistered = false;
    }
    try {
      const python = await manager.ensureRuntime((message) => {
        ctx.ui.setStatus("headroom-memory", ctx.ui.theme.fg("dim", `⏳ ${message}`));
      });
      if (!python) {
        ctx.ui.notify("Headroom Memory runtime unavailable", "error");
        return null;
      }
      return await action(python);
    } finally {
      if (restoreRegistration) await startMemory(ctx, false);
    }
  }

  // ─── Session start: install/start proxy or health-check ─────────────

  pi.on("session_start", async (_event, ctx) => {
    try {
      const created = await ensureHeadroomConfigFile(headroomConfigPath);
      if (created) ctx.ui.notify("Created Headroom configuration at ~/.pi/pi-workbench/headroom.json.", "info");
    } catch {
      ctx.ui.notify("Headroom configuration could not be created; using loaded defaults.", "warning");
    }
    if (!legacyPathWarningShown && [
      WORKBENCH_PATHS.legacyHeadroomVenv,
      WORKBENCH_PATHS.legacyHeadroomVenvLock,
      WORKBENCH_PATHS.legacyHeadroomMemory,
    ].some((path) => existsSync(path))) {
      legacyPathWarningShown = true;
      ctx.ui.notify("Legacy ~/.pi/headroom-* paths remain untouched. pi-workbench uses ~/.pi/pi-workbench; migrate or remove legacy data manually.", "info");
    }
    restorePreceptorState(ctx);
    restoreStudyState(ctx);
    codeGraphGuidanceActive = false;
    proxyWarningShown = false;
    compressionWarningShown = false;
    restartAttempted = false;
    memoryRootWarningShown = false;
    sessionTotals = { calls: 0, tokensSaved: 0 };

    if (portConfigError) {
      enabled = false;
      proxyAvailable = false;
      ctx.ui.setStatus(
        "headroom-proxy",
        ctx.ui.theme.fg("warning", "⚠") + ctx.ui.theme.fg("dim", " Headroom offline"),
      );
      ctx.ui.notify(`Headroom compression disabled: ${portConfigError}`, "error");
    } else if (proxyManager) {
      // Auto-manage mode
      ctx.ui.setStatus("headroom-proxy", ctx.ui.theme.fg("dim", "⏳ Headroom starting..."));

      const ok = await proxyManager.ensureRunning((msg) => {
        ctx.ui.setStatus("headroom-proxy", ctx.ui.theme.fg("dim", `⏳ ${msg}`));
      });

      if (ok) {
        proxyAvailable = true;
        startProxyWatchdog(ctx);
        ctx.ui.setStatus(
          "headroom-proxy",
          ctx.ui.theme.fg("success", "✓") + ctx.ui.theme.fg("dim", " Headroom"),
        );
      } else {
        proxyAvailable = false;
        ctx.ui.setStatus(
          "headroom-proxy",
          ctx.ui.theme.fg("warning", "⚠") + ctx.ui.theme.fg("dim", " Headroom offline"),
        );
        ctx.ui.notify(
          "Headroom proxy could not be started. Context compression disabled.\nRun /wb:headroom-health for details.",
          "warning",
        );
      }
    } else {
      // User-managed mode: require exact SDK/proxy version parity.
      const health = await checkExternalProxyVersion();
      if (health.ok) {
        proxyAvailable = true;
        ctx.ui.setStatus(
          "headroom-proxy",
          ctx.ui.theme.fg("success", "✓") + ctx.ui.theme.fg("dim", " Headroom"),
        );
      } else {
        proxyAvailable = false;
        ctx.ui.notify(`${describeHeadroomVersionCheck(health)}. Context compression disabled.`, "warning");
        ctx.ui.setStatus(
          "headroom-proxy",
          ctx.ui.theme.fg("warning", "⚠") + ctx.ui.theme.fg("dim", " Headroom offline"),
        );
      }
    }

    // Existing per-project memory.db is durable opt-in. It is independent from
    // compression proxy management, including headroom.json external-proxy mode.
    await startMemory(ctx, false);

    // Code graph restore is also opt-in and independent. Never awaited:
    // it must not delay Headroom proxy or Memory startup, and any failure
    // is fail-open (feature stays off, diagnostics via /wb:code-graph status).
    void restoreCodeGraph(ctx).catch(() => {});
  });

  // ─── Session shutdown: stop proxy if we started it ──────────────────

  pi.on("session_shutdown", async () => {
    stopProxyWatchdog();
    codeGraphManager?.shutdown();
    codeGraphGuidanceActive = false;
    if (memoryRegistered) {
      pi.unregisterMcpServer(MEMORY_SERVER_NAME);
      memoryRegistered = false;
    }
    if (proxyManager) {
      await proxyManager.stop();
    }
  });

  // ─── Learning guidance before every agent turn ──────────────────────

  pi.on("before_agent_start", (event) => {
    if (preceptorEnabled) {
      event.systemPromptOptions.sections[PRECEPTOR_PROMPT_SECTION] = PRECEPTOR_GUIDANCE;
    } else {
      delete event.systemPromptOptions.sections[PRECEPTOR_PROMPT_SECTION];
    }
    if (studyEnabled) {
      event.systemPromptOptions.sections[STUDY_PROMPT_SECTION] = STUDY_GUIDANCE;
    } else {
      delete event.systemPromptOptions.sections[STUDY_PROMPT_SECTION];
    }
    applyMemoryGuidance(event.systemPromptOptions.sections, memoryGuidanceMode());
    if (codeGraphGuidanceActive) event.systemPromptOptions.sections[CODE_GRAPH_PROMPT_SECTION] = CODE_GRAPH_GUIDANCE_MESSAGE;
    else delete event.systemPromptOptions.sections[CODE_GRAPH_PROMPT_SECTION];
  });

  // ─── Core: compress context before every LLM call ───────────────────

  pi.on("context", async (event, ctx) => {
    if (!enabled || proxyAvailable === false) return;

    // Pi normally emits session_start first. Keep direct/test invocation fail-open too:
    // explicit external URLs cannot receive context until version validation succeeds.
    if (userUrl && proxyAvailable !== true) {
      const health = await checkExternalProxyVersion();
      if (!health.ok) {
        proxyAvailable = false;
        ctx.ui.notify(`Headroom proxy unavailable: ${describeHeadroomVersionCheck(health)}`, "warning");
        ctx.ui.setStatus(
          "headroom-proxy",
          ctx.ui.theme.fg("warning", "⚠") + ctx.ui.theme.fg("dim", " Headroom offline"),
        );
        return;
      }
      proxyAvailable = true;
    }

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

      compressionWarningShown = false;

      if (!result.compressed || result.tokensSaved <= 0) {
        ctx.ui.setStatus(
          "headroom-proxy",
          ctx.ui.theme.fg("success", "✓") +
            ctx.ui.theme.fg("dim", ` Headroom (${openaiMessages.length} msgs, no compression needed)`),
        );
        return;
      }

      // Convert compressed OpenAI → Pi-AI Message[]. Image-count safety fallback
      // retains original context, so reported proxy savings were not applied.
      const conversion = openAIToPiWithOutcome(result.messages, piMessages);
      if (!conversion.applied) {
        ctx.ui.setStatus(
          "headroom-proxy",
          ctx.ui.theme.fg("warning", "⚠") +
            ctx.ui.theme.fg("dim", " Headroom safety fallback (images retained)"),
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
      const theme = ctx.ui.theme;
      ctx.ui.setStatus(
        "headroom-proxy",
        theme.fg("success", "✓") + theme.fg("dim", ` Headroom -${pct}% (${saved} saved)`),
      );

      return { messages: compressedPiMessages as any };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const health = await checkActiveProxy();

      if (health.ok) {
        proxyAvailable = true;
        if (!compressionWarningShown) {
          compressionWarningShown = true;
          ctx.ui.notify(`Headroom compression request failed: ${errMsg}`, "warning");
        }
        ctx.ui.setStatus(
          "headroom-proxy",
          ctx.ui.theme.fg("warning", "⚠") + ctx.ui.theme.fg("dim", " Headroom request failed"),
        );
        return;
      }

      if (!proxyWarningShown) {
        proxyWarningShown = true;
        proxyAvailable = false;
        const diagnostic = "reason" in health ? describeHeadroomVersionCheck(health) : "Headroom proxy unavailable";
        ctx.ui.notify(`${diagnostic}: ${errMsg}`, "warning");
        ctx.ui.setStatus(
          "headroom-proxy",
          ctx.ui.theme.fg("warning", "⚠") + ctx.ui.theme.fg("dim", " Headroom offline"),
        );
      }

      // Mid-session crash recovery (one attempt per session)
      if (proxyManager && !restartAttempted) {
        restartAttempted = true;
        const recovered = await proxyManager.tryRestart((msg) => {
          ctx.ui.setStatus("headroom-proxy", ctx.ui.theme.fg("dim", `⏳ ${msg}`));
        });
        if (recovered) {
          proxyAvailable = true;
          proxyWarningShown = false;
          ctx.ui.setStatus(
            "headroom-proxy",
            ctx.ui.theme.fg("success", "✓") + ctx.ui.theme.fg("dim", " Headroom"),
          );
          // Don't retry compression this call — next context event will use it
        }
      }

      return;
    }
  });

  // ─── /wb:headroom-proxy command — toggle and status ────────────────

  pi.registerCommand("wb:headroom-proxy", {
    description: "Toggle Headroom compression or show status. Usage: /wb:headroom-proxy [on|off|status]",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      if (arg === "on") {
        if (portConfigError) {
          enabled = false;
          proxyAvailable = false;
          ctx.ui.notify(`Headroom compression cannot be enabled: ${portConfigError}`, "error");
          ctx.ui.setStatus(
            "headroom-proxy",
            ctx.ui.theme.fg("warning", "⚠") + ctx.ui.theme.fg("dim", " Headroom offline"),
          );
          return;
        }

        enabled = true;
        proxyWarningShown = false;
        compressionWarningShown = false;
        restartAttempted = false;

        if (proxyManager) {
          // Try to start the proxy
          ctx.ui.setStatus("headroom-proxy", ctx.ui.theme.fg("dim", "⏳ Starting..."));
          const ok = await proxyManager.ensureRunning((msg) => {
            ctx.ui.setStatus("headroom-proxy", ctx.ui.theme.fg("dim", `⏳ ${msg}`));
          });
          if (ok) {
            proxyAvailable = true;
            startProxyWatchdog(ctx);
            ctx.ui.notify("Headroom compression enabled", "info");
            ctx.ui.setStatus(
              "headroom-proxy",
              ctx.ui.theme.fg("success", "✓") + ctx.ui.theme.fg("dim", " Headroom"),
            );
          } else {
            proxyAvailable = false;
            ctx.ui.notify("Headroom enabled but proxy could not be started", "warning");
            ctx.ui.setStatus(
              "headroom-proxy",
              ctx.ui.theme.fg("warning", "⚠") + ctx.ui.theme.fg("dim", " Headroom offline"),
            );
          }
        } else {
          // User-managed: require exact SDK/proxy version parity.
          const health = await checkExternalProxyVersion();
          if (health.ok) {
            proxyAvailable = true;
            ctx.ui.notify("Headroom compression enabled", "info");
            ctx.ui.setStatus(
              "headroom-proxy",
              ctx.ui.theme.fg("success", "✓") + ctx.ui.theme.fg("dim", " Headroom"),
            );
          } else {
            proxyAvailable = false;
            ctx.ui.notify(`Headroom enabled but unavailable: ${describeHeadroomVersionCheck(health)}`, "warning");
            ctx.ui.setStatus(
              "headroom-proxy",
              ctx.ui.theme.fg("warning", "⚠") + ctx.ui.theme.fg("dim", " Headroom offline"),
            );
          }
        }
        return;
      }

      if (arg === "off") {
        enabled = false;
        stopProxyWatchdog();
        ctx.ui.notify("Headroom compression disabled", "info");
        ctx.ui.setStatus("headroom-proxy", ctx.ui.theme.fg("dim", "○ Headroom off"));
        return;
      }

      // Status (default)
      const managedStr = portConfigError
        ? "disabled (invalid headroom.json)"
        : proxyManager
          ? proxyManager.isManaged
            ? "auto (managed by extension)"
            : "auto (external proxy detected)"
          : "manual (headroom.json url set)";

      const usingManagedProxy = proxyManager?.isManaged === true;
      const versionCheck = usingManagedProxy ? null : await checkExternalProxyVersion();
      const headroomVersion = usingManagedProxy
        ? await getManagedHeadroomVersion() ?? "unavailable"
        : versionCheck?.reportedVersion ?? "unavailable";
      const versionSource = usingManagedProxy ? "managed Python venv" : "external /health";
      const lines = [
        `Headroom Context Compression`,
        `  Enabled: ${enabled ? "yes" : "no"}`,
        `  Proxy:   ${baseUrl} (${proxyAvailable === true ? "online" : proxyAvailable === false ? "offline" : "unknown"})`,
        `  Version: ${headroomVersion} (${versionSource})`,
        ...(versionCheck ? [`  Expected: ${versionCheck.expectedVersion ?? "unavailable"} (extension)`] : []),
        `  Mode:    ${managedStr}`,
        `  Config:  ${compressionStatus()}`,
        ``,
        `Session stats:`,
        `  Compressions: ${sessionTotals.calls}`,
        `  Tokens saved: ${sessionTotals.tokensSaved.toLocaleString()}`,
      ];

      if (versionCheck && !versionCheck.ok) lines.push(`  Health:  ${describeHeadroomVersionCheck(versionCheck)}`);

      if (lastStats.tokensBefore > 0) {
        const pct = Math.round((1 - lastStats.ratio) * 100);
        lines.push(
          ``,
          `Last compression:`,
          `  ${lastStats.tokensBefore.toLocaleString()} → ${lastStats.tokensAfter.toLocaleString()} tokens (-${pct}%)`,
          `  Transforms: ${lastStats.transforms.join(", ") || "none"}`,
        );
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ─── /wb:preceptor-mode command — Learning mode lifecycle ──────────

  pi.registerCommand("wb:preceptor-mode", {
    description: "Toggle Learning mode or show status. Usage: /wb:preceptor-mode [on|off|status]",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status";
      if (!["on", "off", "status"].includes(action)) {
        ctx.ui.notify("Usage: /wb:preceptor-mode [on|off|status]", "error");
        return;
      }

      if (action === "status") {
        ctx.ui.notify(`Learning mode: ${preceptorEnabled ? "on" : "off"} (current session branch)`, "info");
        return;
      }

      preceptorEnabled = action === "on";
      persistPreceptorState();
      setPreceptorStatus(ctx);
      if (preceptorEnabled && studyEnabled) {
        studyEnabled = false;
        persistStudyState();
        setStudyStatus(ctx);
      }
      ctx.ui.notify(
        preceptorEnabled
          ? "Learning mode enabled for this session branch; Study Mode disabled."
          : "Learning mode disabled for this session branch",
        "info",
      );
    },
  });

  // ─── /wb:study-mode command — tutor-only lifecycle ───────────────

  pi.registerCommand("wb:study-mode", {
    description: "Toggle tutor-only Study Mode. Usage: /wb:study-mode [on|off|status]",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (action !== "on" && action !== "off" && action !== "status") {
        ctx.ui.notify("Usage: /wb:study-mode [on|off|status]", "error");
        return;
      }
      if (action === "status") {
        ctx.ui.notify(studyEnabled
          ? "Study Mode is on. Study guidance is active; tools and commands remain available."
          : "Study Mode is off.", "info");
        return;
      }
      if (action === "on") {
        if (!studyEnabled) {
          studyEnabled = true;
          persistStudyState();
        }
        setStudyStatus(ctx);
        if (preceptorEnabled) {
          preceptorEnabled = false;
          persistPreceptorState();
          setPreceptorStatus(ctx);
        }
        ctx.ui.notify(
          "Study Mode enabled; Learning mode disabled. Guidance favors explanation and avoiding changes unless requested.",
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

  // ─── /wb:show-system-prompt command — Learning mode diagnostics ────

  pi.registerCommand("wb:show-system-prompt", {
    description: "Preview current system prompt, including Learning mode guidance",
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
      const platform = detectCodeGraphPlatform({ os: process.platform, arch: process.arch });

      if (action === "reindex") {
        if (tokens.length > 1) {
          ctx.ui.notify("Usage: /wb:code-graph reindex", "error");
          return;
        }
        codeGraphActivationQuiet = true;
        try {
          const result = await manager.reindex(project);
          if (result.ok) {
            codeGraphStatusOn(ctx);
            ctx.ui.notify(`Code graph reindexed for ${project.identifier}`, "info");
          } else {
            ctx.ui.notify(`Code graph reindex failed (${result.kind}): ${result.detail}`, "error");
          }
        } catch (error) {
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
        codeGraphActivationQuiet = true;
        try {
          const result = await manager.activate(project);
          if (result.ok) {
            codeGraphGuidanceActive = true;
            codeGraphStatusOn(ctx);
            ctx.ui.notify(`Code graph enabled for ${project.identifier}`, "info");
          } else {
            codeGraphStatusOff(ctx);
            ctx.ui.notify(`Code graph activation failed (${result.kind}): ${result.detail}`, "error");
          }
        } catch (error) {
          codeGraphStatusOff(ctx);
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
          manager.stop(project);
        } catch (error) {
          ctx.ui.notify(
            `Could not stop the owned code graph MCP server: ${error instanceof Error ? error.message : String(error)}. Data was not deleted.`,
            "error",
          );
          return;
        }
        // Brief grace period so the owned child can exit before unlink.
        await new Promise((resolve) => setTimeout(resolve, 500));
        const preDeletePathValidation = validateManagedProjectPath(project, paths);
        if (!preDeletePathValidation.ok) {
          ctx.ui.notify(`Code graph deletion refused: ${preDeletePathValidation.detail}`, "error");
          return;
        }
        try {
          await rm(project.directory, { recursive: true, force: false });
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
      const installed = platform
        ? await discoverInstalled(codeGraphInstaller.binRoot, platform).catch(() => null)
        : null;
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
        const binaryPath = installedBinaryPath(codeGraphInstaller.binRoot, installed.version, platform);
        report.indexSummary = (await manager.fetchIndexSummary(project, binaryPath)) ?? undefined;
      }
      ctx.ui.notify(formatCodeGraphStatus(report).join("\n"), "info");
    },
  });

  // ─── /wb:headroom-health command — proxy diagnostics ────────────────

  pi.registerCommand("wb:headroom-health", {
    description: "Check Headroom proxy health and show diagnostics",
    handler: async (_args, ctx) => {
      if (portConfigError) {
        proxyAvailable = false;
        ctx.ui.notify(`Headroom proxy configuration error: ${portConfigError}`, "error");
        ctx.ui.setStatus(
          "headroom-proxy",
          ctx.ui.theme.fg("warning", "⚠") + ctx.ui.theme.fg("dim", " Headroom offline"),
        );
        return;
      }

      ctx.ui.notify(`Checking Headroom proxy at ${baseUrl}...`, "info");

      const usingManagedProxy = proxyManager?.isManaged === true;
      const versionCheck = usingManagedProxy ? null : await checkExternalProxyVersion();
      const isHealthy = usingManagedProxy ? await proxyManager.healthCheck() : versionCheck?.ok === true;
      if (isHealthy) {
        proxyAvailable = true;

        const lines = [
          `Headroom proxy: online`,
          `  URL: ${baseUrl}`,
          `  Config: ${compressionStatus()}`,
          ...(usingManagedProxy
            ? [`  Version: ${await getManagedHeadroomVersion() ?? "unavailable"} (managed Python venv)`]
            : [
              `  Version: ${versionCheck?.reportedVersion ?? "unavailable"} (external /health)`,
              `  Expected: ${versionCheck?.expectedVersion ?? "unavailable"} (extension)`,
            ]),
        ];

        if (proxyManager) {
          lines.push(`  Managed: ${proxyManager.isManaged ? "yes (started by extension)" : "no (external)"}`);
        }

        ctx.ui.notify(lines.join("\n"), "info");
        ctx.ui.setStatus(
          "headroom-proxy",
          ctx.ui.theme.fg("success", "✓") + ctx.ui.theme.fg("dim", " Headroom"),
        );
      } else {
        proxyAvailable = false;
        const errMsg = versionCheck && !versionCheck.ok
          ? describeHeadroomVersionCheck(versionCheck)
          : "proxy did not respond";
        const helpLines = [
          `Headroom proxy offline`,
          `  URL: ${baseUrl}`,
          `  Error: ${errMsg}`,
        ];

        if (proxyManager) {
          helpLines.push(``, `The extension will auto-start the proxy on next session.`, `Or run: /wb:headroom-proxy on`);
        } else {
          helpLines.push(``, `Start the proxy manually:`, `  headroom proxy`, `  # or`, `  pip install "headroom-ai[proxy]" && headroom proxy`);
        }

        ctx.ui.notify(helpLines.join("\n"), "error");
        ctx.ui.setStatus(
          "headroom-proxy",
          ctx.ui.theme.fg("warning", "⚠") + ctx.ui.theme.fg("dim", " Headroom offline"),
        );
      }
    },
  });
}
