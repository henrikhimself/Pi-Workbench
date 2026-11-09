/** Internal stdio launcher: real child lifetime owns store/runtime leases. */
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { requireSchemaVersion } = /** @type {typeof import("./schema-version.js")} */ (await jiti.import("./schema-version.ts"));
const { acquireManagedLock, createConsumerLease, assertWithin, assertNoSymlink, processBirth, publishJson } = /** @type {typeof import("./managed-lifecycle.js")} */ (await jiti.import("./managed-lifecycle.ts"));
/** The exact environment of the real server. Pi merges its whole environment into the launcher's
 * own, so the child must never inherit process.env: only what the extension decided gets through. */
/** @param {unknown} env */
function validEnvironment(env) {
  return !!env && typeof env === "object" && !Array.isArray(env) &&
    Object.entries(env).every(([key, value]) => key.length > 0 && !/[=\0]/.test(key) && typeof value === "string" && !value.includes("\0"));
}
const spec = JSON.parse(process.argv[2] ?? "null");
requireSchemaVersion(spec, "Owned MCP specification");
if (typeof spec.command !== "string" ||
    !Array.isArray(spec.args) || !spec.args.every(/** @param {unknown} x */ x => typeof x === "string") || !validEnvironment(spec.env)) throw new Error("Invalid owned MCP specification");
assertWithin(spec.installRoot, spec.command); await assertNoSymlink(spec.command);
assertWithin(spec.resource, spec.markerPath); await assertNoSymlink(spec.resource); await assertNoSymlink(spec.markerPath);
/** @typedef {import("node:child_process").ChildProcessByStdio<import("node:stream").Writable, import("node:stream").Readable, import("node:stream").Readable>} OwnedChild */
/** @type {OwnedChild | undefined} */ let child;
/** @type {import("./managed-lifecycle.js").ConsumerLease | undefined} */ let lease;
/** @type {import("./managed-lifecycle.js").ConsumerLease | undefined} */ let runtimeLease;
/** @type {(() => Promise<void>) | undefined} */ let runtimeRelease;
/** @type {Promise<void> | undefined} */ let childClosed;
let closing = false, requested = false;
/** @type {NodeJS.Timeout | undefined} */ let termination;
/** @type {NodeJS.Timeout | undefined} */ let escalation;
const startup = new AbortController();
function close() {
  requested = true; startup.abort();
  if (!child || closing) return;
  closing = true; child.stdin.end();
  // Pi closes stdin, signals the process group after 0.5 s and SIGKILLs it at about 2.5 s.
  // These timers must fire inside that window or they never run; a SIGKILL of this launcher
  // skips lease release, which is why the lease and lock cleanup stays short and ordered.
  const owned = child;
  termination = setTimeout(() => owned.kill("SIGTERM"), 1000);
  escalation = setTimeout(() => owned.kill("SIGKILL"), 2000);
}
process.stdin.pause(); process.stdin.on("end", close);
process.on("SIGTERM", close); process.on("SIGINT", close);
process.stdout.on("error", close); process.stderr.on("error", close);
/**
 * @param {string} root
 * @param {import("./managed-lifecycle.js").ConsumerLease} currentLease
 * @param {string} resource
 * @param {{ pid: number, start: string, host: string }} owner
 */
async function reassign(root, currentLease, resource, owner) {
  await publishJson(root, join(root, currentLease.token + ".json"), { schemaVersion: 1, token: currentLease.token, resource, ...owner });
}
try {
  if (spec.runtime) { assertWithin(spec.runtime.root, spec.runtime.selectionPath); await assertNoSymlink(spec.runtime.selectionPath); }
  // Lock order is always store, then the shared `install` lock. Waiting for a busy store while
  // holding `install` would leave a stale `install` lock behind if Pi SIGKILLs this launcher
  // during the wait, and every Headroom activation would then fail until manual cleanup.
  const release = await acquireManagedLock(spec.coordinationRoot, spec.lockName, { timeoutMs: 30000, signal: startup.signal });
  try {
    if (spec.runtime) {
      runtimeRelease = await acquireManagedLock(spec.runtime.coordinationRoot, "install", { timeoutMs: 30000, signal: startup.signal });
      const selected = JSON.parse(await readFile(spec.runtime.selectionPath, "utf8"));
      requireSchemaVersion(selected, "Shared runtime selection");
      if (selected.version !== spec.runtime.version || selected.slot !== spec.runtime.slot) throw new Error("Shared runtime selection changed; child startup deferred");
    }
    const marker = JSON.parse(await readFile(spec.markerPath, "utf8"));
    for (const [key, value] of Object.entries(spec.expectedMarker)) if (marker[key] !== value) throw new Error("MCP data identity changed before child startup");
    if (requested) throw new Error("Owned MCP startup cancelled");
    if (spec.runtime) runtimeLease = await createConsumerLease(spec.runtime.leaseRoot, `memory:${spec.resource}`);
    lease = await createConsumerLease(spec.leaseRoot, spec.resource);
    child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.on("error", () => {});
    child.on("error", error => { console.error(`Owned MCP child failed: ${error.message}`); });
    const spawned = child;
    childClosed = new Promise(/** @param {(value?: void) => void} resolve */ resolve => spawned.once("close", /** @param {number | null} code */ code => {
      clearTimeout(termination); clearTimeout(escalation);
      process.stdin.unpipe(spawned.stdin); process.stdin.pause(); process.exitCode = code ?? 1; resolve();
    }));
    if (!child.pid) throw new Error("Owned MCP child did not spawn");
    const start = await processBirth(child.pid);
    if (!start) throw new Error("Cannot establish child birth identity");
    const owner = { pid: child.pid, start, host: hostname() };
    await reassign(spec.leaseRoot, lease, spec.resource, owner);
    if (runtimeLease) await reassign(spec.runtime.leaseRoot, runtimeLease, `memory:${spec.resource}`, owner);
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
    if (requested) close(); else { process.stdin.pipe(child.stdin); process.stdin.resume(); }
  } finally { await runtimeRelease?.(); runtimeRelease = undefined; await release(); }
} catch (error) {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  if (childClosed) await childClosed;
  await lease?.release(); await runtimeLease?.release(); throw error;
} finally { await runtimeRelease?.(); }
await /** @type {Promise<void>} */ (childClosed).finally(async () => { await lease?.release(); await runtimeLease?.release(); });
