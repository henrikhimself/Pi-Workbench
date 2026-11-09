import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { watch as watchPath } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chmod, lstat, open, rm, rename as renamePath, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import {
  type InstalledBinary,
  type StatusReporter,
} from "./code-graph-installer.js";
import {
  codeGraphIdentity,
  isGitWorkspace,
  sameBackend,
  validateManagedProjectPath,
  validateCodeGraphState,
  type CodeGraphProject,
  type CodeGraphStatusReport,
} from "./code-graph-config.js";
import { OtherVersionError, otherVersionMessage, prepareDataStore, type CodeGraphStoreIdentity } from "./store-identity.js";
import { CODE_GRAPH_VERSION } from "./code-graph-assets.js";
import { TOOL_NAMES } from "./tool-names.js";
import { writeOptIn } from "./project-opt-in.js";
import { createHash, randomUUID } from "node:crypto";
import type { WorkbenchPaths } from "./paths.js";
import { defaultProcessRunner, type EscalatingExecResult, type ProcessRunner } from "./exec-escalating.js";
import { ensurePrivateDirectory, acquireManagedLock, activeConsumers, createConsumerLease, type ConsumerLease } from "./managed-lifecycle.js";
const MCP_LAUNCHER = fileURLToPath(new URL("./managed-mcp.mjs", import.meta.url));

/**
 * Extension-owned lifecycle for the standalone codebase-memory-mcp (CBM)
 * service: safe child environment, CBM configuration, initial index, MCP
 * handshake validation, direct registration, process ownership, and
 * activation/restore transactions.
 *
 * Design rules:
 * - Only the owned, SHA-verified managed binary is ever executed.
 * - The CBM child sees a minimal environment: `CBM_CACHE_DIR` pinned to the
 *   workspace project directory, `CBM_LOG_LEVEL=error`, and a `PATH` whose
 *   first entry is the extension-owned `curl` deny shim. No user
 *   `CBM_DOWNLOAD_URL` or other CBM configuration is ever accepted.
 * - Direct stdio MCP registration only, from the canonical workspace CWD,
 *   after the JSON-RPC handshake and tool list are validated.
 * - Fail-open: every failure leaves the workspace off with a diagnostic and
 *   never touches Headroom proxy/Memory or external CBM processes.
 */

export const CODE_GRAPH_MCP_SERVER_NAME = "codebase-memory";
export const CODE_GRAPH_MCP_PROTOCOL_VERSION = "2024-11-05";

/** The only `codebase-memory-mcp` release this extension will run; must match the packaged manifest. */
export const CODE_GRAPH_REQUIRED_VERSION = CODE_GRAPH_VERSION;
/**
 * Exact `tools/list` contract of the pinned binary. A mismatch means the asset is not what the
 * manifest describes, and activation must not proceed.
 */
export const CODE_GRAPH_EXPECTED_TOOLS = [
  "index_repository", "search_graph", "query_graph", "trace_path", "get_code_snippet",
  "get_file_outline", "get_graph_schema", "compare_graphs", "get_architecture", "search_code",
  "list_projects", "delete_project", "index_status", "check_index_coverage", "detect_changes",
  "manage_adr", "ingest_traces",
] as const;
/** Registered with Pi as `hidden`: still in the server's 17-tool contract, never offered to the model. */
export const CODE_GRAPH_HIDDEN_TOOLS = ["delete_project", "index_repository"] as const;

/** Timeout budgets for owned CBM child operations. */
export const CODE_GRAPH_TIMEOUTS = {
  handshake: 30_000,
  config: 30_000,
  index: 600_000,
  status: 30_000,
} as const;

/**
 * One guidance message, shown only after owned MCP registration and
 * handshake succeed. It recommends targeted structural queries and source
 * verification; it never forces tool use.
 */
export const CODE_GRAPH_GUIDANCE_TOOLS = ["search_graph", "trace_path", "get_architecture", "get_code_snippet", "get_file_outline", "query_graph"] as const;

export function codeGraphGuidance(tools: readonly string[]): string {
  return "Code Graph is enabled for this workspace. Use the codebase-memory-mcp " +
    `tools (${tools.join(", ")}) for structural code questions — cross-file ` +
    "relationships, call paths, blast radius, architecture overview. Verify " +
    "structural results against the actual source before relying on them for " +
    "edits. For exact literal matches use standard search instead.";
}

export const CODE_GRAPH_GUIDANCE_MESSAGE = codeGraphGuidance(CODE_GRAPH_GUIDANCE_TOOLS);

// ─── Process execution ────────────────────────────────────────────────

// ─── MCP handshake ────────────────────────────────────────────────────

export interface McpHandshakeResult {
  ok: boolean;
  tools?: string[];
  detail?: string;
}

export interface McpHandshakeOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  killGraceMs?: number;
}

/** Spawns a JSON-RPC stdio child, validates initialize + tools/list. */
export type McpHandshakeRunner = (options: McpHandshakeOptions) => Promise<McpHandshakeResult>;

interface JsonRpcResponse {
  result?: unknown;
  error?: { code?: number; message?: string };
}

function sendJsonrpc(child: ChildProcessWithoutNullStreams, message: Record<string, unknown>): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

/**
 * Default MCP handshake: newline-delimited JSON-RPC 2.0 on stdio.
 * Validates that `initialize` (protocol `2024-11-05`) succeeds, that
 * `tools/list` returns exactly the expected tool count, and that stdout
 * contains only JSON-RPC protocol lines. The probe child is always killed
 * before the caller registers the real server.
 */
