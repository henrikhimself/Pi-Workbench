import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { lstat, open, readFile, readlink, realpath, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireManagedLock, activeConsumers, assertNoSymlink, assertWithin, ensurePrivateDirectory,
  identityLive, processBirth, publishJson, type ConsumerLease, type ProcessIdentity,
} from "./managed-lifecycle.js";
import { DEFAULT_HEADROOM_RUNTIME, ManagedHeadroomRuntime, type ManagedHeadroomDescriptor } from "./headroom-runtime.js";
export { findPython, getHeadroomAiVersion } from "./headroom-runtime.js";
import { sealOwnedJson, openOwnedJson, readOwnedFrame } from "./owned-transport.js";
import { prepareHeadroomStore } from "./headroom-state.js";

const PROXY_ENTRY = fileURLToPath(new URL("./managed-proxy.py", import.meta.url));
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
export interface ManagedProxyRecord extends ProcessIdentity {
  schema: 1; port: number; nonce: string; serviceToken: string; script: string;
  descriptor: ManagedHeadroomDescriptor;
}
export interface ProxyManagerOptions {
  port?: number; host?: string; runtime?: ManagedHeadroomRuntime;
  /** Dependency seams for hermetic ownership/lifecycle tests, never config fields. */
  processMatches?: (record: ManagedProxyRecord) => Promise<boolean>;
  terminate?: (record: ManagedProxyRecord) => Promise<void>;
}
export async function getManagedHeadroomVersion(runtime = DEFAULT_HEADROOM_RUNTIME): Promise<string | null> {
  return (await runtime.inspect())?.version ?? null;
}
export async function ensureManagedPython(onStatus: (message: string) => void, runtime = DEFAULT_HEADROOM_RUNTIME): Promise<string | null> {
  return (await runtime.ensure(onStatus))?.python ?? null;
}
export async function acquireStartupLock(lockDir: string, onStatus: (message: string) => void, shouldAbort: () => boolean): Promise<(() => Promise<void>) | null> {
  if (shouldAbort()) return null;
  try {
    const release = await acquireManagedLock(dirname(lockDir), basename(lockDir).replace(/\.lock$/, ""), { timeoutMs: 240_000 });
    if (shouldAbort()) { await release(); return null; }
    return release;
  } catch (error) { onStatus(String(error)); return null; }
}
async function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => done(true)));
  });
}

