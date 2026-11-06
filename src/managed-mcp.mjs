/** Internal stdio launcher: real child lifetime owns store/runtime leases. */
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { acquireManagedLock, createConsumerLease, assertWithin, assertNoSymlink, processBirth, publishJson } = await jiti.import("./managed-lifecycle.ts");
const spec = JSON.parse(process.argv[2] ?? "null");
if (!spec || spec.schema !== 1 || typeof spec.command !== "string" ||
    !Array.isArray(spec.args) || !spec.args.every(x => typeof x === "string")) throw new Error("Invalid owned MCP specification");
assertWithin(spec.installRoot, spec.command); await assertNoSymlink(spec.command);
assertWithin(spec.resource, spec.markerPath); await assertNoSymlink(spec.resource); await assertNoSymlink(spec.markerPath);
let child, lease, runtimeLease, runtimeRelease, childClosed;
let closing = false, requested = false, termination, escalation;
const startup = new AbortController();
function close() {
  requested = true; startup.abort();
  if (!child || closing) return;
  closing = true; child.stdin.end();
  termination = setTimeout(() => child.kill("SIGTERM"), 5000);
  escalation = setTimeout(() => child.kill("SIGKILL"), 7000);
}
process.stdin.pause(); process.stdin.on("end", close);
process.on("SIGTERM", close); process.on("SIGINT", close);
process.stdout.on("error", close); process.stderr.on("error", close);
async function reassign(root, currentLease, resource, owner) {
  await publishJson(root, join(root, currentLease.token + ".json"), { schema: 1, token: currentLease.token, resource, ...owner });
}
try {
  if (spec.runtime) {
    assertWithin(spec.runtime.root, spec.runtime.selectionPath); await assertNoSymlink(spec.runtime.selectionPath);
    runtimeRelease = await acquireManagedLock(spec.runtime.coordinationRoot, "install", { timeoutMs: 30000, signal: startup.signal });
    const selected = JSON.parse(await readFile(spec.runtime.selectionPath, "utf8"));
    if (selected.schema !== 1 || selected.version !== spec.runtime.version || selected.slot !== spec.runtime.slot) throw new Error("Shared runtime selection changed; child startup deferred");
  }
  const release = await acquireManagedLock(spec.coordinationRoot, spec.lockName, { timeoutMs: 30000, signal: startup.signal });
  try {
    const marker = JSON.parse(await readFile(spec.markerPath, "utf8"));
    for (const [key, value] of Object.entries(spec.expectedMarker)) if (marker[key] !== value) throw new Error("MCP data identity changed before child startup");
    if (requested) throw new Error("Owned MCP startup cancelled");
    if (spec.runtime) runtimeLease = await createConsumerLease(spec.runtime.leaseRoot, `memory:${spec.resource}`);
    lease = await createConsumerLease(spec.leaseRoot, spec.resource);
    child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.on("error", () => {});
    child.on("error", error => { console.error(`Owned MCP child failed: ${error.message}`); });
    childClosed = new Promise(resolve => child.once("close", code => {
      clearTimeout(termination); clearTimeout(escalation);
      process.stdin.unpipe(child.stdin); process.stdin.pause(); process.exitCode = code ?? 1; resolve();
    }));
    if (!child.pid) throw new Error("Owned MCP child did not spawn");
    const start = await processBirth(child.pid);
    if (!start) throw new Error("Cannot establish child birth identity");
    const owner = { pid: child.pid, start, host: hostname() };
    await reassign(spec.leaseRoot, lease, spec.resource, owner);
    if (runtimeLease) await reassign(spec.runtime.leaseRoot, runtimeLease, `memory:${spec.resource}`, owner);
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
    if (requested) close(); else { process.stdin.pipe(child.stdin); process.stdin.resume(); }
  } finally { await release(); }
} catch (error) {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  if (childClosed) await childClosed;
  await lease?.release(); await runtimeLease?.release(); throw error;
} finally { await runtimeRelease?.(); }
await childClosed.finally(async () => { await lease.release(); await runtimeLease?.release(); });
