import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WORKBENCH_PATHS, type WorkbenchPaths } from "./paths.js";
import {
  acquireManagedLock, activeConsumers, createConsumerLease, assertNoSymlink, assertWithin, type ConsumerLease,
  ensurePrivateDirectory, publishJson, requireDiskSpace,
} from "./managed-lifecycle.js";

export const MANAGED_CRYPTOGRAPHY_VERSION = "50.0.2";
export type RuntimeRunner = (command: string, args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }) => Promise<string>;
const runDefault: RuntimeRunner = (command, args, options) => new Promise((resolve, reject) => {
  execFile(command, args, { env: options.env, timeout: options.timeoutMs, signal: options.signal, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(String(stderr || error.message).slice(-2000)));
    else resolve(String(stdout));
  });
});
export async function getHeadroomAiVersion(): Promise<string | null> {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const version = manifest.dependencies?.["headroom-ai"];
  return typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version) ? version : null;
}
export async function findPython(): Promise<string | null> {
  for (const command of ["python3", "python"]) {
    try {
      const output = await runDefault(command, ["--version"], { env: process.env, timeoutMs: 5000 });
      const match = output.match(/Python (\d+)\.(\d+)/);
      if (match && (+match[1] > 3 || (+match[1] === 3 && +match[2] >= 10))) return command;
    } catch { /* Try next supported system interpreter, never an old managed venv. */ }
  }
  return null;
}
export interface ManagedHeadroomDescriptor {
  schema: 1;
  version: string;
  slot: string;
  python: string;
  cli: string;
  pythonIdentity: string;
  dependencyDigest: string;
  inventory: { name: string; version: string }[];
  embedding: { model: string; dimensions: number; provider: string };
}
export interface HeadroomRuntimeOptions {
  paths?: WorkbenchPaths;
  run?: RuntimeRunner;
  systemPython?: () => Promise<string | null>;
  requiredVersion?: string;
  publish?: typeof publishJson;
  signal?: AbortSignal;
}
const CHECK = [
  "import json,sys,platform",
  "from importlib.metadata import distributions,version",
  "from cryptography.hazmat.primitives.ciphers.aead import AESGCM",
  "import headroom.proxy.server,headroom.memory.mcp_server,onnxruntime,tokenizers,sqlite_vec,mcp",
  "print(json.dumps({'version':version('headroom-ai'),'python':platform.python_version(),'transport':version('cryptography'),'inventory':sorted([{'name':d.metadata['Name'],'version':d.version} for d in distributions()],key=lambda d:d['name'].lower())}))",
].join(";");
const forbidden = (name: string) => /torch|sentence[-_]transformers|tensorflow|nvidia|cupy|ollama/i.test(name);

