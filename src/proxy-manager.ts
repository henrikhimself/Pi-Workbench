import { spawn } from "node:child_process";
import { requireSchemaVersion } from "./schema-version.js";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { lstat, open, readFile, readlink, realpath, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireManagedLock, activeConsumers, assertNoSymlink, assertWithin, ensurePrivateDirectory,
  identityLive, processBirth, publishJson, type ConsumerLease, type ProcessIdentity,
} from "./managed-lifecycle.js";
import { DEFAULT_HEADROOM_RUNTIME, ManagedHeadroomRuntime, type ManagedHeadroomDescriptor } from "./headroom-runtime.js";
export { getHeadroomAiVersion } from "./headroom-runtime.js";
import { sealOwnedJson, openOwnedJson, readOwnedFrame } from "./owned-transport.js";
import { prepareDataStore } from "./store-identity.js";
import { headroomRequestTimeoutMs, proxyTuningEnvironment, type HeadroomProxyConfig } from "./headroom-config.js";

const PROXY_ENTRY = fileURLToPath(new URL("./managed-proxy.py", import.meta.url));
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
/** Headroom's own server-side compression timeout is 30 s and cannot be pre-empted, so the
 * client must wait longer than that: a busy proxy is not a dead proxy. */
export const HEADROOM_REQUEST_TIMEOUT_MS = headroomRequestTimeoutMs();
export const HEALTH_CHECK_TIMEOUT_MS = 3_000;
/** Watchdog probes tolerate a proxy that is busy compressing. */
export const WATCHDOG_HEALTH_TIMEOUT_MS = 10_000;
/** Longer than the longest hold of the proxy lock: launch() waits up to 60 s for health. */
export const PROXY_LOCK_WAIT_MS = 90_000;
/** Shutdown must not hang on a peer's long launch or restart: Pi awaits it with no timeout. */
export const SHUTDOWN_LOCK_WAIT_MS = 5_000;
export interface ManagedProxyRecord extends ProcessIdentity {
  schemaVersion: 1; port: number; nonce: string; serviceToken: string; script: string;
  descriptor: ManagedHeadroomDescriptor;
}
export interface ProxyManagerOptions {
  port?: number; runtime?: ManagedHeadroomRuntime;
  /** Per-request timeout for owned compression requests. */
  requestTimeoutMs?: number;
  /** Validated headroom.json `proxy` tuning, mapped to Headroom's environment when the proxy starts. */
  tuning?: HeadroomProxyConfig;
  /** Dependency seams for hermetic ownership/lifecycle tests, never config fields. */
  processMatches?: (record: ManagedProxyRecord) => Promise<boolean>;
  terminate?: (record: ManagedProxyRecord) => Promise<void>;
  /** Test seam: how long a last-consumer stop waits for the proxy lock (default SHUTDOWN_LOCK_WAIT_MS). */
  shutdownLockWaitMs?: number;
}
export async function getManagedHeadroomVersion(runtime = DEFAULT_HEADROOM_RUNTIME): Promise<string | null> {
  return (await runtime.inspect())?.version ?? null;
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
  private readonly requestTimeoutMs: number;
  private readonly tuning: HeadroomProxyConfig | undefined;
  private readonly matches: (record: ManagedProxyRecord) => Promise<boolean>;
  private readonly terminate: (record: ManagedProxyRecord) => Promise<void>;
  private consumer: ConsumerLease | null = null;
  private descriptor: ManagedHeadroomDescriptor | null = null;
  private stopping = false;
  private starting: Promise<boolean> | null = null;
  private restarting: Promise<boolean> | null = null;
  private stoppingWork: Promise<void> | null = null;
  private stopController = new AbortController();
  private readonly shutdownLockWaitMs: number;
  constructor(options: ProxyManagerOptions = {}) {
    this.port = options.port ?? 8787;
    this.requestTimeoutMs = options.requestTimeoutMs ?? HEADROOM_REQUEST_TIMEOUT_MS;
    this.tuning = options.tuning;
    this.runtime = options.runtime ?? DEFAULT_HEADROOM_RUNTIME;
    this.matches = options.processMatches ?? ((record) => this.matchesProcess(record));
    this.terminate = options.terminate ?? ((record) => this.terminateOwned(record));
    this.shutdownLockWaitMs = options.shutdownLockWaitMs ?? SHUTDOWN_LOCK_WAIT_MS;
  }
  get baseUrl(): string { return `http://127.0.0.1:${this.port}`; }
  get isManaged(): boolean { return this.consumer !== null; }
  async resume(): Promise<void> {
    if (this.stoppingWork) await this.stoppingWork;
    this.stopping = false;
    if (this.stopController.signal.aborted) this.stopController = new AbortController();
  }
  private get resource(): string { return `proxy:${this.port}`; }
  private get directory(): string { return join(this.runtime.root, "proxies", String(this.port)); }
  private get recordPath(): string { return join(this.directory, "owner.json"); }
  private async lock(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<() => Promise<void>> {
    return acquireManagedLock(join(this.runtime.root, "coordination"), `proxy-${this.port}`,
      { timeoutMs: options.timeoutMs ?? PROXY_LOCK_WAIT_MS, signal: options.signal });
  }
  private async record(): Promise<ManagedProxyRecord | null> {
    await assertNoSymlink(this.recordPath);
    try {
      const info = await lstat(this.recordPath);
      if (!info.isFile() || (process.getuid && info.uid !== process.getuid()) ||
          (process.platform !== "win32" && (info.mode & 0o077))) throw new Error("Unsafe managed proxy identity record");
      const record = JSON.parse(await readFile(this.recordPath, "utf8")) as ManagedProxyRecord;
      requireSchemaVersion(record, "Managed proxy record");
      if (record.port !== this.port || !/^[0-9a-f]{64}$/.test(record.nonce) ||
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
  private async healthy(record: ManagedProxyRecord, timeoutMs = HEALTH_CHECK_TIMEOUT_MS): Promise<boolean> {
    if (!await this.matches(record)) return false;
    try {
      const challenge = randomUUID();
      const response = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs), redirect: "error", headers: { "x-pi-workbench-challenge": challenge } });
      if (!response.ok) return false;
      const expected = createHash("sha256").update(`${await realpath(record.descriptor.python)}|${record.descriptor.version}`).digest("hex");
      const proof = createHmac("sha256", Buffer.from(record.nonce, "hex")).update(`health:${challenge}:${expected}`).digest("hex");
      if (response.headers.get("x-pi-workbench-owner") !== proof || response.headers.get("x-pi-workbench-runtime") !== expected) return false;
      const health = await response.json() as { version?: string; config?: { pid?: number } };
      return health.version === record.descriptor.version && health.config?.pid === record.pid;
    } catch { return false; }
  }
  async requestOwned(path: string, body: unknown = null, method: "GET" | "POST" = "POST", signal?: AbortSignal): Promise<any> {
    const target = new URL(path, this.baseUrl);
    if (!path.startsWith("/") || target.origin !== this.baseUrl || target.search || target.hash) throw new Error("Invalid owned request path");
    const record = await this.record();
    if (!this.consumer || !record || record.descriptor.slot !== this.descriptor?.slot || !await this.matches(record)) throw new Error("No owned compression consumer");
    const requestId = randomUUID();
    const response = await fetch(target, {
      method: "POST", redirect: "error",
      signal: signal ? AbortSignal.any([AbortSignal.timeout(this.requestTimeoutMs), signal]) : AbortSignal.timeout(this.requestTimeoutMs),
      headers: { "content-type": "application/json", "x-pi-workbench-encrypted": "1", "x-pi-workbench-request": requestId, "x-pi-workbench-method": method },
      body: sealOwnedJson(record.nonce, `pi-workbench:headroom:v1:request:${requestId}:${method}:${target.pathname}`, body),
    });
    const result = openOwnedJson(record.nonce, `pi-workbench:headroom:v1:response:${requestId}:${response.status}`, await readOwnedFrame(response));
    if (!response.ok) throw new Error(`Owned compression failed with HTTP ${response.status}`);
    return result;
  }
  /** True while the recorded proxy process still exists and is provably ours. A slow or
   * busy proxy is still alive; only a missing/foreign process counts as gone. */
  async processAlive(): Promise<boolean> {
    try {
      const record = await this.record();
      const selected = this.descriptor ?? await this.runtime.inspect();
      return !!record && !!selected && record.descriptor.slot === selected.slot && await this.matches(record);
    } catch { return false; }
  }
  async healthCheck(timeoutMs = HEALTH_CHECK_TIMEOUT_MS): Promise<boolean> {
    try {
      const record = await this.record();
      const selected = this.descriptor ?? await this.runtime.inspect();
      return !!record && !!selected && record.descriptor.slot === selected.slot && await this.healthy(record, timeoutMs);
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
    let ok = false;
    try {
      ok = await this.activate(onStatus);
      return ok;
    } catch (error) { onStatus(`Managed Headroom unavailable: ${String(error)}`); return false; }
    finally {
      if (!ok && !this.stopping && this.consumer) {
        const lease = this.consumer; this.consumer = null;
        await lease.release().catch(() => {});
      }
    }
  }
  private async activate(onStatus: (message: string) => void): Promise<boolean> {
    // Resolve unknown occupants before any installation. Never adopt even an
    // exact-version service that lacks our private birth/nonce record.
    let release = await this.lock({ signal: this.stopController.signal });
    try {
      const existing = await this.record();
      if (existing && !(await activeConsumers(this.runtime.leaseRoot, this.resource)).length && await this.matches(existing)) {
        // A healthy owned proxy on the selected runtime is adopted (session replacement hands it
        // over): we take a lease below, which keeps its monitor from exiting. Anything else that
        // is owned but orphaned is terminated.
        const selected = this.descriptor ?? await this.runtime.inspect();
        const adoptable = !!selected && existing.descriptor.slot === selected.slot && await this.healthy(existing);
        if (!adoptable) await this.terminate(existing);
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
    release = await this.lock({ signal: this.stopController.signal });
    try {
      if (this.stopping) return false;
      const record = await this.record();
      if (record && record.descriptor.slot === this.descriptor!.slot && await this.healthy(record)) return true;
      if (!await portFree(this.port)) { onStatus("Headroom activation deferred: occupied or incompatible managed port"); return false; }
      return await this.launch(onStatus);
    } finally { await release(); }
  }
  private async launch(onStatus: (message: string) => void): Promise<boolean> {
    const descriptor = this.descriptor!;
    await prepareDataStore(join(this.runtime.root, "proxy-state"), { schemaVersion: 1, layout: 1, headroomVersion: descriptor.version, kind: "proxy" });
    await ensurePrivateDirectory(this.runtime.root, this.directory);
    const nonce = randomBytes(32).toString("hex"), serviceToken = randomUUID();
    const serviceLease = join(this.runtime.leaseRoot, `${serviceToken}.json`);
    const logPath = join(this.directory, "proxy.log"); await assertNoSymlink(logPath);
    // Each launch starts a new log and keeps the previous one. A previous proxy may still hold it open: renaming is safe.
    const previousLog = `${logPath}.1`; await assertNoSymlink(previousLog);
    await rename(logPath, previousLog).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    const log = await open(logPath, "a", 0o600);
    let child: ReturnType<typeof spawn>;
    try {
      onStatus("Starting extension-owned Headroom proxy...");
      child = spawn(descriptor.python, [PROXY_ENTRY, String(this.port)], {
        env: { ...this.runtime.environment(), ...proxyTuningEnvironment(this.tuning), WB_PROXY_OWNER: nonce, WB_PROXY_CONSUMERS: this.runtime.leaseRoot,
          WB_PROXY_RESOURCE: this.resource, WB_PROXY_SERVICE_LEASE: serviceLease },
        detached: process.platform !== "win32", stdio: ["ignore", log.fd, log.fd],
      });
      child.on("error", () => {}); child.unref();
    } finally { await log.close(); }
    if (!child.pid) throw new Error("Owned proxy process did not spawn");
    let record: ManagedProxyRecord;
    try {
      const start = await processBirth(child.pid);
      if (!start) throw new Error("Cannot establish spawned proxy process birth identity");
      const { hostname } = await import("node:os");
      record = { schemaVersion: 1, pid: child.pid, start, host: hostname(), port: this.port,
        nonce, serviceToken, script: PROXY_ENTRY, descriptor };
      await publishJson(this.runtime.root, serviceLease, { schemaVersion: 1, token: serviceToken, resource: `service:${this.resource}`, pid: record.pid, start, host: record.host });
      await publishJson(this.runtime.root, this.recordPath, record);
    } catch (error) {
      // No owner record means nothing could ever stop this child, so do not leave it running.
      // child.kill, not process.kill(pid): Node does not signal a child it has already reaped.
      child.kill("SIGKILL");
      await rm(serviceLease, { force: true }).catch(() => {});
      throw error;
    }
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
  /**
   * Releases this instance's lease and, when it was the last consumer, terminates the proxy.
   * `{ terminate: false }` releases the lease only, for a session replacement (`/new`, `/resume`,
   * `/fork`, `/reload`): the new instance adopts the running proxy. If nothing takes a lease,
   * the proxy's own monitor exits about 10 s after the last one is gone.
   */
  async stop(options: { terminate?: boolean } = {}): Promise<void> {
    this.stopping = true;
    this.stopController.abort();
    if (!this.stoppingWork) this.stoppingWork = this.stopOnce(options.terminate !== false).finally(() => { this.stoppingWork = null; });
    return this.stoppingWork;
  }
  private async stopOnce(terminate: boolean): Promise<void> {
    if (this.starting) await this.starting;
    if (!this.consumer) return;
    const lease = this.consumer; this.consumer = null;
    if (!terminate) { await lease.release(); return; }
    let release: () => Promise<void>;
    try { release = await this.lock({ timeoutMs: this.shutdownLockWaitMs }); }
    catch { await lease.release(); return; } // the proxy monitor exits about 10 s after the last lease goes
    try {
      await lease.release();
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
    const release = await this.lock({ signal: this.stopController.signal });
    try {
      const peers = (await activeConsumers(this.runtime.leaseRoot, this.resource)).sort();
      if (peers[0] !== this.consumer?.token) return this.healthCheck(WATCHDOG_HEALTH_TIMEOUT_MS);
      const record = await this.record();
      // Re-check with the long timeout: never terminate a proxy that is merely busy.
      if (record && await this.healthy(record, WATCHDOG_HEALTH_TIMEOUT_MS)) return true;
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
