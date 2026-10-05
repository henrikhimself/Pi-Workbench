import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, open, rename as renamePath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import { ensureManagedPython } from "./proxy-manager.js";
import { hasMemoryStore, resolveMemoryStore, type MemoryStore } from "./memory-config.js";

export const MEMORY_SERVER_NAME = "headroom-memory";

const MEMORY_BUNDLE_SCRIPT = fileURLToPath(new URL("./memory-bundle.py", import.meta.url));
const BUNDLE_RECORD_DIRECTORIES = ["memories", "entities", "relationships"] as const;
const BUNDLE_MANIFEST = "manifest.json";

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
export type RenameOperation = (oldPath: string, newPath: string) => Promise<void>;

class SwapRecoveryError extends Error {}

export interface MemoryManagerOptions {
  cwd?: string;
  root?: string;
  userId?: string;
  exportPath?: string;
  ensurePython?: (onStatus: StatusReporter) => Promise<string | null>;
  runProcess?: ProcessRunner;
  rename?: RenameOperation;
}

/** Owns one project's local ONNX Memory setup and MCP configuration. */
export class MemoryManager {
  readonly store: MemoryStore;
  private readonly ensurePython: (onStatus: StatusReporter) => Promise<string | null>;
  private readonly runProcess: ProcessRunner;
  private readonly rename: RenameOperation;

