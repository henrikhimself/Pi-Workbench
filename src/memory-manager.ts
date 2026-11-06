import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, open, readFile, readdir, rename as renamePath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ManagedHeadroomRuntime, DEFAULT_HEADROOM_RUNTIME, getHeadroomAiVersion, type ManagedHeadroomDescriptor } from "./headroom-runtime.js";
import { acquireManagedLock, activeConsumers, assertNoSymlink, ensurePrivateDirectory, publishJson, requireDiskSpace, treeBytes } from "./managed-lifecycle.js";
import { prepareHeadroomStore, HEADROOM_STORE_MARKER, type HeadroomStoreIdentity } from "./headroom-state.js";
import { fileURLToPath } from "node:url";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import { ensureManagedPython } from "./proxy-manager.js";
import { hasMemoryStore, resolveMemoryStore, type MemoryStore } from "./memory-config.js";

export const MEMORY_SERVER_NAME = "headroom-memory";

const MEMORY_BUNDLE_SCRIPT = fileURLToPath(new URL("./memory-bundle.py", import.meta.url));
const MCP_LAUNCHER = fileURLToPath(new URL("./managed-mcp.mjs", import.meta.url));
const BUNDLE_RECORD_DIRECTORIES = ["memories", "entities", "relationships"] as const;
const BUNDLE_MANIFEST = "manifest.json";

const ONNX_PREFLIGHT = [
  "import asyncio,json,hashlib",
  "from pathlib import Path",
  "from headroom.memory.adapters.embedders import OnnxLocalEmbedder",
  "def digest(path):",
  "    result = hashlib.sha256()",
  "    with open(path, 'rb') as stream:",
  "        for chunk in iter(lambda: stream.read(1024*1024), b''):",
  "            result.update(chunk)",
  "    return result.hexdigest()",
  "async def main():",
  "    embedder = OnnxLocalEmbedder()",
  "    embedding = await embedder.embed('Headroom Memory ONNX preflight')",
  "    assert embedder._session.get_providers() == ['CPUExecutionProvider']",
  "    assert len(embedding) == 384",
  "    from headroom.onnx_runtime import hf_hub_download_local_first",
  "    model_path = embedder._session._model_path",
  "    tokenizer_path = hf_hub_download_local_first(embedder.ONNX_REPO, 'tokenizer.json')",
  "    print(json.dumps({'modelRevision':Path(model_path).parent.name,'modelSha256':digest(model_path),'tokenizerSha256':digest(tokenizer_path)}))",
  "    await embedder.close()",
  "asyncio.run(main())",
].join("\n");

export type StatusReporter = (message: string) => void;
export type ProcessRunner = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal },
) => Promise<void | string>;
export type RenameOperation = (oldPath: string, newPath: string) => Promise<void>;

class SwapRecoveryError extends Error {}

export interface MemoryManagerOptions {
  cwd?: string;
  root?: string;
  defaultRoot?: string;
  runtime?: ManagedHeadroomRuntime;
  signal?: AbortSignal;
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
  private readonly runtime: ManagedHeadroomRuntime;
  private readonly signal?: AbortSignal;
  private descriptor: ManagedHeadroomDescriptor | null = null;
  private identity: HeadroomStoreIdentity | null = null;

  constructor(options?: MemoryManagerOptions) {
    this.store = resolveMemoryStore(options);
    this.runtime = options?.runtime ?? DEFAULT_HEADROOM_RUNTIME;
    this.signal = options?.signal ?? this.runtime.signal;
    this.ensurePython = options?.ensurePython ?? (async (onStatus) => {
      this.descriptor = await this.runtime.ensure(onStatus);
      return this.descriptor?.python ?? null;
    });
    this.runProcess = options?.runProcess ?? runProcess;
    this.rename = options?.rename ?? renamePath;
  }

  get enabled(): boolean {
    return hasMemoryStore(this.store);
  }

