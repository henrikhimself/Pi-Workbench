/** Owned MCP launcher (src/managed-mcp.mjs): exact child environment, lock order, shutdown timing. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const m = await jiti.import("../src/managed-lifecycle.ts");
const LAUNCHER = fileURLToPath(new URL("../src/managed-mcp.mjs", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = (path) => lstat(path).then(() => true, () => false);

const FAKE_SERVER = (ignoreShutdown) => `#!${process.execPath}
const { writeFileSync } = require("node:fs");
writeFileSync(process.argv[2], JSON.stringify(process.env));
${ignoreShutdown ? 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);' : 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));'}
process.stdin.resume();
`;

async function fixture(fn, { ignoreShutdown = false, runtime = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "wb-launcher-"));
  const launched = [];
  try {
    await mkdir(join(root, "bin")); await mkdir(join(root, "store"));
    const command = join(root, "bin", "fake-server");
    await writeFile(command, FAKE_SERVER(ignoreShutdown)); await chmod(command, 0o755);
    await writeFile(join(root, "store", "marker.json"), JSON.stringify({ id: "fixture" }));
    const spec = {
      schemaVersion: 1, command, args: [join(root, "child-env.json")], cwd: root, installRoot: join(root, "bin"),
      env: { PATH: "/usr/bin:/bin", FROM_SPEC: "yes" },
      coordinationRoot: join(root, "store-coordination"), lockName: "store", leaseRoot: join(root, "leases"),
      resource: join(root, "store"), markerPath: join(root, "store", "marker.json"), expectedMarker: { id: "fixture" },
    };
    if (runtime) {
      await mkdir(join(root, "runtime"));
      await writeFile(join(root, "runtime", "selection.json"), JSON.stringify({ schemaVersion: 1, version: "1", slot: "slot-a" }));
      spec.runtime = { root: join(root, "runtime"), coordinationRoot: join(root, "runtime", "coordination"),
        selectionPath: join(root, "runtime", "selection.json"), slot: "slot-a", version: "1", leaseRoot: join(root, "runtime-leases") };
    }
    const launch = (overrides = {}) => {
      const child = spawn(process.execPath, [LAUNCHER, JSON.stringify({ ...spec, ...overrides })], {
        env: { ...process.env, WB_PARENT_SENTINEL: "must-not-reach-the-server" }, stdio: ["pipe", "pipe", "pipe"],
      });
      const run = { child, stderr: "", exited: new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal }))) };
      child.stderr.on("data", (chunk) => { run.stderr += chunk; });
      child.stdout.resume();
      launched.push(child);
      return run;
    };
    await fn({ root, spec, launch, installLock: join(root, "runtime", "coordination", "install.lock"), storeLock: join(root, "store-coordination", "store.lock") });
  } finally {
    for (const child of launched) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await sleep(50);
    await rm(root, { recursive: true, force: true });
  }
}

async function waitFor(condition, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await condition()) return true; await sleep(25); }
  return false;
}

test("launcher starts the real server with exactly spec.env, never Pi's inherited environment", () => fixture(async ({ spec, launch }) => {
  const run = launch();
  assert.ok(await waitFor(() => exists(spec.args[0])), `server did not start: ${run.stderr}`);
  const seen = JSON.parse(await readFile(spec.args[0], "utf8"));
  assert.deepEqual(seen, spec.env);
  assert.equal(seen.WB_PARENT_SENTINEL, undefined);
  run.child.stdin.end();
  assert.equal((await run.exited).code, 0);
  assert.deepEqual(await m.activeConsumers(spec.leaseRoot), [], "leases released on exit");
}));

test("launcher rejects a specification without a valid environment", () => fixture(async ({ launch }) => {
  for (const env of [undefined, null, [], "PATH=/bin", { PATH: 1 }, { "A=B": "x" }, { A: "x\0y" }]) {
    const run = launch({ env });
    const { code } = await run.exited;
    assert.notEqual(code, 0, JSON.stringify(env));
    assert.match(run.stderr, /Invalid owned MCP specification/);
  }
}));

test("launcher waits for the store lock without holding the shared install lock", () => fixture(async ({ spec, launch, installLock, storeLock }) => {
  const releaseStore = await m.acquireManagedLock(spec.coordinationRoot, spec.lockName);
  try {
    const run = launch();
    await sleep(600);
    assert.equal(run.child.exitCode, null, "launcher is waiting for the store lock");
    assert.equal(await exists(installLock), false, "install lock must not be held while waiting for the store");
    run.child.kill("SIGKILL");
    await run.exited;
    assert.equal(await exists(installLock), false, "a SIGKILLed launcher leaves no stale install lock");
    assert.ok(await exists(storeLock), "the other session's store lock is untouched");
  } finally { await releaseStore(); }
}));

test("launcher takes the store lock first, then the install lock, and releases both before running the server", () => fixture(async ({ spec, launch, installLock, storeLock }) => {
  const run = launch();
  assert.ok(await waitFor(() => exists(spec.args[0])), run.stderr);
  // The launcher releases both locks right after spawning (once the child's lease owner is recorded),
  // so the server can write its file first. Wait for release instead of sampling at that instant.
  assert.ok(await waitFor(async () => !(await exists(installLock)) && !(await exists(storeLock))), "both locks are released while the server keeps running");
  assert.equal(run.child.exitCode, null, "the server is still running after the locks are released");
  run.child.stdin.end(); await run.exited;
}));

test("SIGTERM while waiting for the store lock exits promptly and leaves no lock behind", () => fixture(async ({ spec, launch, installLock, storeLock }) => {
  const releaseStore = await m.acquireManagedLock(spec.coordinationRoot, spec.lockName);
  try {
    const run = launch();
    await sleep(400);
    const started = Date.now();
    run.child.kill("SIGTERM");
    const { code } = await run.exited;
    assert.notEqual(code, 0);
    assert.ok(Date.now() - started < 2000, "exits well inside Pi's 2.5 s SIGKILL window");
    assert.match(run.stderr, /cancelled/);
    assert.equal(await exists(installLock), false);
    assert.ok(await exists(storeLock), "only our own held lock remains");
    assert.deepEqual(await m.activeConsumers(spec.leaseRoot), []);
  } finally { await releaseStore(); }
}));

test("launcher escalates to SIGKILL inside Pi's 2.5 s shutdown window", () => fixture(async ({ spec, launch }) => {
  const run = launch();
  assert.ok(await waitFor(() => exists(spec.args[0])), run.stderr);
  await sleep(100);
  const started = Date.now();
  run.child.stdin.end(); // server ignores EOF and SIGTERM
  await run.exited;
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 900 && elapsed < 3000, `escalation took ${elapsed} ms`);
  assert.deepEqual(await m.activeConsumers(spec.leaseRoot), [], "leases released after the server is killed");
}, { ignoreShutdown: true }));