export function defaultMcpHandshakeRunner(): McpHandshakeRunner {
  return (options) =>
    new Promise<McpHandshakeResult>((resolvePromise) => {
      let settled = false;
      let child: ChildProcessWithoutNullStreams | undefined;
      let buffer = "";
      let cleanStdout = true;
      let stderrText = "";
      const pending = new Map<number, (response: JsonRpcResponse) => void>();

      const kill = (): Promise<void> => new Promise((resolveKill) => {
        const current = child;
        if (!current || current.exitCode !== null || current.signalCode !== null) { resolveKill(); return; }
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true; clearTimeout(terminate); clearTimeout(escalate); resolveKill();
        };
        const terminate = setTimeout(() => { try { current.kill("SIGTERM"); } catch { finish(); } }, options.killGraceMs ?? 500);
        const escalate = setTimeout(() => { try { current.kill("SIGKILL"); } catch { finish(); } }, (options.killGraceMs ?? 500) + 2_000);
        current.once("close", finish);
        current.stdin.end();
      });

      const settle = async (result: McpHandshakeResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        await kill();
        resolvePromise(result.ok && (!cleanStdout || buffer.trim())
          ? { ok: false, detail: "MCP stdout contained non-JSON-RPC data" } : result);
      };

      const timer = setTimeout(() => {
        void settle({ ok: false, detail: `MCP handshake timed out after ${options.timeoutMs} ms` });
      }, options.timeoutMs);

      try {
        child = spawn(options.command, options.args, {
          cwd: options.cwd,
          env: options.env,
          stdio: ["pipe", "pipe", "pipe"], signal: options.signal,
        }) as ChildProcessWithoutNullStreams;
      } catch (error) {
        void settle({ ok: false, detail: `Failed to spawn MCP probe: ${error instanceof Error ? error.message : String(error)}` });
        return;
      }

      const currentChild = child;

      const respond = (id: number, response: JsonRpcResponse) => {
        const waiter = pending.get(id);
        if (waiter) {
          pending.delete(id);
          waiter(response);
        }
      };

      currentChild.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (buffer.length > 2 * 1024 * 1024) { void settle({ ok: false, detail: "MCP stdout limit exceeded" }); return; }
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim() === "") continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            // Non-JSON stdout breaks the stdio protocol contract.
            cleanStdout = false;
            continue;
          }
          if (!parsed || typeof parsed !== "object" || (parsed as { jsonrpc?: unknown }).jsonrpc !== "2.0") {
            cleanStdout = false; continue;
          }
          const message = parsed as { id?: unknown; result?: unknown; error?: { code?: number; message?: string } };
          if (typeof message.id === "number") respond(message.id, message);
        }
      });
      currentChild.stderr.on("data", (chunk: Buffer) => {
        stderrText = (stderrText + chunk.toString("utf8")).slice(-16_384);
      });
      // A dying child closes its stdin end; EPIPE must never crash the owner.
      currentChild.stdin.on("error", () => {});
      currentChild.on("error", (error) => {
        void settle({ ok: false, detail: `MCP probe spawn error: ${error.message}` });
      });
      currentChild.on("close", (code) => {
        if (!settled) {
          void settle({
            ok: false,
            detail: `MCP probe exited before handshake completed (exit ${code ?? "unknown"})${stderrText ? `; stderr: ${stderrText.trim().slice(0, 300)}` : ""}`,
          });
        }
      });

      const run = async () => {
        try {
          // 1. initialize
          const initResponse = await new Promise<JsonRpcResponse>((resolveWaiter) => {
            pending.set(1, (response) => resolveWaiter(response));
            sendJsonrpc(currentChild, {
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: CODE_GRAPH_MCP_PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: { name: "pi-workbench-code-graph", version: "1.0.0" },
              },
            });
          });
          if (settled) return;
          if (initResponse.error) {
            void settle({
              ok: false,
              detail: `MCP initialize failed: ${String(initResponse.error.code ?? "")} ${String(initResponse.error.message ?? "")}`.trim(),
            });
            return;
          }
          const init = initResponse.result as { protocolVersion?: unknown; serverInfo?: { version?: unknown } };
          if (!init || init.serverInfo?.version !== CODE_GRAPH_REQUIRED_VERSION.slice(1)) {
            void settle({ ok: false, detail: "MCP backend version mismatch" }); return;
          }
          if (init.protocolVersion !== CODE_GRAPH_MCP_PROTOCOL_VERSION) {
            void settle({
              ok: false,
              detail: `MCP protocol mismatch: server responded ${String(init.protocolVersion)}, expected ${CODE_GRAPH_MCP_PROTOCOL_VERSION}`,
            });
            return;
          }

          // 2. notifications/initialized (MCP lifecycle), then tools/list.
          sendJsonrpc(currentChild, { jsonrpc: "2.0", method: "notifications/initialized" });
          const tools: string[] = [];
          const cursors = new Set<string>();
          let cursor: string | undefined;
          for (let page = 0; ; page++) {
            if (page >= 32) throw new Error("MCP tools/list pagination limit exceeded");
            const response = await new Promise<JsonRpcResponse>((resolveWaiter) => {
              const id = page + 2;
              pending.set(id, resolveWaiter);
              sendJsonrpc(currentChild, { jsonrpc: "2.0", id, method: "tools/list", params: cursor ? { cursor } : {} });
            });
            if (settled) return;
            if (response.error) throw new Error("MCP tools/list failed: " + String(response.error.message));
            const result = response.result as { tools?: Array<{ name?: unknown }>; nextCursor?: unknown } | undefined;
            if (!Array.isArray(result?.tools)) throw new Error("Malformed MCP tools/list result");
            for (const tool of result.tools) {
              if (typeof tool?.name !== "string" || !tool.name || tools.includes(tool.name)) throw new Error("Invalid or duplicate MCP tool name");
              tools.push(tool.name);
            }
            if (result.nextCursor === undefined) break;
            if (typeof result.nextCursor !== "string" || !result.nextCursor || result.nextCursor.length > 512 || cursors.has(result.nextCursor)) throw new Error("Invalid or repeated MCP tool cursor");
            cursors.add(result.nextCursor); cursor = result.nextCursor;
          }
          if (!cleanStdout) throw new Error("MCP stdout contained non-JSON-RPC data");
          if (tools.length !== CODE_GRAPH_EXPECTED_TOOLS.length) throw new Error(`MCP tool count mismatch: got ${tools.length}, expected ${CODE_GRAPH_EXPECTED_TOOLS.length}`);
          if (CODE_GRAPH_EXPECTED_TOOLS.some((name) => !tools.includes(name))) throw new Error("MCP tool-name contract mismatch");
          void settle({ ok: true, tools });
        } catch (error) {
          void settle({ ok: false, detail: `MCP handshake sequence error: ${error instanceof Error ? error.message : String(error)}` });
        }
      };
      void run();
    });
}

// ─── Curl deny shim and child environment ─────────────────────────────

