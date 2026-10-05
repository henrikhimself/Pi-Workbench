import { execFile } from "node:child_process";
import { mkdir, open, rm } from "node:fs/promises";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import { ensureManagedPython } from "./proxy-manager.js";
import { hasMemoryStore, resolveMemoryStore, type MemoryStore } from "./memory-config.js";

export const MEMORY_SERVER_NAME = "headroom-memory";

const ONNX_PREFLIGHT = [
  "import asyncio",
  "from headroom.memory.adapters.embedders import OnnxLocalEmbedder",
  "async def main():",
  "    embedding = await OnnxLocalEmbedder().embed('Headroom Memory ONNX preflight')",
  "    assert len(embedding) == 384",
  "asyncio.run(main())",
].join("\n");

export type StatusReporter = (message: string) => void;
export type ProcessRunner = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<void>;

export interface MemoryManagerOptions {
  cwd?: string;
  root?: string;
  userId?: string;
  ensurePython?: (onStatus: StatusReporter) => Promise<string | null>;
  runProcess?: ProcessRunner;
}

/** Owns one project's local ONNX Memory setup and MCP configuration. */
export class MemoryManager {
  readonly store: MemoryStore;
  private readonly ensurePython: (onStatus: StatusReporter) => Promise<string | null>;
  private readonly runProcess: ProcessRunner;

  constructor(options?: MemoryManagerOptions) {
    this.store = resolveMemoryStore(options);
    this.ensurePython = options?.ensurePython ?? ensureManagedPython;
    this.runProcess = options?.runProcess ?? runProcess;
  }

  get enabled(): boolean {
    return hasMemoryStore(this.store);
  }

  /** Ensure configured/default Memory root exists even before project opt-in. */
  async ensureRoot(): Promise<void> {
    await mkdir(this.store.root, { recursive: true });
  }

  /** Create durable project opt-in only after ONNX runtime is ready. */
  async createStore(): Promise<void> {
    await this.ensureRoot();
    await mkdir(this.store.directory, { recursive: true });
    const handle = await open(this.store.databasePath, "a");
    await handle.close();
  }

  /** Remove only calculated per-project directory. Never remove configurable root. */
  async deleteStore(): Promise<void> {
    await rm(this.store.directory, { recursive: true, force: true });
  }

  /** Ensure managed Python and real CPU ONNX inference. Model download is allowed here. */
  async prepare(onStatus: StatusReporter): Promise<string | null> {
    const python = await this.ensurePython(onStatus);
    if (!python) return null;

    onStatus("Preparing Headroom Memory ONNX model...");
    try {
      await this.runProcess(python, ["-c", ONNX_PREFLIGHT], {
        env: createPreflightEnvironment(),
        timeoutMs: 180_000,
      });
      return python;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onStatus(`Headroom Memory ONNX preflight failed: ${message}`);
      return null;
    }
  }

  getMcpConfig(python: string): McpServerConfig {
    return {
      command: python,
      args: ["-m", "headroom.memory.mcp_server", "--db", this.store.databasePath, "--user", this.store.userId],
      cwd: this.store.projectPath,
      env: createMcpEnvironment(),
      exposure: "direct",
      timeout: 60,
      description: "Search and save project-scoped persistent Headroom Memory.",
    };
  }
}

/** ONNX bootstrap can download assets; ignore parent offline/MPS overrides. */
export function createPreflightEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  delete env.HEADROOM_EMBEDDER_RUNTIME;
  env.HF_HUB_OFFLINE = "0";
  env.TRANSFORMERS_OFFLINE = "0";
  return env;
}

/** MCP must use model cached by preflight and never select MPS/Torch runtime. */
export function createMcpEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  delete env.HEADROOM_EMBEDDER_RUNTIME;
  env.HF_HUB_OFFLINE = "1";
  env.TRANSFORMERS_OFFLINE = "1";
  return env;
}

async function runProcess(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    execFile(command, args, { env: options.env, timeout: options.timeoutMs }, (error, _stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolvePromise();
    });
  });
}
