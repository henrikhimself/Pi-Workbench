import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { watch as watchPath } from "node:fs";
import { basename, join } from "node:path";
import { chmod, lstat, mkdir, open, rm, rename as renamePath, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import {
  detectCodeGraphPlatform,
  installedBinaryPath,
  readInstalledRecord,
  verifyBinaryVersion,
  type InstalledBinary,
  type StatusReporter,
} from "./code-graph-installer.js";
import {
  createCodeGraphState,
  isGitWorkspace,
  validateManagedProjectPath,
  validateCodeGraphState,
  writeCodeGraphStateAtomic,
  type CodeGraphProject,
  type CodeGraphState,
  type CodeGraphStatusReport,
} from "./code-graph-config.js";
import type { WorkbenchPaths } from "./paths.js";

/**
 * Extension-owned lifecycle for the standalone codebase-memory-mcp (CBM)
 * service: safe child environment, CBM configuration, initial index, MCP
 * handshake validation, direct registration, process ownership, and
 * activation/restore transactions.
 *
 * Design rules (see PLAN-A.md):
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
export const CODE_GRAPH_MCP_TIMEOUT_SECONDS = 60;

/**
 * `tools/list` count for the approved `codebase-memory-mcp` `v0.8.1`
 * binary. Verified in the compatibility spike (release commit
 * `f0c9be19c5d74b84f418d807bfdce7b5d6a261ff`); a mismatch means the asset
 * is not what the manifest describes and activation must not proceed.
 */
export const CODE_GRAPH_EXPECTED_TOOL_COUNT = 14;

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
export const CODE_GRAPH_GUIDANCE_MESSAGE =
  "Code Graph is enabled for this workspace. Use the codebase-memory-mcp " +
  "tools (search_graph, trace_path, get_architecture, get_code_context, " +
  "get_impact, query_graph) for structural code questions — cross-file " +
  "relationships, call paths, blast radius, architecture overview. Verify " +
  "structural results against the actual source before relying on them for " +
  "edits. For exact literal matches use standard search instead.";

// ─── Process execution ────────────────────────────────────────────────

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Exact-argument, no-shell process runner. */
export type ProcessRunner = (
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBuffer?: number },
) => Promise<ProcessResult>;