/** Shared owned service. A creator is not a permanent supervisor or sole consumer. */
export class ProxyManager {
  private readonly runtime: ManagedHeadroomRuntime;
  private readonly port: number;
  private readonly matches: (record: ManagedProxyRecord) => Promise<boolean>;
  private readonly terminate: (record: ManagedProxyRecord) => Promise<void>;
  private consumer: ConsumerLease | null = null;
  private descriptor: ManagedHeadroomDescriptor | null = null;
  private stopping = false;
  private starting: Promise<boolean> | null = null;
  private restarting: Promise<boolean> | null = null;
  private stoppingWork: Promise<void> | null = null;
  constructor(options: ProxyManagerOptions = {}) {
    if (options.host && options.host !== "127.0.0.1") throw new Error("Managed Headroom binds only 127.0.0.1");
    this.port = options.port ?? 8787;
    this.runtime = options.runtime ?? DEFAULT_HEADROOM_RUNTIME;
    this.matches = options.processMatches ?? ((record) => this.matchesProcess(record));
    this.terminate = options.terminate ?? ((record) => this.terminateOwned(record));
  }
  get baseUrl(): string { return `http://127.0.0.1:${this.port}`; }
  get isManaged(): boolean { return this.consumer !== null; }
  async resume(): Promise<void> { if (this.stoppingWork) await this.stoppingWork; this.stopping = false; }
  private get resource(): string { return `proxy:${this.port}`; }
  private get directory(): string { return join(this.runtime.root, "proxies", String(this.port)); }
  private get recordPath(): string { return join(this.directory, "owner.json"); }
  private async lock(): Promise<() => Promise<void>> {
    return acquireManagedLock(join(this.runtime.root, "coordination"), `proxy-${this.port}`, { timeoutMs: 30_000 });
  }
  private async record(): Promise<ManagedProxyRecord | null> {
    await assertNoSymlink(this.recordPath);
    try {
      const info = await lstat(this.recordPath);
      if (!info.isFile() || (process.getuid && info.uid !== process.getuid()) ||
          (process.platform !== "win32" && (info.mode & 0o077))) throw new Error("Unsafe managed proxy identity record");
      const record = JSON.parse(await readFile(this.recordPath, "utf8")) as ManagedProxyRecord;
      if (record.schema !== 1 || record.port !== this.port || !/^[0-9a-f]{64}$/.test(record.nonce) ||
          !/^[0-9a-f-]+$/.test(record.serviceToken) || typeof record.script !== "string" || basename(record.script) !== "managed-proxy.py" || !record.descriptor) throw new Error("Invalid managed proxy record");
      assertWithin(join(this.runtime.root, "runtimes"), record.descriptor.slot);
      assertWithin(record.descriptor.slot, record.descriptor.python);
      await assertNoSymlink(record.descriptor.python);
      const ready = JSON.parse(await readFile(join(record.descriptor.slot, "ready.json"), "utf8"));
      if (ready.version !== record.descriptor.version || ready.python !== record.descriptor.python || ready.slot !== record.descriptor.slot) throw new Error("Proxy runtime identity mismatch");
      return record;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  private async matchesProcess(record: ManagedProxyRecord): Promise<boolean> {
    if (!await identityLive(record)) return false;
    if (process.platform === "linux") {
      try {
        const argv = (await readFile(`/proc/${record.pid}/cmdline`, "utf8")).split("\0");
        return await readlink(`/proc/${record.pid}/exe`) === await realpath(record.descriptor.python) &&
          argv[1] === record.script && argv[2] === String(record.port);
      } catch { return false; }
    }
    // On other platforms the private birth record and health nonce/runtime
    // attestation establish ownership without assuming Linux /proc semantics.
    return true;
  }
  private async healthy(record: ManagedProxyRecord): Promise<boolean> {
    if (!await this.matches(record)) return false;
    try {
      const challenge = randomUUID();
      const response = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000), redirect: "error", headers: { "x-pi-workbench-challenge": challenge } });
      if (!response.ok) return false;
      const expected = createHash("sha256").update(`${await realpath(record.descriptor.python)}|${record.descriptor.version}`).digest("hex");
      const proof = createHmac("sha256", Buffer.from(record.nonce, "hex")).update(`health:${challenge}:${expected}`).digest("hex");
      if (response.headers.get("x-pi-workbench-owner") !== proof || response.headers.get("x-pi-workbench-runtime") !== expected) return false;
      const health = await response.json() as { version?: string; config?: { pid?: number } };
      return health.version === record.descriptor.version && health.config?.pid === record.pid;
    } catch { return false; }
  }
  async compressRaw(body: Record<string, unknown>): Promise<any> { return this.requestOwned("/v1/compress", body); }
  async requestOwned(path: string, body: unknown = null, method: "GET" | "POST" = "POST"): Promise<any> {
    const target = new URL(path, this.baseUrl);
    if (!path.startsWith("/") || target.origin !== this.baseUrl || target.search || target.hash) throw new Error("Invalid owned request path");
    const record = await this.record();
    if (!this.consumer || !record || record.descriptor.slot !== this.descriptor?.slot || !await this.matches(record)) throw new Error("No owned compression consumer");
    const requestId = randomUUID();
    const response = await fetch(target, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json", "x-pi-workbench-encrypted": "1", "x-pi-workbench-request": requestId, "x-pi-workbench-method": method },
      body: sealOwnedJson(record.nonce, `pi-workbench:headroom:v1:request:${requestId}:${method}:${target.pathname}`, body),
    });
    const result = openOwnedJson(record.nonce, `pi-workbench:headroom:v1:response:${requestId}:${response.status}`, await readOwnedFrame(response));
    if (!response.ok) throw new Error(`Owned compression failed with HTTP ${response.status}`);
    return result;
  }
  async healthCheck(): Promise<boolean> {
    try {
      const record = await this.record();
      const selected = this.descriptor ?? await this.runtime.inspect();
      return !!record && !!selected && record.descriptor.slot === selected.slot && await this.healthy(record);
    } catch { return false; }
  }
  async ensureRunning(onStatus: (message: string) => void): Promise<boolean> {
    if (this.stopping) return false;
    if (!this.starting) this.starting = this.ensureOnce(onStatus).catch((error) => {
      onStatus(`Managed activation deferred: ${String(error)}`); return false;
    }).finally(() => { this.starting = null; });
    return this.starting;
  }
  private async ensureOnce(onStatus: (message: string) => void): Promise<boolean> {
    try {
      // Resolve unknown occupants before any installation. Never adopt even an
      // exact-version service that lacks our private birth/nonce record.
      let release = await this.lock();
      try {
        const existing = await this.record();
        if (existing && !(await activeConsumers(this.runtime.leaseRoot, this.resource)).length && await this.matches(existing)) {
          await this.terminate(existing); // Owned orphan only, never an old installation discovery.
        }
        if (!await portFree(this.port) && (!existing || !await this.matches(existing))) {
          onStatus("Managed Headroom port occupied by unknown/unowned service; no context sent"); return false;
        }
      } finally { await release(); }
      if (!this.consumer) {
        const acquired = await this.runtime.acquire(this.resource, onStatus);
        if (!acquired) return false;
        this.consumer = acquired.lease; this.descriptor = acquired.descriptor;
      }
      release = await this.lock();
      try {
        if (this.stopping) return false;
        const record = await this.record();
        if (record && record.descriptor.slot === this.descriptor!.slot && await this.healthy(record)) return true;
        if (!await portFree(this.port)) { onStatus("Headroom activation deferred: occupied or incompatible managed port"); return false; }
        return await this.launch(onStatus);
      } finally { await release(); }
    } catch (error) { onStatus(`Managed Headroom unavailable: ${String(error)}`); return false; }
    finally {
      if (!await this.healthCheck()) { await this.consumer?.release(); this.consumer = null; }
    }
  }
  private async launch(onStatus: (message: string) => void): Promise<boolean> {
    const descriptor = this.descriptor!;
    await prepareHeadroomStore(join(this.runtime.root, "proxy-state"), { schema: 1, layout: 1, headroomVersion: descriptor.version, kind: "proxy" });
    await ensurePrivateDirectory(this.runtime.root, this.directory);
    const nonce = randomBytes(32).toString("hex"), serviceToken = randomUUID();
    const serviceLease = join(this.runtime.leaseRoot, `${serviceToken}.json`);
    const logPath = join(this.directory, "proxy.log"); await assertNoSymlink(logPath);
    const log = await open(logPath, "a", 0o600);
    let child: ReturnType<typeof spawn>;
    try {
      onStatus("Starting extension-owned Headroom proxy...");
      child = spawn(descriptor.python, [PROXY_ENTRY, String(this.port)], {
        env: { ...this.runtime.environment(), WB_PROXY_OWNER: nonce, WB_PROXY_CONSUMERS: this.runtime.leaseRoot,
          WB_PROXY_RESOURCE: this.resource, WB_PROXY_SERVICE_LEASE: serviceLease },
        detached: process.platform !== "win32", stdio: ["ignore", log.fd, log.fd],
      });
      child.on("error", () => {}); child.unref();
    } finally { await log.close(); }
    if (!child.pid) throw new Error("Owned proxy process did not spawn");
    const start = await processBirth(child.pid);
    if (!start) throw new Error("Cannot establish spawned proxy process birth identity");
    const { hostname } = await import("node:os");
    const record: ManagedProxyRecord = { schema: 1, pid: child.pid, start, host: hostname(), port: this.port,
      nonce, serviceToken, script: PROXY_ENTRY, descriptor };
    await publishJson(this.runtime.root, serviceLease, { schema: 1, token: serviceToken, resource: `service:${this.resource}`, pid: record.pid, start, host: record.host });
    await publishJson(this.runtime.root, this.recordPath, record);
    for (let attempt = 0; attempt < 120 && !this.stopping; attempt++) {
      if (await this.healthy(record)) return true;
      if (!await this.matches(record)) break;
      await sleep(500);
    }
    await this.terminate(record);
    onStatus(`Owned proxy startup failed; diagnostics: ${logPath}`);
    return false;
  }
  private async terminateOwned(record: ManagedProxyRecord): Promise<void> {
    if (!await this.matches(record)) return;
    process.kill(record.pid, "SIGTERM");
    const deadline = Date.now() + 5000;
    while (await this.matches(record) && Date.now() < deadline) await sleep(100);
    if (await this.matches(record)) process.kill(record.pid, "SIGKILL");
    const killed = Date.now() + 3000;
    while (await this.matches(record) && Date.now() < killed) await sleep(50);
    if (await this.matches(record)) throw new Error("Owned proxy has not exited; preserve runtime lease");
    await rm(join(this.runtime.leaseRoot, `${record.serviceToken}.json`), { force: true });
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (!this.stoppingWork) this.stoppingWork = this.stopOnce().finally(() => { this.stoppingWork = null; });
    return this.stoppingWork;
  }
  private async stopOnce(): Promise<void> {
    if (this.starting) await this.starting;
    if (!this.consumer) return;
    const release = await this.lock();
    try {
      await this.consumer?.release(); this.consumer = null;
      if ((await activeConsumers(this.runtime.leaseRoot, this.resource)).length) return;
      const record = await this.record();
      if (record && await this.matches(record)) await this.terminate(record);
    } finally { await release(); }
  }
  async tryRestart(onStatus: (message: string) => void): Promise<boolean> {
    if (!this.consumer || this.stopping) return false;
    if (!this.restarting) this.restarting = this.restartOnce(onStatus).catch((error) => {
      onStatus(`Managed recovery deferred: ${String(error)}`); return false;
    }).finally(() => { this.restarting = null; });
    return this.restarting;
  }
  private async restartOnce(onStatus: (message: string) => void): Promise<boolean> {
    const release = await this.lock();
    try {
      const peers = (await activeConsumers(this.runtime.leaseRoot, this.resource)).sort();
      if (peers[0] !== this.consumer?.token) return this.healthCheck();
      const record = await this.record();
      if (record && await this.healthy(record)) return true;
      if (record && record.descriptor.slot === this.descriptor?.slot && await this.matches(record)) await this.terminate(record);
      // An owned SIGKILL can precede kernel listener teardown by a few ms.
      // Wait boundedly, but never terminate a new/unknown occupant.
      const drain = Date.now() + 2000;
      while (!await portFree(this.port) && Date.now() < drain) await sleep(50);
      if (!await portFree(this.port)) { onStatus("Recovery refused: unowned port occupant"); return false; }
      return await this.launch(onStatus);
    } finally { await release(); }
  }
}