const CURL_DENY_SHIM_SCRIPT = "#!/bin/sh\nexit 3\n";

/**
 * Create the extension-owned `curl` deny shim atomically (temp write +
 * fsync + rename, mode 0755). The shim makes any bare `curl` invocation in
 * a CBM child fail immediately with a nonzero code and no output, which
 * blocks CBM's initialize-time GitHub release check. It never affects the
 * parent process environment or PATH.
 */
export async function ensureCurlDenyShim(shimPath: string, root: string): Promise<void> {
  // The directory is created (or repaired) owner-only, even under umask 002:
  // a group-writable deny-shims directory would let group members replace the shim.
  await ensurePrivateDirectory(root, dirname(shimPath));
  const tempPath = `${shimPath}.${process.pid}-${randomUUID()}.tmp`;
  try {
    const handle = await open(tempPath, "wx", 0o700);
    try {
      await handle.writeFile(CURL_DENY_SHIM_SCRIPT, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await chmod(tempPath, 0o755);
    await renamePath(tempPath, shimPath);
  } finally { await rm(tempPath, { force: true }); }
}

/** Directory that must be prepended to a CBM child PATH. */
export function curlShimDirectory(shimPath: string): string {
  return dirname(shimPath);
}

/**
 * Build the minimal environment for an owned CBM child. Pure function: the
 * parent environment is never modified. No `CBM_DOWNLOAD_URL`, user CBM
 * configuration, or inherited CBM variables are carried over.
 */
export function createCbmEnvironment(options: {
  projectDirectory: string;
  shimPath: string;
  runtimeDirectory: string;
  homeDirectory: string;
  workspacePath: string;
  source?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const source = options.source ?? process.env;
  return {
    PATH: `${curlShimDirectory(options.shimPath)}:${source.PATH || "/usr/local/bin:/usr/bin:/bin"}`,
    HOME: options.homeDirectory,
    XDG_CACHE_HOME: join(options.homeDirectory, "cache"),
    XDG_CONFIG_HOME: join(options.homeDirectory, "config"),
    LANG: "C.UTF-8",
    CBM_CACHE_DIR: options.projectDirectory,
    CBM_RUNTIME_DIR: options.runtimeDirectory,
    CBM_ALLOWED_ROOT: options.workspacePath,
    CBM_LOG_LEVEL: "error",
  };
}

// ─── CBM CLI output helpers ───────────────────────────────────────────

function parseJsonOutput(stdout: string, what: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error(`${what} produced no output`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`${what} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}; output: ${trimmed.slice(0, 300)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${what} returned invalid JSON (expected object): ${trimmed.slice(0, 300)}`);
  }
  return parsed as Record<string, unknown>;
}

function failureDetail(what: string, result: EscalatingExecResult): Error {
  const detail = (result.stderr || result.stdout).trim().slice(0, 300);
  return new Error(`codebase-memory-mcp ${what} failed (exit ${result.code})${detail ? `: ${detail}` : ""}`);
}

/** Resource tag of a Pi session's lease (MCP registration or reindex), as distinct from the launcher's. */
const sessionResource = (project: CodeGraphProject): string => `session:${project.directory}`;

/** Deletion needs no active consumer lease. */
async function assertCodeGraphQuiescent(project: CodeGraphProject, paths: WorkbenchPaths): Promise<void> {
  if ((await activeConsumers(join(paths.codeGraphRuntime, "consumers", project.identifier))).length) {
    throw new Error("Active workspace consumers; close other Pi sessions for this workspace first");
  }
}

// ─── Manager ──────────────────────────────────────────────────────────

export interface CodeGraphManagerDeps {
  paths: WorkbenchPaths;
  signal?: AbortSignal;
  /** Install/update decision for the managed binary (packaged asset only). */
  ensureInstalled: (onStatus: StatusReporter) => Promise<InstalledBinary>;
  onStatus?: StatusReporter;
  runProcess?: ProcessRunner;
  runMcpHandshake?: McpHandshakeRunner;
  registerMcp?: (name: string, config: McpServerConfig) => void;
  /** Returns a description when a same-name server (mcp.json or another extension) would shadow this one. */
  conflict?: () => Promise<string | null>;
  unregisterMcp?: (name: string) => void;
}

/** The backend a launcher will start: its path and the identity its data must carry. */
export type LaunchBinary = Pick<InstalledBinary, "path" | "version" | "resolvedUrl" | "sha256">;

export type CodeGraphResult =
  | { ok: true; identity: CodeGraphStoreIdentity; binaryPath: string; tools: string[]; alreadyOn: boolean }
  | {
      ok: false;
      kind: CodeGraphStatusReport["kind"] | "binary_missing" | "mcp_failed" | "locked";
      detail: string;
    };

export class CodeGraphManager {
  private readonly deps: Omit<CodeGraphManagerDeps, "runProcess" | "runMcpHandshake"> & {
    runProcess: ProcessRunner;
    runMcpHandshake: McpHandshakeRunner;
  };
  private registeredProject: string | null = null;
  private mcpRegistered = false;
  private lastError: string | null = null;
  private installation: InstalledBinary | null = null;
  private lease: ConsumerLease | null = null;
  private closed = false;
  private readonly cancellation = new AbortController();

  constructor(deps: CodeGraphManagerDeps) {
    this.deps = {
      ...deps,
      signal: deps.signal ? AbortSignal.any([deps.signal, this.cancellation.signal]) : this.cancellation.signal,
      runProcess: deps.runProcess ?? defaultProcessRunner(),
      runMcpHandshake: deps.runMcpHandshake ?? defaultMcpHandshakeRunner(),
    };
  }

  /** True when the manager currently holds the MCP registration. */
  get isMcpRegistered(): boolean {
    return this.mcpRegistered;
  }

  /** Directory of the project currently holding the registration, if any. */
  get registeredProjectDirectory(): string | null {
    return this.registeredProject;
  }

  private report(message: string): void {
    this.deps.onStatus?.(message);
  }

  private coordinationRoot(): string { return join(this.deps.paths.codeGraphRuntime, "coordination"); }
  private leaseRoot(project: CodeGraphProject): string { return join(this.deps.paths.codeGraphRuntime, "consumers", project.identifier); }
  /** Tokens of the session leases this manager holds, so it can tell its own from another session's. */
  private readonly ownLeaseTokens = new Set<string>();
  private async acquireSessionLease(project: CodeGraphProject): Promise<ConsumerLease> {
    const lease = await createConsumerLease(this.leaseRoot(project), sessionResource(project));
    this.ownLeaseTokens.add(lease.token);
    return { token: lease.token, release: async () => { await lease.release(); this.ownLeaseTokens.delete(lease.token); } };
  }
  /** Other Pi sessions using this workspace (advisory: `removeProject` re-checks every lease). Throws on unreadable leases. */
  async otherSessionCount(project: CodeGraphProject): Promise<number> {
    this.assertProjectPathSafe(project);
    return (await activeConsumers(this.leaseRoot(project), sessionResource(project))).filter((token) => !this.ownLeaseTokens.has(token)).length;
  }
  /**
   * Pi stops the unregistered MCP server asynchronously (stdin EOF, then signals), so its consumer
   * lease can outlive `stop()` by a few seconds. Poll for quiescence up to a deadline instead of
   * failing on the first check; nothing is deleted while a consumer is still active.
   */
  async removeProject(project: CodeGraphProject, options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
    this.assertProjectPathSafe(project);
    const deadline = Date.now() + (options.timeoutMs ?? 10_000);
    for (;;) {
      try { await assertCodeGraphQuiescent(project, this.deps.paths); break; }
      catch (error) {
        if (!/^Active workspace consumers/.test(error instanceof Error ? error.message : "") || Date.now() >= deadline) throw error;
        this.deps.signal?.throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 250));
      }
    }
    const release = await acquireManagedLock(this.coordinationRoot(), project.identifier);
    try {
      await assertCodeGraphQuiescent(project, this.deps.paths);
      await rm(project.directory, { recursive: true, force: false });
    } finally { await release(); }
  }
  private async operate(project: CodeGraphProject, action: "activate" | "restore" | "reindex"): Promise<CodeGraphResult> {
    if (this.closed || this.deps.signal?.aborted) return { ok: false, kind: "off", detail: "Session closed" };
    const validation = await validateCodeGraphState(project);
    const run = () => action === "activate" ? this.activateUnlocked(project) : this.restoreUnlocked(project);
    if (!validateManagedProjectPath(project, this.deps.paths).ok || (!validation.ok && !(action === "activate" && validation.problem === "missing"))) {
      if (action !== "reindex") return run();
      const plan = await this.prepareReindex(project);
      if ("failure" in plan) return plan.failure;
    }
    const fail = (kind: Extract<CodeGraphResult, { ok: false }>["kind"], error: unknown): CodeGraphResult => {
      this.lastError = error instanceof Error ? error.message : String(error);
      return { ok: false, kind, detail: this.lastError };
    };
    if (action !== "reindex" && !this.mcpRegistered) {
      // Refuse a same-name server before any download, index or data is created.
      const conflict = await this.deps.conflict?.();
      if (conflict) return fail("mcp_failed", new Error(`Code Graph MCP server not registered: ${conflict}. The existing server was left untouched.`));
    }
    try {
      this.installation = await this.deps.ensureInstalled((message) => this.report(message));
      if (this.installation.version !== CODE_GRAPH_REQUIRED_VERSION) throw new Error("Managed backend does not match packaged pin");
    } catch (error) { return fail("binary_missing", error); }
    // After installation, report the real failure kind. "upgrade_pending" means the data on disk
    // was written by another version; it is refused and left unchanged.
    if (action === "reindex") return this.reindexLeased(project, fail);
    let release: () => Promise<void>;
    try { release = await acquireManagedLock(this.coordinationRoot(), project.identifier); }
    catch (error) { return fail("locked", error); }
    try { return await run(); }
    catch (error) { return fail("mcp_failed", error); }
    finally { await release(); }
  }
  async activate(project: CodeGraphProject): Promise<CodeGraphResult> { return this.operate(project, "activate"); }
  async restore(project: CodeGraphProject): Promise<CodeGraphResult> { return this.operate(project, "restore"); }
  async reindex(project: CodeGraphProject): Promise<CodeGraphResult> { return this.operate(project, "reindex"); }
  /** Minimal env + workspace CWD for all owned CBM child operations. */
  private createEnv(project: CodeGraphProject): Record<string, string> {
    return createCbmEnvironment({
      projectDirectory: project.directory,
      shimPath: this.deps.paths.codeGraphCurlShim,
      runtimeDirectory: this.runtimeDirectory(project),
      homeDirectory: join(this.deps.paths.codeGraphRuntime, "homes", project.identifier),
      workspacePath: project.projectPath,
    });
  }

  private runtimeDirectory(project: CodeGraphProject): string {
    return join(this.deps.paths.codeGraphIpc, createHash("sha256").update(project.directory).digest("hex").slice(0, 16));
  }

  private async prepareRuntime(project: CodeGraphProject): Promise<void> {
    const directory = this.runtimeDirectory(project);
    const socket = join(directory, `cbm-daemon-${process.getuid?.() ?? 0}`, `cbm-${"0".repeat(16)}.sock`);
    if (Buffer.byteLength(socket) >= 108) throw new Error("Managed Code Graph IPC path exceeds Linux Unix-socket limit; no shared/global runtime fallback");
    await ensurePrivateDirectory(this.deps.paths.codeGraphIpc, directory);
    await ensurePrivateDirectory(this.deps.paths.codeGraphRuntime, join(this.deps.paths.codeGraphRuntime, "homes", project.identifier));
  }

  private assertProjectPathSafe(project: CodeGraphProject): void {
    const validation = validateManagedProjectPath(project, this.deps.paths);
    if (!validation.ok) throw new Error(validation.detail);
  }

  private async runCbm(
    project: CodeGraphProject,
    binaryPath: string,
    args: string[],
    timeoutMs: number,
    what: string,
  ): Promise<EscalatingExecResult> {
    this.assertProjectPathSafe(project);
    await this.prepareRuntime(project);
    const result = await this.deps.runProcess(binaryPath, args, {
      cwd: project.projectPath,
      env: this.createEnv(project),
      timeoutMs, signal: this.deps.signal,
    });
    if (result.code !== 0) throw failureDetail(what, result);
    return result;
  }

  /** `config set auto_index true` + verification through `config get`. */
  private async setAutoIndexEnabled(project: CodeGraphProject, binaryPath: string): Promise<void> {
    await this.runCbm(
      project,
      binaryPath,
      ["config", "set", "auto_index", "true"],
      CODE_GRAPH_TIMEOUTS.config,
      "config set auto_index",
    );
    const verified = await this.readAutoIndexState(project, binaryPath);
    if (!verified) {
      throw new Error("codebase-memory-mcp auto_index verification failed: expected true after config set");
    }
  }

  /** Read `auto_index` from the project `_config.db` via the owned CLI. */
  private async readAutoIndexState(project: CodeGraphProject, binaryPath: string): Promise<boolean> {
    const result = await this.runCbm(
      project,
      binaryPath,
      ["config", "get", "auto_index"],
      CODE_GRAPH_TIMEOUTS.config,
      "config get auto_index",
    );
    return result.stdout.trim() === "true";
  }

  /** `cli --quiet index_repository --repo-path <workspace>`. */
  private async runIndexRepository(project: CodeGraphProject, binaryPath: string): Promise<string> {
    const args = ["cli", "--quiet", "index_repository", "--repo-path", project.projectPath];
    const result = await this.runCbm(project, binaryPath, args, CODE_GRAPH_TIMEOUTS.index, "index_repository");
    const parsed = parseJsonOutput(result.stdout, "index_repository");
    if (parsed.status !== "indexed" || typeof parsed.project !== "string" || parsed.project.length === 0) {
      throw new Error(`index_repository did not report a successful named index: ${JSON.stringify(parsed).slice(0, 300)}`);
    }
    return parsed.project;
  }

  /** Wait for CBM to publish its derived index database, without timer polling. */
  private async waitForIndexDatabase(project: CodeGraphProject, projectName: string): Promise<void> {
    if (projectName.length === 0 || basename(projectName) !== projectName) {
      throw new Error(`index_repository returned unsafe project name ${JSON.stringify(projectName)}`);
    }
    const indexPath = join(project.directory, `${projectName}.db`);
    const isReady = async (): Promise<boolean> => {
      try { return (await lstat(indexPath)).isFile(); } catch { return false; }
    };
    if (await isReady()) return;
    await new Promise<void>((resolvePromise, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        watcher.close();
        if (error) reject(error); else resolvePromise();
      };
      const watcher = watchPath(project.directory, { persistent: false }, () => {
        void isReady().then((ready) => { if (ready) finish(); }, (error) => finish(error instanceof Error ? error : new Error(String(error))));
      });
      watcher.on("error", (error) => finish(new Error(`index database watcher failed: ${error.message}`)));
      const timeout = setTimeout(() => finish(new Error(`index database was not created within ${String(CODE_GRAPH_TIMEOUTS.status / 1_000)} seconds: ${projectName}.db`)), CODE_GRAPH_TIMEOUTS.status);
      void isReady().then((ready) => { if (ready) finish(); }, (error) => finish(error instanceof Error ? error : new Error(String(error))));
    });
  }

  /** Confirm index readiness after CBM publishes its derived database. */
  private async validateIndex(project: CodeGraphProject, binaryPath: string, projectName?: string): Promise<string> {
    let candidate = projectName;
    if (candidate) {
      await this.waitForIndexDatabase(project, candidate);
    } else {
      const matches: string[] = [];
      let offset = 0;
      for (let page = 0; page < 200; page++) {
        const result = await this.runCbm(project, binaryPath,
          ["cli", "--quiet", "list_projects", "--format", "json", "--offset", String(offset), "--limit", "50"],
          CODE_GRAPH_TIMEOUTS.status, "list_projects");
        const list = parseJsonOutput(result.stdout, "list_projects");
        if (!Array.isArray(list.projects)) throw new Error("Malformed project listing");
        for (const row of list.projects) {
          if (!row || typeof row !== "object" || typeof row.name !== "string" || typeof row.root_path !== "string") throw new Error("Malformed project identity");
          if (row.root_path === project.projectPath) matches.push(row.name);
        }
        if (list.has_more === false) break;
        if (list.has_more !== true || list.projects.length === 0 || !Number.isInteger(list.offset) || list.offset !== offset) throw new Error("Invalid project pagination");
        offset += list.projects.length;
        if (page === 199) throw new Error("Project pagination limit exceeded");
      }
      if (matches.length !== 1) throw new Error("Expected one indexed project matching canonical workspace");
      candidate = matches[0];
    }
    if (!candidate || basename(candidate) !== candidate || candidate === "." || candidate === "..") throw new Error("Unsafe project name");
    const statusResult = await this.runCbm(
      project, binaryPath, ["cli", "--quiet", "index_status", "--project", candidate, "--format", "json"], CODE_GRAPH_TIMEOUTS.status, "index_status",
    );
    const status = parseJsonOutput(statusResult.stdout, "index_status");
    if (status.status !== "ready") throw new Error(`index_status reported ${String(status.status)} for ${candidate}`);
    return candidate;
  }

  /** Validate the MCP handshake/tool list on a throwaway probe child. */
  private async validateHandshake(project: CodeGraphProject, binaryPath: string): Promise<string[]> {
    this.assertProjectPathSafe(project);
    await this.prepareRuntime(project);
    const result = await this.deps.runMcpHandshake({
      command: binaryPath,
      args: ["--ui=false", "--quiet", "--repo-path", project.projectPath],
      cwd: project.projectPath,
      env: this.createEnv(project),
      timeoutMs: CODE_GRAPH_TIMEOUTS.handshake,
      signal: this.deps.signal,
    });
    if (!result.ok || !result.tools) {
      throw new Error(`MCP handshake validation failed: ${result.detail ?? "unknown error"}`);
    }
    return result.tools;
  }

  getMcpConfig(project: CodeGraphProject, binary: LaunchBinary): McpServerConfig {
    // Same environment function as the handshake probe and every other owned CBM child. The
    // launcher gives the server exactly this; it is not registered through `McpServerConfig.env`
    // (Pi would merge it over its full environment and interpolate `$`/`!` in values).
    const spec = {
      schemaVersion: 1, command: binary.path, args: ["--ui=false", "--quiet", "--repo-path", project.projectPath],
      env: this.createEnv(project),
      cwd: project.projectPath, installRoot: this.deps.paths.codeGraphBin,
      coordinationRoot: this.coordinationRoot(), lockName: project.identifier,
      leaseRoot: this.leaseRoot(project), resource: project.directory, markerPath: project.identityPath,
      expectedMarker: { codeGraphVersion: binary.version, resolvedUrl: binary.resolvedUrl, sha256: binary.sha256 },
    };
    return {
      command: process.execPath, args: [MCP_LAUNCHER, JSON.stringify(spec)],
      cwd: project.projectPath, exposure: "direct",
      // The model gets the 15 read/query tools. Deleting a project and re-indexing are user actions
      // (`/wb:code-graph off` and `reindex`, which use the CLI, not these MCP tools).
      toolExposure: Object.fromEntries(CODE_GRAPH_HIDDEN_TOOLS.map(name => [name, "hidden" as const])),
      description: "Code graph structural queries for the current workspace (extension-owned codebase-memory-mcp).",
    };
  }

  private async registerMcp(project: CodeGraphProject, binary: LaunchBinary): Promise<void> {
    if (this.closed || this.deps.signal?.aborted) throw new Error("Session closed before MCP registration");
    this.assertProjectPathSafe(project);
    if (!this.deps.registerMcp) throw new Error("MCP registration is not available in this context");
    if (this.mcpRegistered) await this.unregisterOwned();
    const conflict = await this.deps.conflict?.();
    if (conflict) throw new Error(`Code Graph MCP server not registered: ${conflict}. The existing server was left untouched.`);
    this.lease = await this.acquireSessionLease(project);
    try {
      if (this.closed || this.deps.signal?.aborted) throw new Error("Session closed before MCP registration");
      this.deps.registerMcp(CODE_GRAPH_MCP_SERVER_NAME, this.getMcpConfig(project, binary));
      this.mcpRegistered = true; this.registeredProject = project.directory;
    } catch (error) { await this.lease.release(); this.lease = null; throw error; }
  }

  /**
   * Release the extension-owned MCP registration for the tracked project.
   * Idempotent; only ever unregisters the server this manager registered.
   * Never kills external or unidentified CBM processes.
   */
  async stop(project: CodeGraphProject): Promise<void> {
    this.assertProjectPathSafe(project);
    if (!this.mcpRegistered || this.registeredProject !== project.directory) return;
    try {
      await this.unregisterOwned();
    } catch (error) {
      this.lastError = `MCP unregister failed: ${error instanceof Error ? error.message : String(error)}`;
      throw error;
    }
  }

  private async unregisterOwned(): Promise<void> {
    this.deps.unregisterMcp?.(CODE_GRAPH_MCP_SERVER_NAME);
    this.mcpRegistered = false; this.registeredProject = null;
    await this.lease?.release(); this.lease = null;
  }

  async shutdown(): Promise<void> {
    this.closed = true; this.cancellation.abort();
    if (this.mcpRegistered) await this.unregisterOwned();
  }

  /**
   * `/wb:code-graph on` transaction:
   * 1. valid state → "already on": ensure registration, no reindex;
   * 2. corrupt state → diagnostic, no auto-repair;
   * 3. install/reuse asset → project directory → curl shim →
   *    auto_index → initial index → index validation → MCP handshake →
   *    write opt-in.json (the commit point) → register MCP.
   * Failures roll back the project directory created by this transaction
   * (never a pre-existing one) and leave the workspace off.
   */
  private async activateUnlocked(project: CodeGraphProject): Promise<CodeGraphResult> {
    const pathValidation = validateManagedProjectPath(project, this.deps.paths);
    if (!pathValidation.ok) {
      this.lastError = pathValidation.detail;
      return { ok: false, kind: "corrupt", detail: pathValidation.detail };
    }
    const validation = await validateCodeGraphState(project);
    if (validation.ok) {
      this.report(`Code graph already enabled for ${project.identifier}; ensuring MCP registration.`);
      const resolution = await this.resolveBinary();
      if (resolution.status === "failed") return resolution.result;
      const compatibility = this.requireStateCompatibility(validation.identity, resolution);
      if (compatibility) return compatibility;
      // This session already serves the workspace: do not probe, and never restart the live server.
      if (this.mcpRegistered && this.registeredProject === project.directory) {
        this.lastError = null;
        return { ok: true, identity: validation.identity, binaryPath: resolution.path, tools: [], alreadyOn: true };
      }
      let tools: string[] | null;
      try {
        tools = await this.validateHandshake(project, resolution.path);
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        tools = null;
      }
      if (tools === null) {
        return { ok: false, kind: "mcp_failed", detail: this.lastError ?? "MCP handshake failed" };
      }
      await this.registerMcp(project, resolution);
      this.lastError = null;
      return { ok: true, identity: validation.identity, binaryPath: resolution.path, tools, alreadyOn: true };
    }
    if (validation.problem !== "missing") {
      this.lastError = validation.detail;
      return {
        ok: false,
        kind: "corrupt",
        detail: `Existing code graph state is invalid (${validation.problem}); run /wb:code-graph off to clear it. ${validation.detail}`,
      };
    }

    let directoryExistedBefore = false;
    let optInWritten = false;
    let identity: CodeGraphStoreIdentity;
    try {
      directoryExistedBefore = await this.directoryExists(project.directory);
      const install = this.installation;
      if (!install) throw new Error("Managed backend was not resolved for this operation");
      if (install.version !== CODE_GRAPH_REQUIRED_VERSION) throw new Error("Managed backend does not match packaged pin");
      this.report(`Preparing project data directory ${project.directory}…`);
      // Identity first: the guard refuses a non-empty directory it did not mark, or one marked by
      // another backend. The opt-in is written last and is the commit point.
      identity = codeGraphIdentity(install);
      await prepareDataStore(project.directory, identity);
      this.assertProjectPathSafe(project);
      await ensureCurlDenyShim(this.deps.paths.codeGraphCurlShim, this.deps.paths.codeGraphRoot);
      this.report("Enabling codebase-memory-mcp auto-index for this workspace…");
      await this.setAutoIndexEnabled(project, install.path);
      this.report("Building initial code index (this can take a while on large repositories)…");
      const indexedProjectName = await this.runIndexRepository(project, install.path);
      this.report("Validating index...");
      const projectName = await this.validateIndex(project, install.path, indexedProjectName);
      this.report("Validating MCP handshake before activation…");
      const tools = await this.validateHandshake(project, install.path);
      this.assertProjectPathSafe(project);
      // Indexing can take minutes: the session may have closed, or a same-name server appeared.
      if (this.closed || this.deps.signal?.aborted) throw new Error("Session closed before Code Graph was enabled");
      if (!this.mcpRegistered) {
        const conflict = await this.deps.conflict?.();
        if (conflict) throw new Error(`Code Graph MCP server not registered: ${conflict}. The existing server was left untouched.`);
      }
      await writeOptIn(project, project.directory);
      optInWritten = true;
      await this.registerMcp(project, install);
      this.lastError = null;
      this.report(`Code graph enabled for ${project.identifier} (project ${projectName}).`);
      return { ok: true, identity, binaryPath: install.path, tools, alreadyOn: false };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      // A failed `on` never leaves an opt-in behind, even in a pre-existing directory.
      if (optInWritten && validateManagedProjectPath(project, this.deps.paths).ok) {
        await rm(project.optInPath, { force: true }).catch(() => {});
      }
      // Roll back only what this transaction created; never delete a
      // pre-existing (possibly valid) project directory.
      if (!directoryExistedBefore && validateManagedProjectPath(project, this.deps.paths).ok) {
        await rm(project.directory, { recursive: true, force: true }).catch(() => {});
      }
      return { ok: false, kind: error instanceof OtherVersionError ? "upgrade_pending" : "mcp_failed", detail: this.lastError };
    }
  }

  /** Validates an already-enabled workspace before a reindex; returns a failure or what `runReindex` needs. */
  private async prepareReindex(project: CodeGraphProject): Promise<{ failure: CodeGraphResult } | { identity: CodeGraphStoreIdentity; path: string }> {
    const pathValidation = validateManagedProjectPath(project, this.deps.paths);
    if (!pathValidation.ok) return { failure: { ok: false, kind: "corrupt", detail: pathValidation.detail } };
    const validation = await validateCodeGraphState(project);
    if (!validation.ok) {
      const detail = validation.problem === "missing"
        ? "Code graph is not enabled for this workspace; run /wb:code-graph on first."
        : `Code graph state is invalid (${validation.problem}); run /wb:code-graph off then on before reindexing. ${validation.detail}`;
      return { failure: { ok: false, kind: validation.problem === "missing" ? "off" : "corrupt", detail } };
    }
    const resolution = await this.resolveBinary();
    if (resolution.status === "failed") return { failure: resolution.result };
    const compatibility = this.requireStateCompatibility(validation.identity, resolution);
    if (compatibility) return { failure: compatibility };
    return { identity: validation.identity, path: resolution.path };
  }

  /** Rebuild the index without deleting state. Runs outside the project lock, under a consumer lease. */
  private async runReindex(project: CodeGraphProject, identity: CodeGraphStoreIdentity, binaryPath: string): Promise<CodeGraphResult> {
    try {
      const indexedProjectName = await this.runIndexRepository(project, binaryPath);
      await this.validateIndex(project, binaryPath, indexedProjectName);
      this.lastError = null;
      return { ok: true, identity, binaryPath, tools: [], alreadyOn: true };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.lastError = detail;
      return { ok: false, kind: "mcp_failed", detail };
    }
  }

  /**
   * A reindex can take minutes. It holds `<id>.reindex` (serialising reindexes) for its duration, but the
   * project lock `<id>` only while it validates and takes a consumer lease. The lease keeps `off` from
   * deleting the data, while `restore` and the launchers are not blocked. Lock order: `.reindex`, then `<id>`.
   */
  private async reindexLeased(
    project: CodeGraphProject,
    fail: (kind: Extract<CodeGraphResult, { ok: false }>["kind"], error: unknown) => CodeGraphResult,
  ): Promise<CodeGraphResult> {
    const reindexLockName = `${project.identifier}.reindex`;
    let releaseReindex: () => Promise<void>;
    try { releaseReindex = await acquireManagedLock(this.coordinationRoot(), reindexLockName); }
    catch (error) {
      return fail("locked", new Error(`A reindex is already running for this workspace. If none is, remove ${join(this.coordinationRoot(), `${reindexLockName}.lock`)}. ${error instanceof Error ? error.message : String(error)}`));
    }
    let lease: ConsumerLease | undefined;
    try {
      let releaseProject: () => Promise<void>;
      try { releaseProject = await acquireManagedLock(this.coordinationRoot(), project.identifier); }
      catch (error) { return fail("locked", error); }
      let plan: Awaited<ReturnType<CodeGraphManager["prepareReindex"]>>;
      try {
        plan = await this.prepareReindex(project);
        if ("failure" in plan) return plan.failure;
        lease = await this.acquireSessionLease(project);
      } catch (error) { return fail("mcp_failed", error); }
      finally { await releaseProject(); }
      try { return await this.runReindex(project, plan.identity, plan.path); }
      catch (error) { return fail("mcp_failed", error); }
    } finally {
      await lease?.release().catch(() => {});
      await releaseReindex();
    }
  }

  /**
   * Session-start restore.
   * - no state → off, without installer/CBM work;
   * - corrupt state → diagnostic, no auto-repair;
   * - valid state → resolve the pinned binary (no fallback to another
   *   version: a binary that differs from the workspace state is refused as
   *   `upgrade_pending`), `_config.db`
   *   must prove `auto_index=true`, handshake, registration.
   */
  private async restoreUnlocked(project: CodeGraphProject): Promise<CodeGraphResult> {
    const pathValidation = validateManagedProjectPath(project, this.deps.paths);
    if (!pathValidation.ok) {
      this.lastError = pathValidation.detail;
      return { ok: false, kind: "corrupt", detail: pathValidation.detail };
    }
    const validation = await validateCodeGraphState(project);
    if (!validation.ok) {
      if (validation.problem === "missing") {
        return { ok: false, kind: "off", detail: "No code graph state for this workspace; feature stays off." };
      }
      this.lastError = validation.detail;
      return {
        ok: false,
        kind: "corrupt",
        detail: `Code graph state is invalid (${validation.problem}); feature stays off. ${validation.detail}`,
      };
    }

    // The owned env always prepends the curl-deny shim directory; make
    // sure the shim exists even when this session never ran activation.
    await ensureCurlDenyShim(this.deps.paths.codeGraphCurlShim, this.deps.paths.codeGraphRoot);

    const resolution = await this.resolveBinary();
    if (resolution.status === "failed") return resolution.result;
    const compatibility = this.requireStateCompatibility(validation.identity, resolution);
    if (compatibility) return compatibility;

    let autoIndex = false;
    try {
      autoIndex = await this.readAutoIndexState(project, resolution.path);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    if (!autoIndex) {
      this.lastError = this.lastError ?? "_config.db does not prove auto_index=true";
      return {
        ok: false,
        kind: "corrupt",
        detail: "Workspace state exists but _config.db does not prove auto_index=true; run /wb:code-graph off then on.",
      };
    }

    let tools: string[] | null;
    try {
      tools = await this.validateHandshake(project, resolution.path);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      tools = null;
    }
    if (tools === null) {
      return { ok: false, kind: "mcp_failed", detail: this.lastError ?? "MCP handshake failed" };
    }
    await this.registerMcp(project, resolution);
    this.lastError = null;
    this.report(`Code graph restored for ${project.identifier}.`);
    return { ok: true, identity: validation.identity, binaryPath: resolution.path, tools, alreadyOn: true };
  }

  /**
   * The identity file must match the resolved binary exactly (version, resolved URL, SHA-256).
   * Otherwise nothing is changed and the data is refused as `upgrade_pending`; it is never
   * converted and never deleted here.
   */
  private requireStateCompatibility(
    identity: CodeGraphStoreIdentity,
    binary: { version: string; resolvedUrl: string; sha256: string },
  ): Extract<CodeGraphResult, { ok: false }> | null {
    if (sameBackend(identity, binary)) return null;
    const detail = otherVersionMessage(TOOL_NAMES.codeGraph);
    this.lastError = detail;
    return { ok: false, kind: "upgrade_pending", detail };
  }

  private async resolveBinary(): Promise<{ status: "resolved"; path: string; version: string; resolvedUrl: string; sha256: string } | { status: "failed"; result: Extract<CodeGraphResult, { ok: false }> }> {
    try {
      const install = this.installation;
      if (!install) throw new Error("Managed backend was not resolved for this operation");
      if (install.version !== CODE_GRAPH_REQUIRED_VERSION) throw new Error("Managed backend does not match packaged pin");
      return { status: "resolved", path: install.path, version: install.version, resolvedUrl: install.resolvedUrl, sha256: install.sha256 };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return { status: "failed", result: { ok: false, kind: "binary_missing", detail: this.lastError } };
    }
  }


  private async directoryExists(path: string): Promise<boolean> {
    try { return (await stat(path)).isDirectory(); } catch { return false; }
  }

  /** CBM's name for this workspace's indexed project, or `null` when the index is unavailable or the binary cannot answer. */
  async indexedProjectName(project: CodeGraphProject, binaryPath: string): Promise<string | null> {
    if (!validateManagedProjectPath(project, this.deps.paths).ok) return null;
    try {
      return await this.validateIndex(project, binaryPath);
    } catch {
      return null;
    }
  }

  /**
   * Best-effort index line for `/wb:code-graph status`: `ready (<project name>)`, or `null` when the
   * index is unavailable — status must never fail. Node and edge counts are not read: the shape of
   * the real `index_status` output is not verified offline.
   */
  async fetchIndexSummary(project: CodeGraphProject, binaryPath: string): Promise<string | null> {
    const name = await this.indexedProjectName(project, binaryPath);
    return name === null ? null : `ready (${name})`;
  }

  /** Build a status report without side effects (no download/index). */
  async buildStatusReport(input: {
    project: CodeGraphProject;
    platform: string;
    manifestVersion?: string;
    installedVersion?: string;
    /** False when a valid workspace marker references different binary identity. */
    binaryCompatible?: boolean;
    indexSummary?: string;
  }): Promise<CodeGraphStatusReport> {
    const { project } = input;
    const pathValidation = validateManagedProjectPath(project, this.deps.paths);
    if (!pathValidation.ok) {
      return {
        kind: "corrupt",
        workspacePath: project.projectPath,
        identifier: project.identifier,
        projectDirectory: project.directory,
        platform: input.platform,
        mcpRegistered: false,
        watcher: "unknown",
        lastError: pathValidation.detail,
        recovery: "Repair the managed Code Graph path manually; refusing to follow a symlinked or escaped path.",
        ...(input.manifestVersion ? { manifestVersion: input.manifestVersion } : {}),
        ...(input.installedVersion ? { installedVersion: input.installedVersion } : {}),
      };
    }
    const validation = await validateCodeGraphState(project);
    const kind: CodeGraphStatusReport["kind"] = validation.ok && input.binaryCompatible === false
        ? "upgrade_pending"
        : validation.ok
          ? "enabled"
          : validation.problem === "missing"
          ? "off"
          : "corrupt";
    return {
      kind,
      workspacePath: project.projectPath,
      identifier: project.identifier,
      projectDirectory: project.directory,
      platform: input.platform,
      mcpRegistered: this.mcpRegistered && this.registeredProject === project.directory,
      watcher: isGitWorkspace(project.projectPath) ? "git" : "disabled_non_git",
      lastError: validation.ok ? this.lastError ?? undefined : validation.detail,
      recovery: validation.ok && input.binaryCompatible === false
          ? otherVersionMessage(TOOL_NAMES.codeGraph)
          : validation.ok
            ? undefined
            : validation.problem === "missing"
            ? "Run /wb:code-graph on to enable code graph for this workspace."
            : "Run /wb:code-graph off to clear the invalid state, then /wb:code-graph on.",
      ...(input.manifestVersion ? { manifestVersion: input.manifestVersion } : {}),
      ...(input.installedVersion ? { installedVersion: input.installedVersion } : {}),
      ...(input.indexSummary ? { indexSummary: input.indexSummary } : {}),
    };
  }
}