export function defaultProcessRunner(): ProcessRunner {
  return (command, args, options) =>
    new Promise<ProcessResult>((resolvePromise) => {
      execFile(
        command,
        args,
        {
          cwd: options.cwd,
          env: options.env,
          timeout: options.timeoutMs ?? 30_000,
          maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          let exitCode = 0;
          if (error) {
            const code = (error as NodeJS.ErrnoException).code;
            exitCode = typeof code === "number" ? code : 1;
          }
          resolvePromise({ exitCode, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
}

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
  expectedToolCount: number;
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

      const kill = (): Promise<void> =>
        new Promise((resolveKill) => {
          const current = child;
          if (!current || current.exitCode !== null || current.killed) {
            resolveKill();
            return;
          }
          let finished = false;
          const finish = () => {
            if (!finished) {
              finished = true;
              resolveKill();
            }
          };
          const escalate = setTimeout(() => {
            try {
              current.kill("SIGKILL");
            } catch {
              finish();
            }
          }, options.killGraceMs ?? 5_000);
          current.once("close", () => {
            clearTimeout(escalate);
            finish();
          });
          try {
            current.kill("SIGTERM");
          } catch {
            clearTimeout(escalate);
            finish();
          }
        });

      const settle = async (result: McpHandshakeResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        await kill();
        resolvePromise(result);
      };

      const timer = setTimeout(() => {
        void settle({ ok: false, detail: `MCP handshake timed out after ${options.timeoutMs} ms` });
      }, options.timeoutMs);

      try {
        child = spawn(options.command, options.args, {
          cwd: options.cwd,
          env: options.env,
          stdio: ["pipe", "pipe", "pipe"],
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
          const message = parsed as { id?: unknown; result?: unknown; error?: { code?: number; message?: string } };
          if (typeof message.id === "number") respond(message.id, message);
        }
      });
      currentChild.stderr.on("data", (chunk: Buffer) => {
        stderrText += chunk.toString("utf8");
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
          const init = initResponse.result as { protocolVersion?: unknown };
          if (init.protocolVersion !== CODE_GRAPH_MCP_PROTOCOL_VERSION) {
            void settle({
              ok: false,
              detail: `MCP protocol mismatch: server responded ${String(init.protocolVersion)}, expected ${CODE_GRAPH_MCP_PROTOCOL_VERSION}`,
            });
            return;
          }

          // 2. notifications/initialized (MCP lifecycle), then tools/list.
          sendJsonrpc(currentChild, { jsonrpc: "2.0", method: "notifications/initialized" });
          const toolsResponse = await new Promise<JsonRpcResponse>((resolveWaiter) => {
            pending.set(2, (response) => resolveWaiter(response));
            sendJsonrpc(currentChild, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
          });
          if (settled) return;
          if (toolsResponse.error) {
            void settle({
              ok: false,
              detail: `MCP tools/list failed: ${String(toolsResponse.error.code ?? "")} ${String(toolsResponse.error.message ?? "")}`.trim(),
            });
            return;
          }
          if (!cleanStdout) {
            void settle({ ok: false, detail: "MCP stdout contained non-JSON-RPC data; refusing to register a protocol-unsafe server" });
            return;
          }
          const toolsResult = toolsResponse.result as { tools?: Array<{ name?: unknown }> } | undefined;
          const tools = Array.isArray(toolsResult?.tools)
            ? toolsResult.tools.map((tool) => (typeof tool.name === "string" ? tool.name : "")).filter((name) => name !== "")
            : [];
          if (tools.length !== options.expectedToolCount) {
            void settle({
              ok: false,
              detail: `MCP tool count mismatch: got ${tools.length}, expected ${options.expectedToolCount}`,
            });
            return;
          }
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
export async function ensureCurlDenyShim(shimPath: string): Promise<void> {
  await mkdir(dirname(shimPath), { recursive: true });
  const tempPath = `${shimPath}.${process.pid}-${Date.now().toString(36)}.tmp`;
  const handle = await open(tempPath, "w");
  try {
    await handle.writeFile(CURL_DENY_SHIM_SCRIPT, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(tempPath, 0o755).catch(() => {});
  await renamePath(tempPath, shimPath);
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
  source?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const source = options.source ?? process.env;
  return {
    PATH: `${curlShimDirectory(options.shimPath)}:${source.PATH || "/usr/local/bin:/usr/bin:/bin"}`,
    HOME: source.HOME || "/tmp",
    LANG: "C.UTF-8",
    CBM_CACHE_DIR: options.projectDirectory,
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

function failureDetail(what: string, result: ProcessResult): Error {
  const detail = (result.stderr || result.stdout).trim().slice(0, 300);
  return new Error(`codebase-memory-mcp ${what} failed (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`);
}

// ─── Manager ──────────────────────────────────────────────────────────

export interface CodeGraphManagerDeps {
  paths: WorkbenchPaths;
  /** Install/update decision for the managed binary (packaged asset only). */
  ensureInstalled: (onStatus: StatusReporter) => Promise<InstalledBinary>;
  onStatus?: StatusReporter;
  runProcess?: ProcessRunner;
  runMcpHandshake?: McpHandshakeRunner;
  registerMcp?: (name: string, config: McpServerConfig) => void;
  unregisterMcp?: (name: string) => void;
}

export type CodeGraphResult =
  | { ok: true; state: CodeGraphState; binaryPath: string; tools: string[]; alreadyOn: boolean }
  | {
      ok: false;
      kind: CodeGraphStatusReport["kind"];
      detail: string;
      registered: false;
    };

export class CodeGraphManager {
  private readonly deps: Omit<CodeGraphManagerDeps, "runProcess" | "runMcpHandshake"> & {
    runProcess: ProcessRunner;
    runMcpHandshake: McpHandshakeRunner;
  };
  private registeredProject: string | null = null;
  private mcpRegistered = false;
  private lastError: string | null = null;

  constructor(deps: CodeGraphManagerDeps) {
    this.deps = {
      ...deps,
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

  get lastFailure(): string | null {
    return this.lastError;
  }

  private report(message: string): void {
    this.deps.onStatus?.(message);
  }

  /** Minimal env + workspace CWD for all owned CBM child operations. */
  private createEnv(project: CodeGraphProject): Record<string, string> {
    return createCbmEnvironment({
      projectDirectory: project.directory,
      shimPath: this.deps.paths.codeGraphCurlShim,
    });
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
  ): Promise<ProcessResult> {
    this.assertProjectPathSafe(project);
    const result = await this.deps.runProcess(binaryPath, args, {
      cwd: project.projectPath,
      env: this.createEnv(project),
      timeoutMs,
    });
    if (result.exitCode !== 0) throw failureDetail(what, result);
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

  /** `cli index_repository {"repo_path":<absolute workspace>}`. */
  private async runIndexRepository(project: CodeGraphProject, binaryPath: string): Promise<string> {
    // JSON.stringify is the only argument encoding; the workspace path is
    // always a JSON value, never shell syntax.
    const args = ["cli", "index_repository", JSON.stringify({ repo_path: project.projectPath })];
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
      const listResult = await this.runCbm(project, binaryPath, ["cli", "list_projects"], CODE_GRAPH_TIMEOUTS.status, "list_projects");
      const list = parseJsonOutput(listResult.stdout, "list_projects");
      candidate = Array.isArray(list.projects)
        ? list.projects.find((value): value is string => typeof value === "string" && value.length > 0)
        : undefined;
      if (!candidate) throw new Error("index validation failed: list_projects returned no indexed project");
    }
    const statusResult = await this.runCbm(
      project, binaryPath, ["cli", "index_status", JSON.stringify({ project: candidate })], CODE_GRAPH_TIMEOUTS.status, "index_status",
    );
    const status = parseJsonOutput(statusResult.stdout, "index_status");
    if (status.status !== "ready") throw new Error(`index_status reported ${String(status.status)} for ${candidate}`);
    return candidate;
  }

  /** Validate the MCP handshake/tool list on a throwaway probe child. */
  private async validateHandshake(project: CodeGraphProject, binaryPath: string): Promise<string[]> {
    this.assertProjectPathSafe(project);
    const result = await this.deps.runMcpHandshake({
      command: binaryPath,
      args: [],
      cwd: project.projectPath,
      env: this.createEnv(project),
      timeoutMs: CODE_GRAPH_TIMEOUTS.handshake,
      expectedToolCount: CODE_GRAPH_EXPECTED_TOOL_COUNT,
    });
    if (!result.ok || !result.tools) {
      throw new Error(`MCP handshake validation failed: ${result.detail ?? "unknown error"}`);
    }
    return result.tools;
  }

  getMcpConfig(project: CodeGraphProject, binaryPath: string): McpServerConfig {
    return {
      command: binaryPath,
      args: [],
      cwd: project.projectPath,
      env: this.createEnv(project),
      exposure: "direct",
      timeout: CODE_GRAPH_MCP_TIMEOUT_SECONDS,
      description: "Code graph structural queries for the current workspace (extension-owned codebase-memory-mcp).",
    };
  }

  private registerMcp(project: CodeGraphProject, binaryPath: string): void {
    this.assertProjectPathSafe(project);
    if (!this.deps.registerMcp) {
      throw new Error("MCP registration is not available in this context");
    }
    if (this.mcpRegistered) {
      this.unregisterOwned();
    }
    this.deps.registerMcp(CODE_GRAPH_MCP_SERVER_NAME, this.getMcpConfig(project, binaryPath));
    this.mcpRegistered = true;
    this.registeredProject = project.directory;
  }

  /**
   * Release the extension-owned MCP registration for the tracked project.
   * Idempotent; only ever unregisters the server this manager registered.
   * Never kills external or unidentified CBM processes.
   */
  stop(project: CodeGraphProject): void {
    this.assertProjectPathSafe(project);
    if (!this.mcpRegistered || this.registeredProject !== project.directory) return;
    try {
      this.unregisterOwned();
    } catch (error) {
      this.lastError = `MCP unregister failed: ${error instanceof Error ? error.message : String(error)}`;
      throw error;
    }
  }

  private unregisterOwned(): void {
    if (this.deps.unregisterMcp) {
      this.deps.unregisterMcp(CODE_GRAPH_MCP_SERVER_NAME);
    }
    this.mcpRegistered = false;
    this.registeredProject = null;
  }

  /** Drop the MCP registration on session shutdown (owned state only). */
  shutdown(): void {
    if (!this.mcpRegistered) return;
    try {
      this.deps.unregisterMcp?.(CODE_GRAPH_MCP_SERVER_NAME);
    } finally {
      this.mcpRegistered = false;
      this.registeredProject = null;
    }
  }

  /**
   * `/wb:code-graph on` transaction:
   * 1. valid state → "already on": ensure registration, no reindex;
   * 2. corrupt state → diagnostic, no auto-repair;
   * 3. install/reuse asset → project directory → curl shim →
   *    auto_index → initial index → index validation → MCP handshake →
   *    publish state.json → register MCP.
   * Failures roll back the project directory created by this transaction
   * (never a pre-existing one) and leave the workspace off.
   */
  async activate(project: CodeGraphProject): Promise<CodeGraphResult> {
    const pathValidation = validateManagedProjectPath(project, this.deps.paths);
    if (!pathValidation.ok) {
      this.lastError = pathValidation.detail;
      return { ok: false, kind: "corrupt", detail: pathValidation.detail, registered: false };
    }
    const validation = validateCodeGraphState(project);
    if (validation.ok) {
      this.report(`Code graph already enabled for ${project.identifier}; ensuring MCP registration.`);
      const resolution = await this.resolveBinary(validation.state);
      if (resolution.status === "failed") return resolution.result;
      const compatibility = this.requireStateCompatibility(validation.state, resolution);
      if (compatibility) return compatibility;
      let tools: string[] | null;
      try {
        tools = await this.validateHandshake(project, resolution.path);
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        tools = null;
      }
      if (tools === null) {
        return { ok: false, kind: "mcp_failed", detail: this.lastError ?? "MCP handshake failed", registered: false };
      }
      this.registerMcp(project, resolution.path);
      this.lastError = null;
      return { ok: true, state: validation.state, binaryPath: resolution.path, tools, alreadyOn: true };
    }
    if (validation.problem !== "missing") {
      this.lastError = validation.detail;
      return {
        ok: false,
        kind: "corrupt",
        detail: `Existing code graph state is invalid (${validation.problem}); run /wb:code-graph off to clear it. ${validation.detail}`,
        registered: false,
      };
    }

    let directoryExistedBefore = false;
    try {
      directoryExistedBefore = await this.directoryExists(project.directory);
      this.report(`Installing/verifying codebase-memory-mcp binary for ${project.identifier}…`);
      const install = await this.deps.ensureInstalled((message) => this.report(message));
      this.report(`Preparing project data directory ${project.directory}…`);
      await mkdir(project.directory, { recursive: true });
      this.assertProjectPathSafe(project);
      await ensureCurlDenyShim(this.deps.paths.codeGraphCurlShim);
      this.report("Enabling codebase-memory-mcp auto-index for this workspace…");
      await this.setAutoIndexEnabled(project, install.path);
      this.report("Building initial code index (this can take a while on large repositories)…");
      const indexedProjectName = await this.runIndexRepository(project, install.path);
      this.report("Validating index...");
      const projectName = await this.validateIndex(project, install.path, indexedProjectName);
      this.report("Validating MCP handshake before activation…");
      const tools = await this.validateHandshake(project, install.path);
      this.assertProjectPathSafe(project);
      const state = createCodeGraphState(project, {
        version: install.version,
        resolvedUrl: install.resolvedUrl,
        sha256: install.sha256,
      });
      await writeCodeGraphStateAtomic(project, state);
      this.registerMcp(project, install.path);
      this.lastError = null;
      this.report(`Code graph enabled for ${project.identifier} (project ${projectName}).`);
      return { ok: true, state, binaryPath: install.path, tools, alreadyOn: false };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      // Roll back only what this transaction created; never delete a
      // pre-existing (possibly valid) project directory.
      if (!directoryExistedBefore && validateManagedProjectPath(project, this.deps.paths).ok) {
        await rm(project.directory, { recursive: true, force: true }).catch(() => {});
      }
      return { ok: false, kind: "mcp_failed", detail: this.lastError, registered: false };
    }
  }

  /** Rebuild an already-enabled workspace index without deleting its state. */
  async reindex(project: CodeGraphProject): Promise<CodeGraphResult> {
    const pathValidation = validateManagedProjectPath(project, this.deps.paths);
    if (!pathValidation.ok) return { ok: false, kind: "corrupt", detail: pathValidation.detail, registered: false };
    const validation = validateCodeGraphState(project);
    if (!validation.ok) {
      const detail = validation.problem === "missing"
        ? "Code graph is not enabled for this workspace; run /wb:code-graph on first."
        : `Code graph state is invalid (${validation.problem}); run /wb:code-graph off then on before reindexing. ${validation.detail}`;
      return { ok: false, kind: validation.problem === "missing" ? "off" : "corrupt", detail, registered: false };
    }
    const resolution = await this.resolveBinary(validation.state);
    if (resolution.status === "failed") return resolution.result;
    const compatibility = this.requireStateCompatibility(validation.state, resolution);
    if (compatibility) return compatibility;
    try {
      const indexedProjectName = await this.runIndexRepository(project, resolution.path);
      await this.validateIndex(project, resolution.path, indexedProjectName);
      this.lastError = null;
      return { ok: true, state: validation.state, binaryPath: resolution.path, tools: [], alreadyOn: true };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.lastError = detail;
      return { ok: false, kind: "mcp_failed", detail, registered: false };
    }
  }

  /**
   * Session-start restore.
   * - no state → off, without installer/CBM work;
   * - corrupt state → diagnostic, no auto-repair;
   * - valid state → update decision (fallback keeps the prior verified
   *   binary), `_config.db` must prove `auto_index=true`, handshake,
   *   registration.
   */
  async restore(project: CodeGraphProject): Promise<CodeGraphResult> {
    const pathValidation = validateManagedProjectPath(project, this.deps.paths);
    if (!pathValidation.ok) {
      this.lastError = pathValidation.detail;
      return { ok: false, kind: "corrupt", detail: pathValidation.detail, registered: false };
    }
    const validation = validateCodeGraphState(project);
    if (!validation.ok) {
      if (validation.problem === "missing") {
        return { ok: false, kind: "off", detail: "No code graph state for this workspace; feature stays off.", registered: false };
      }
      this.lastError = validation.detail;
      return {
        ok: false,
        kind: "corrupt",
        detail: `Code graph state is invalid (${validation.problem}); feature stays off. ${validation.detail}`,
        registered: false,
      };
    }

    // The owned env always prepends the curl-deny shim directory; make
    // sure the shim exists even when this session never ran activation.
    await ensureCurlDenyShim(this.deps.paths.codeGraphCurlShim);

    const resolution = await this.resolveBinary(validation.state);
    if (resolution.status === "failed") return resolution.result;
    const compatibility = this.requireStateCompatibility(validation.state, resolution);
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
        registered: false,
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
      return { ok: false, kind: "mcp_failed", detail: this.lastError ?? "MCP handshake failed", registered: false };
    }
    this.registerMcp(project, resolution.path);
    this.lastError = null;
    this.report(`Code graph restored for ${project.identifier}.`);
    return { ok: true, state: validation.state, binaryPath: resolution.path, tools, alreadyOn: true };
  }

  /**
   * Update decision with fallback: prefer the packaged asset result; if the
   * packaged install/update fails, retain and reuse the prior verified
   * binary at the same identity.
   */
  private requireStateCompatibility(
    state: CodeGraphState,
    binary: { version: string; resolvedUrl: string; sha256: string },
  ): Extract<CodeGraphResult, { ok: false }> | null {
    if (binary.version === state.version && binary.resolvedUrl === state.resolvedUrl && binary.sha256 === state.sha256) {
      return null;
    }
    const detail = `Managed binary ${binary.version} does not match workspace state ${state.version}. Existing index data was retained unchanged; an approved migration or explicit reindex workflow is required before Code Graph can start.`;
    this.lastError = detail;
    return { ok: false, kind: "upgrade_pending", detail, registered: false };
  }

  private async resolveBinary(
    state: CodeGraphState,
  ): Promise<{ status: "resolved"; path: string; version: string; resolvedUrl: string; sha256: string } | { status: "failed"; result: Extract<CodeGraphResult, { ok: false }> }> {
    try {
      const install = await this.deps.ensureInstalled((message) => this.report(message));
      return { status: "resolved", path: install.path, version: install.version, resolvedUrl: install.resolvedUrl, sha256: install.sha256 };
    } catch (error) {
      const fallback = await this.discoverPriorBinary(state.version);
      if (fallback && fallback.resolvedUrl === state.resolvedUrl && fallback.sha256 === state.sha256) {
        this.report(
          `Managed binary update failed (${error instanceof Error ? error.message : String(error)}); retaining verified ${fallback.version} binary.`,
        );
        return {
          status: "resolved",
          path: fallback.path,
          version: fallback.version,
          resolvedUrl: fallback.resolvedUrl,
          sha256: fallback.sha256,
        };
      }
      this.lastError = error instanceof Error ? error.message : String(error);
      return { status: "failed", result: { ok: false, kind: "binary_missing", detail: this.lastError, registered: false } };
    }
  }

  /** Locate and re-verify a prior fallback before it is ever executed. */
  private async discoverPriorBinary(version: string): Promise<{ path: string; version: string; resolvedUrl: string; sha256: string } | null> {
    const platform = detectCodeGraphPlatform({ os: process.platform, arch: process.arch });
    if (!platform) return null;
    const path = installedBinaryPath(this.deps.paths.codeGraphBin, version, platform);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o111) === 0) return null;
      const record = await readInstalledRecord(this.deps.paths.codeGraphBin, version, platform);
      if (!record || record.version !== version) return null;
      const verified = await verifyBinaryVersion(
        path,
        version,
        async (command, args, options) => {
          const result = await this.deps.runProcess(command, args, options);
          return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
        },
        { cwd: this.deps.paths.codeGraphRoot },
      );
      if (!verified.ok) return null;
      return { path, version, resolvedUrl: record.resolvedUrl, sha256: record.sha256 };
    } catch {
      return null;
    }
  }

  private async directoryExists(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Best-effort index freshness summary for `/wb:code-graph status`.
   * Returns a short human-readable line, or `null` when the index is
   * unavailable or the binary cannot answer — status must never fail.
   */
  async fetchIndexSummary(project: CodeGraphProject, binaryPath: string): Promise<string | null> {
    if (!validateManagedProjectPath(project, this.deps.paths).ok) return null;
    try {
      return await this.validateIndex(project, binaryPath);
    } catch {
      return null;
    }
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
    const validation = validateCodeGraphState(project);
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
          ? "Existing index data was retained. An approved migration or explicit reindex workflow is required before Code Graph can start."
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

/** Build the production manager from the packaged installer. */
export function createCodeGraphManager(options: {
  paths: WorkbenchPaths;
  installer: CodeGraphManagerDeps["ensureInstalled"];
  onStatus?: StatusReporter;
  registerMcp?: (name: string, config: McpServerConfig) => void;
  unregisterMcp?: (name: string) => void;
  runProcess?: ProcessRunner;
  runMcpHandshake?: McpHandshakeRunner;
}): CodeGraphManager {
  return new CodeGraphManager({
    paths: options.paths,
    ensureInstalled: options.installer,
    onStatus: options.onStatus,
    registerMcp: options.registerMcp,
    unregisterMcp: options.unregisterMcp,
    runProcess: options.runProcess,
    runMcpHandshake: options.runMcpHandshake,
  });
}