  private get coordinationRoot(): string { return join(this.store.root, "coordination"); }
  private get leaseRoot(): string { return join(this.store.root, "consumers", this.store.identifier); }
  private get pendingPath(): string { return join(this.coordinationRoot, this.store.identifier + ".pending.json"); }
  get recoveryPending(): boolean { return existsSync(this.pendingPath); }
  private async expectedIdentity(): Promise<HeadroomStoreIdentity> {
    const version = await getHeadroomAiVersion();
    if (!version) throw new Error("Missing pinned Memory package identity");
    if (this.identity?.headroomVersion === version) return this.identity;
    const base: HeadroomStoreIdentity = { schema: 1, layout: 1, headroomVersion: version, kind: "memory",
      model: "Qdrant/all-MiniLM-L6-v2-onnx", dimensions: 384 };
    const marker = join(this.store.directory, HEADROOM_STORE_MARKER); await assertNoSymlink(marker);
    try {
      const owned = JSON.parse(await readFile(marker, "utf8"));
      if (owned.modelSha256 !== undefined) {
        if (!/^[0-9a-f]{64}$/.test(owned.modelSha256) || !/^[0-9a-f]{64}$/.test(owned.tokenizerSha256) || !/^[0-9a-f]{40,64}$/.test(owned.modelRevision)) throw new Error("Invalid stored embedding identity");
        Object.assign(base, { modelSha256: owned.modelSha256, tokenizerSha256: owned.tokenizerSha256, modelRevision: owned.modelRevision });
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return this.identity = base;
  }
  private async transaction<T>(action: () => Promise<T>, options: { create?: boolean; readOnly?: boolean } = {}): Promise<T> {
    this.signal?.throwIfAborted();
    await this.ensureRoot();
    const acquired = this.descriptor ? await this.runtime.acquire("memory-operation:" + this.store.identifier, () => {}) : null;
    if (this.descriptor && !acquired) throw new Error("Memory runtime activation deferred");
    try {
      const release = await acquireManagedLock(this.coordinationRoot, this.store.identifier);
      try {
        if (this.recoveryPending) throw new Error(`Incomplete Memory publication; preserve recovery paths in ${this.pendingPath}`);
        const deadline = Date.now() + 2000;
        while ((await activeConsumers(this.leaseRoot)).length) {
          if (Date.now() >= deadline) throw new Error("Memory store busy in another/closing session; operation deferred");
          await new Promise(done => setTimeout(done, 50));
        }
        if (!options.create && !this.enabled) throw new Error("Memory is not opted in for this fresh namespace");
        await prepareHeadroomStore(this.store.directory, await this.expectedIdentity());
        const bytes = await treeBytes(this.store.directory);
        if (!options.readOnly) await requireDiskSpace(this.store.root, bytes * 3 + 32 * 1024 * 1024);
        this.signal?.throwIfAborted();
        return await action();
      } finally { await release(); }
    } finally { await acquired?.lease.release(); }
  }

  /** Prepare configured/default Memory root for explicit use or opted-in restore. */
  async ensureRoot(): Promise<void> {
    await ensurePrivateDirectory(this.store.root);
    if (this.recoveryPending) throw new Error(`Incomplete Memory publication; preserve recovery paths in ${this.pendingPath}`);
  }

  /** Create durable project opt-in only after ONNX runtime is ready. */
  async createStore(): Promise<void> {
    await this.transaction(async () => {
      await assertNoSymlink(this.store.databasePath);
      const handle = await open(this.store.databasePath, "a", 0o600); await handle.close();
    }, { create: true });
  }

  /** Remove only calculated per-project directory. Never remove configurable root. */
  async deleteStore(): Promise<void> {
    await this.transaction(() => rm(this.store.directory, { recursive: true, force: true }));
  }

  /** Resolve managed Python without initializing Memory models or touching store data. */
  async ensureRuntime(onStatus: StatusReporter): Promise<string | null> {
    this.signal?.throwIfAborted();
    const python = await this.ensurePython(onStatus);
    this.signal?.throwIfAborted();
    return python;
  }

  /** Ensure managed Python and real CPU ONNX inference. Model download is allowed here. */
  async prepare(onStatus: StatusReporter): Promise<string | null> {
    let acquired: Awaited<ReturnType<ManagedHeadroomRuntime["acquire"]>> = null;
    try {
      this.signal?.throwIfAborted();
      await this.ensureRoot();
      const release = await acquireManagedLock(this.coordinationRoot, this.store.identifier);
      try { await prepareHeadroomStore(this.store.directory, await this.expectedIdentity()); }
      finally { await release(); }
      const python = await this.ensurePython(onStatus);
      if (!python) return null;
      if (this.descriptor) {
        acquired = await this.runtime.acquire("memory-preflight:" + this.store.identifier, onStatus);
        if (!acquired) return null;
      }
      onStatus("Preparing Headroom Memory ONNX model...");
      const output = await this.runProcess(python, ["-c", ONNX_PREFLIGHT], {
        env: createPreflightEnvironment(this.runtime.environment()), timeoutMs: 180_000, signal: this.signal,
      });
      this.signal?.throwIfAborted();
      if (typeof output === "string") {
        const model = JSON.parse(output);
        if (!/^[0-9a-f]{64}$/.test(model.modelSha256) || !/^[0-9a-f]{64}$/.test(model.tokenizerSha256) || !/^[0-9a-f]{40,64}$/.test(model.modelRevision)) throw new Error("Missing verified embedding asset identity");
        const identity = { ...await this.expectedIdentity(), modelSha256: model.modelSha256,
          tokenizerSha256: model.tokenizerSha256, modelRevision: model.modelRevision };
        const release = await acquireManagedLock(this.coordinationRoot, this.store.identifier);
        try {
          if ((await readdir(this.store.directory)).every(name => name === HEADROOM_STORE_MARKER)) {
            await publishJson(this.store.directory, join(this.store.directory, HEADROOM_STORE_MARKER), identity);
          } else await prepareHeadroomStore(this.store.directory, identity);
          this.identity = identity;
        } finally { await release(); }
      }
      return python;
    } catch (error) {
      onStatus(`Headroom Memory ONNX preflight failed: ${error instanceof Error ? error.message : String(error)}`); return null;
    } finally { await acquired?.lease.release(); }
  }

  /** Export current configured namespace into a staged canonical JSON bundle. */
  async exportBundle(python: string): Promise<string> {
    return this.transaction(() => this.exportBundleUnlocked(python), { readOnly: false });
  }
  private async exportBundleUnlocked(python: string): Promise<string> {
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
      await this.swapStagedDirectory(stagedBundle, bundle, backupDirectory);
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
    return this.transaction(() => this.showBundleUnlocked(python), { readOnly: true });
  }
  private async showBundleUnlocked(python: string): Promise<string> {
    return this.runBundle(python, "show", this.store.directory, this.store.directory);
  }

  /** Merge bundle objects into staged current store; retain local-only records. */
  async mergeBundle(python: string): Promise<string> {
    return this.transaction(() => this.mergeBundleUnlocked(python), { readOnly: false });
  }
  private async mergeBundleUnlocked(python: string): Promise<string> {
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
      await this.swapStagedDirectory(stagedStore, this.store.directory, backupDirectory);
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
    return this.transaction(() => this.importBundleUnlocked(python));
  }
  private async importBundleUnlocked(python: string): Promise<{ result: string; backupDirectory: string }> {
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
      await this.swapStagedDirectory(stagedStore, this.store.directory, backupDirectory);
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
  ): Promise<void> {
    if (!existsSync(destination)) {
      await this.rename(stagedDirectory, destination);
      return;
    }
    if (existsSync(backupDirectory)) {
      throw new Error(`Memory swap backup already exists: ${backupDirectory}`);
    }

    this.signal?.throwIfAborted();
    const physicalStore = destination === this.store.directory;
    if (physicalStore) await publishJson(this.coordinationRoot, this.pendingPath, {
      schema: 1, live: destination, staging: stagedDirectory, backup: backupDirectory,
    });
    try { await this.rename(destination, backupDirectory); }
    catch (error) { if (physicalStore) await rm(this.pendingPath, { force: true }); throw error; }
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
      if (physicalStore) await rm(this.pendingPath, { force: true });
      throw installError;
    }
    if (physicalStore) await rm(this.pendingPath, { force: true });

    // Every published backup is retained until explicit manual cleanup.
  }

  private requireExportDirectory(): string {
    if (!this.store.exportDirectory) throw new Error("headroom.json memory.export must be configured for this operation");
    return this.store.exportDirectory;
  }

  private async runBundle(python: string, operation: "export" | "validate" | "replace" | "merge" | "show", store: string, bundle: string): Promise<string> {
    return runProcessOutput(python, [MEMORY_BUNDLE_SCRIPT, operation, "--store", store, "--bundle", bundle, "--namespace", this.store.userId], {
      env: createMcpEnvironment(this.runtime.environment()),
      timeoutMs: 180_000, signal: this.signal,
    });
  }

  getMcpConfig(python: string): McpServerConfig {
    this.signal?.throwIfAborted();
    if (!this.identity) throw new Error("Memory must be prepared before MCP registration");
    const spec = {
      schema: 1, command: python,
      args: ["-m", "headroom.memory.mcp_server", "--db", this.store.databasePath, "--user", this.store.userId],
      cwd: this.store.projectPath, installRoot: this.descriptor?.slot ?? dirname(python),
      coordinationRoot: this.coordinationRoot, lockName: this.store.identifier,
      leaseRoot: this.leaseRoot, resource: this.store.directory,
      markerPath: join(this.store.directory, HEADROOM_STORE_MARKER), expectedMarker: this.identity,
      ...(this.descriptor ? { runtime: {
        root: this.runtime.root, coordinationRoot: join(this.runtime.root, "coordination"),
        selectionPath: this.runtime.selectionPath, slot: this.descriptor.slot,
        version: this.descriptor.version, leaseRoot: this.runtime.leaseRoot,
      } } : {}),
    };
    return {
      command: process.execPath, args: [MCP_LAUNCHER, JSON.stringify(spec)],
      cwd: this.store.projectPath, env: createMcpEnvironment(this.runtime.environment()),
      exposure: "direct", timeout: 60,
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
  options: { env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal },
): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    execFile(command, args, { env: options.env, timeout: options.timeoutMs, signal: options.signal }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolvePromise(stdout.trim());
    });
  });
}

async function runProcess(command: string, args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    execFile(command, args, { env: options.env, timeout: options.timeoutMs, signal: options.signal, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolvePromise(stdout.trim());
    });
  });
}