/** One installation, separate service/model readiness. All slots stay at creation paths. */
export class ManagedHeadroomRuntime {
  readonly root: string;
  readonly selectionPath: string;
  readonly leaseRoot: string;
  private readonly run: RuntimeRunner;
  private readonly systemPython: () => Promise<string | null>;
  private readonly versionOverride?: string;
  private readonly publish: typeof publishJson;
  private cancellation?: AbortSignal;
  constructor(options: HeadroomRuntimeOptions = {}) {
    this.root = (options.paths ?? WORKBENCH_PATHS).headroomRoot;
    this.selectionPath = join(this.root, "selected.json");
    this.leaseRoot = join(this.root, "consumers");
    this.run = options.run ?? runDefault;
    this.systemPython = options.systemPython ?? findPython;
    this.versionOverride = options.requiredVersion;
    this.publish = options.publish ?? publishJson;
    this.cancellation = options.signal;
  }
  get signal(): AbortSignal | undefined { return this.cancellation; }
  setSignal(signal: AbortSignal): void { this.cancellation = signal; }
  private execute(command: string, args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<string> {
    this.cancellation?.throwIfAborted();
    return this.run(command, args, { ...options, signal: this.cancellation });
  }
  environment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "LANG", "LC_ALL", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS", "HF_TOKEN", "HEADROOM_OFFLINE"]) {
      if (source[key] !== undefined) env[key] = source[key];
    }
    return { ...env, PYTHONNOUSERSITE: "1", HOME: join(this.root, "home"),
      XDG_CACHE_HOME: join(this.root, "cache"), HF_HOME: join(this.root, "cache", "huggingface"),
      PIP_CACHE_DIR: join(this.root, "cache", "pip"),
      HEADROOM_CONFIG_DIR: join(this.root, "config"), HEADROOM_WORKSPACE_DIR: join(this.root, "proxy-state"),
      HEADROOM_CCR_SQLITE_PATH: join(this.root, "proxy-state", "ccr_store.db") };
  }
  private async prepareRoot(): Promise<void> {
    await ensurePrivateDirectory(this.root);
    for (const directory of ["home", "cache", "cache/huggingface", "cache/pip", "config", "proxy-state", "coordination", "consumers", "runtimes"]) {
      await ensurePrivateDirectory(this.root, join(this.root, directory));
    }
  }
  private async readDescriptor(path: string, version?: string): Promise<ManagedHeadroomDescriptor | null> {
    let opened = false;
    try {
      assertWithin(this.root, path); await assertNoSymlink(path);
      const descriptor = JSON.parse(await readFile(path, "utf8")) as ManagedHeadroomDescriptor;
      opened = true;
      if (descriptor.schema !== 1) throw new Error("Unknown managed Headroom layout schema");
      if (typeof descriptor.version !== "string" || descriptor.version.split(".").length !== 3 || descriptor.version.split(".").some(part => !/^[0-9]+$/.test(part)) || !Array.isArray(descriptor.inventory) ||
          descriptor.inventory.some(d => typeof d.name !== "string" || typeof d.version !== "string" || forbidden(d.name)) ||
          descriptor.embedding?.model !== "Qdrant/all-MiniLM-L6-v2-onnx" ||
          descriptor.embedding?.dimensions !== 384 || descriptor.embedding?.provider !== "CPUExecutionProvider") {
        throw new Error("Invalid managed Headroom runtime identity");
      }
      if (version && descriptor.version !== version) return null;
      assertWithin(join(this.root, "runtimes"), descriptor.slot);
      for (const binary of [descriptor.python, descriptor.cli]) {
        assertWithin(descriptor.slot, binary); await assertNoSymlink(binary);
        if (!(await lstat(binary)).isFile()) throw new Error("Invalid immutable runtime executable");
      }
      const ready = JSON.parse(await readFile(join(descriptor.slot, "ready.json"), "utf8"));
      if (JSON.stringify(ready) !== JSON.stringify(descriptor)) throw new Error("Immutable runtime readiness identity mismatch");
      return descriptor;
    } catch (error) {
      if (!opened && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      // A broken/unknown new-layout selection is not a legacy adoption candidate.
      throw error;
    }
  }
  private async assertNoPending(): Promise<void> {
    const path = join(this.root, "selection.pending.json"); await assertNoSymlink(path);
    if (await lstat(path).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) {
      throw new Error(`Incomplete runtime publication; preserve recovery identities in ${path}`);
    }
  }
  async inspect(): Promise<ManagedHeadroomDescriptor | null> { return this.readDescriptor(this.selectionPath); }
  async acquire(resource: string, onStatus: (message: string) => void): Promise<{ descriptor: ManagedHeadroomDescriptor; lease: ConsumerLease } | null> {
    const descriptor = await this.ensure(onStatus);
    if (!descriptor) return null;
    const release = await acquireManagedLock(join(this.root, "coordination"), "install", { timeoutMs: 240_000, signal: this.cancellation });
    try {
      await this.assertNoPending();
      const selected = await this.readDescriptor(this.selectionPath, descriptor.version);
      if (selected?.slot !== descriptor.slot) throw new Error("Runtime selection changed; activation deferred");
      return { descriptor, lease: await createConsumerLease(this.leaseRoot, resource) };
    } finally { await release(); }
  }
  private async check(python: string): Promise<{ version: string; inventory: { name: string; version: string }[]; transport: string }> {
    const parent = join(this.root, "preflight"); await ensurePrivateDirectory(this.root, parent);
    const temporary = await mkdtemp(join(parent, "candidate-"));
    try {
      await ensurePrivateDirectory(this.root, join(temporary, "state"));
      await ensurePrivateDirectory(this.root, join(temporary, "config"));
      const checked = JSON.parse(await this.execute(python, ["-c", CHECK], { env: { ...this.environment(),
        HEADROOM_WORKSPACE_DIR: join(temporary, "state"), HEADROOM_CONFIG_DIR: join(temporary, "config"),
        HEADROOM_CCR_SQLITE_PATH: join(temporary, "state", "ccr_store.db") }, timeoutMs: 30_000 }));
      const inventory = new Map<string, string>();
      for (const item of checked.inventory) {
        const name = item.name.toLowerCase().replaceAll("_", "-");
        if (inventory.has(name) && inventory.get(name) !== item.version) throw new Error("Conflicting installed dependency identities");
        inventory.set(name, item.version);
      }
      checked.inventory = [...inventory].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, version]) => ({ name, version }));
      return checked;
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  private async verify(descriptor: ManagedHeadroomDescriptor): Promise<void> {
    const result = await this.check(descriptor.python);
    if (result.transport !== MANAGED_CRYPTOGRAPHY_VERSION || result.version !== descriptor.version || result.inventory.some((d: { name: string }) => forbidden(d.name))) throw new Error("Headroom runtime identity/CPU dependency check failed");
    const digest = createHash("sha256").update(JSON.stringify(result.inventory)).digest("hex");
    if (digest !== descriptor.dependencyDigest) throw new Error("Managed immutable dependency inventory changed");
  }
  async ensure(onStatus: (message: string) => void): Promise<ManagedHeadroomDescriptor | null> {
    try { return await this.prepare(onStatus); }
    catch (error) { onStatus(`Headroom runtime unavailable: ${String(error)}`); return null; }
  }
  private async prepare(onStatus: (message: string) => void): Promise<ManagedHeadroomDescriptor> {
    const version = this.versionOverride ?? await getHeadroomAiVersion();
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Missing exact Headroom package pin");
    await this.prepareRoot();
    await this.assertNoPending();
    const selected = await this.inspect();
    if (selected && selected.version !== version) {
      const target = version.split(".").map(Number), source = selected.version.split(".").map(Number);
      if (source.length !== 3 || source.some(value => !Number.isSafeInteger(value)) ||
          !(target[0] > source[0] || (target[0] === source[0] && (target[1] > source[1] || (target[1] === source[1] && target[2] > source[2]))))) {
        throw new Error("Automatic runtime downgrade refused; manual extension downgrade requires paired backend and data");
      }
    }
    const current = await this.readDescriptor(this.selectionPath, version);
    if (current) { await this.verify(current); return current; }
    const release = await acquireManagedLock(join(this.root, "coordination"), "install", { timeoutMs: 240_000, signal: this.cancellation });
    try {
      await this.assertNoPending();
      const peer = await this.readDescriptor(this.selectionPath, version);
      if (peer) { await this.verify(peer); return peer; }
      const candidatePath = join(this.root, `candidate-${version}.json`);
      let descriptor = await this.readDescriptor(candidatePath, version);
      if (!descriptor) {
        if (/^(1|true|yes)$/i.test(this.environment().HEADROOM_OFFLINE ?? "")) throw new Error("Offline mode: fresh runtime installation requires cached/prepared candidate");
        const system = await this.systemPython();
        if (!system) throw new Error("Python >=3.10 unavailable");
        const pythonIdentity = (await this.execute(system, ["-c", "import sys,platform;print(sys.version+'|'+platform.platform())"], { env: this.environment(), timeoutMs: 10_000 })).trim();
        const build = createHash("sha256").update(pythonIdentity).digest("hex").slice(0, 16);
        const slot = join(this.root, "runtimes", version, `${build}-${randomUUID()}`);
        await ensurePrivateDirectory(this.root, slot);
        // Conservative current-package estimate; failure never mutates a live slot/store.
        await requireDiskSpace(this.root, 2 * 1024 * 1024 * 1024);
        const python = join(slot, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
        const cli = join(slot, process.platform === "win32" ? "Scripts/headroom.exe" : "bin/headroom");
        onStatus(`Preparing fresh Headroom ${version} runtime...`);
        await this.execute(system, ["-m", "venv", "--copies", slot], { env: this.environment(), timeoutMs: 60_000 });
        const report = join(slot, "resolved.json");
        await this.execute(python, ["-m", "pip", "--isolated", "install", "--dry-run", "--report", report, `headroom-ai[proxy]==${version}`, `cryptography==${MANAGED_CRYPTOGRAPHY_VERSION}`, "--disable-pip-version-check"], { env: this.environment(), timeoutMs: 240_000 });
        const resolved = JSON.parse(await readFile(report, "utf8"));
        const requirements: string[] = [];
        for (const distribution of resolved.install) {
          const name = distribution.metadata.name as string;
          const hash = distribution.download_info?.archive_info?.hashes?.sha256;
          if (forbidden(name) || !/^[0-9a-f]{64}$/.test(hash ?? "")) throw new Error(`Unapproved/unhashed runtime dependency: ${name}`);
          requirements.push(`${name.toLowerCase().replaceAll("_", "-") === "headroom-ai" ? "headroom-ai[proxy]" : name}==${distribution.metadata.version} --hash=sha256:${hash}`);
        }
        if (!requirements.some(line => line.startsWith(`cryptography==${MANAGED_CRYPTOGRAPHY_VERSION} `))) throw new Error("Resolver did not return pinned managed cryptography");
        if (!requirements.some(line => line.startsWith(`headroom-ai[proxy]==${version} `))) throw new Error("Resolver did not return exact pinned Headroom");
        const frozen = join(slot, "requirements.txt"); await writeFile(frozen, requirements.sort().join("\n") + "\n", { mode: 0o600 });
        await this.execute(python, ["-m", "pip", "--isolated", "install", "--require-hashes", "-r", frozen, "--disable-pip-version-check"], { env: this.environment(), timeoutMs: 600_000 });
        const checked = await this.check(python);
        if (checked.transport !== MANAGED_CRYPTOGRAPHY_VERSION || checked.version !== version || checked.inventory.some((d: { name: string }) => forbidden(d.name))) throw new Error("Candidate failed pinned CPU runtime validation");
        descriptor = { schema: 1, version, slot, python, cli, pythonIdentity,
          inventory: checked.inventory, dependencyDigest: createHash("sha256").update(JSON.stringify(checked.inventory)).digest("hex"),
          embedding: { model: "Qdrant/all-MiniLM-L6-v2-onnx", dimensions: 384, provider: "CPUExecutionProvider" } };
        await this.publish(this.root, join(slot, "ready.json"), descriptor);
        await this.publish(this.root, candidatePath, descriptor);
      } else await this.verify(descriptor);
      this.cancellation?.throwIfAborted();
      if ((await activeConsumers(this.leaseRoot)).length) throw new Error("Runtime activation deferred: managed consumers still use prior selection");
      const previous = await this.inspect();
      if (previous) await this.publish(this.root, join(this.root, `selected.backup-${randomUUID()}.json`), previous);
      const pending = join(this.root, "selection.pending.json");
      await publishJson(this.root, pending, { schema: 1, previous, candidate: descriptor });
      try {
        await this.publish(this.root, this.selectionPath, descriptor);
        await rm(pending);
      } catch (publicationError) {
        try {
          const actual = await this.inspect().catch(() => undefined);
          if (JSON.stringify(actual) !== JSON.stringify(previous)) {
            if (previous) await this.publish(this.root, this.selectionPath, previous);
            else await rm(this.selectionPath, { force: true });
          }
          await rm(pending);
        } catch (restoreError) {
          throw new Error(`Runtime publication/restoration uncertain; preserve ${pending}: ${String(publicationError)}; ${String(restoreError)}`);
        }
        throw new Error(`Runtime publication failed; original selection restored: ${String(publicationError)}`);
      }
      return descriptor;
    } finally { await release(); }
  }
}
export const DEFAULT_HEADROOM_RUNTIME = new ManagedHeadroomRuntime();