  constructor(options?: MemoryManagerOptions) {
    this.store = resolveMemoryStore(options);
    this.ensurePython = options?.ensurePython ?? ensureManagedPython;
    this.runProcess = options?.runProcess ?? runProcess;
    this.rename = options?.rename ?? renamePath;
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

  /** Resolve managed Python without initializing Memory models or touching store data. */
  async ensureRuntime(onStatus: StatusReporter): Promise<string | null> {
    return this.ensurePython(onStatus);
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

  /** Export current configured namespace into a staged canonical JSON bundle. */
  async exportBundle(python: string): Promise<string> {
    const bundle = this.requireExportDirectory();
    const parent = dirname(bundle);
    await mkdir(parent, { recursive: true });
    const stagingRoot = await mkdtemp(join(parent, ".pi-workbench-memory-export-"));
    const stagedBundle = join(stagingRoot, "bundle");
    const generatedBundle = join(stagingRoot, "generated");
    const backupDirectory = `${bundle}.backup-${utcTimestamp()}`;
    let preserveStaging = false;
    try {
      if (existsSync(bundle)) await cp(bundle, stagedBundle, { recursive: true, force: true });
      else await mkdir(stagedBundle);

      const result = await this.runBundle(python, "export", this.store.directory, generatedBundle);
      await this.replaceOwnedBundleEntries(stagedBundle, generatedBundle);
      await this.swapStagedDirectory(stagedBundle, bundle, backupDirectory, false);
      return result;
    } catch (error) {
      preserveStaging = error instanceof SwapRecoveryError;
      throw error;
    } finally {
      if (!preserveStaging) await rm(stagingRoot, { recursive: true, force: true });
    }
  }

  /** Read current namespace without search-side access telemetry. */
  async showBundle(python: string): Promise<string> {
    return this.runBundle(python, "show", this.store.directory, this.store.directory);
  }

  /** Merge bundle objects into staged current store; retain local-only records. */
  async mergeBundle(python: string): Promise<string> {
    const bundle = this.requireExportDirectory();
    const parent = dirname(this.store.directory);
    const staging = await mkdtemp(join(parent, ".pi-workbench-memory-merge-"));
    const stagedStore = join(staging, "store");
    const backupDirectory = `${this.store.directory}.merge-backup-${utcTimestamp()}`;
    let preserveStaging = false;
    try {
      await this.runBundle(python, "validate", this.store.directory, bundle);
      await cp(this.store.directory, stagedStore, { recursive: true, force: true });
      const result = await this.runBundle(python, "merge", stagedStore, bundle);
      await this.swapStagedDirectory(stagedStore, this.store.directory, backupDirectory, false);
      return result;
    } catch (error) {
      preserveStaging = error instanceof SwapRecoveryError;
      throw error;
    } finally {
      if (!preserveStaging) await rm(staging, { recursive: true, force: true });
    }
  }

  /** Validate bundle, stage namespace replacement, retain current store as UTC backup, then swap. */
  async importBundle(python: string): Promise<{ result: string; backupDirectory: string }> {
    const bundle = this.requireExportDirectory();
    const parent = dirname(this.store.directory);
    const staging = await mkdtemp(join(parent, ".pi-workbench-memory-import-"));
    const stagedStore = join(staging, "store");
    const backupDirectory = `${this.store.directory}.backup-${utcTimestamp()}`;
    let preserveStaging = false;
    try {
      await this.runBundle(python, "validate", this.store.directory, bundle);
      await cp(this.store.directory, stagedStore, { recursive: true, force: true });
      const result = await this.runBundle(python, "replace", stagedStore, bundle);
      await this.swapStagedDirectory(stagedStore, this.store.directory, backupDirectory, true);
      return { result, backupDirectory };
    } catch (error) {
      preserveStaging = error instanceof SwapRecoveryError;
      throw error;
    } finally {
      if (!preserveStaging) await rm(staging, { recursive: true, force: true });
    }
  }

  private async replaceOwnedBundleEntries(stagedBundle: string, generatedBundle: string): Promise<void> {
    for (const directory of BUNDLE_RECORD_DIRECTORIES) {
      await rm(join(stagedBundle, directory), { recursive: true, force: true });
      await this.rename(join(generatedBundle, directory), join(stagedBundle, directory));
    }
    await rm(join(stagedBundle, BUNDLE_MANIFEST), { recursive: true, force: true });
    await this.rename(join(generatedBundle, BUNDLE_MANIFEST), join(stagedBundle, BUNDLE_MANIFEST));
  }

  /** Swap only same-parent directories. Original remains at backup until replacement is installed. */
  private async swapStagedDirectory(
    stagedDirectory: string,
    destination: string,
    backupDirectory: string,
    retainBackup: boolean,
  ): Promise<void> {
    if (!existsSync(destination)) {
      await this.rename(stagedDirectory, destination);
      return;
    }
    if (existsSync(backupDirectory)) {
      throw new Error(`Memory swap backup already exists: ${backupDirectory}`);
    }

    await this.rename(destination, backupDirectory);
    try {
      await this.rename(stagedDirectory, destination);
    } catch (installError) {
      try {
        await this.rename(backupDirectory, destination);
      } catch (restoreError) {
        const installMessage = installError instanceof Error ? installError.message : String(installError);
        const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
        throw new SwapRecoveryError(
          `Memory replacement failed (${installMessage}); original remains at ${backupDirectory}. ` +
          `Automatic restore failed: ${restoreMessage}`,
        );
      }
      throw installError;
    }

    if (!retainBackup) {
      try {
        await rm(backupDirectory, { recursive: true, force: true });
      } catch {
        // Replacement is committed. Leave backup for manual recovery/cleanup.
      }
    }
  }

  private requireExportDirectory(): string {
    if (!this.store.exportDirectory) throw new Error("headroom.json memory.export must be configured for this operation");
    return this.store.exportDirectory;
  }

  private async runBundle(python: string, operation: "export" | "validate" | "replace" | "merge" | "show", store: string, bundle: string): Promise<string> {
    return runProcessOutput(python, [MEMORY_BUNDLE_SCRIPT, operation, "--store", store, "--bundle", bundle, "--namespace", this.store.userId], {
      env: createMcpEnvironment(),
      timeoutMs: 180_000,
    });
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

function utcTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function runProcessOutput(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    execFile(command, args, { env: options.env, timeout: options.timeoutMs }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolvePromise(stdout.trim());
    });
  });
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
