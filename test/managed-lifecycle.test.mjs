import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, lstat, chmod, symlink, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const m = await jiti.import("../src/managed-lifecycle.ts");
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "wb-lifecycle-"));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("managed paths reject escapes, symlink ancestry and unsafe permissions", () => fixture(async (root) => {
  assert.throws(() => m.assertWithin(root, join(root, "..", "escape")), /escapes/);
  await m.ensurePrivateDirectory(root, join(root, "private", "child"));
  assert.equal((await lstat(join(root, "private"))).mode & 0o777, 0o700);
  await symlink(join(root, "private"), join(root, "link"));
  await assert.rejects(m.ensurePrivateDirectory(root, join(root, "link", "child")), /Symlink/);
  await chmod(join(root, "private"), 0o755);
  await m.ensurePrivateDirectory(root, join(root, "private"));
  assert.equal((await lstat(join(root, "private"))).mode & 0o777, 0o700, "repair unsafe permission bits");
  await rm(join(root, "link"), { force: true });
  await symlink(join(root, "private"), join(root, "link"));
  await assert.rejects(m.ensurePrivateDirectory(root, join(root, "link")), /Symlink/);
}));

test("metadata publication replaces complete JSON privately and rejects symlinks", () => fixture(async (root) => {
  const path = join(root, "metadata.json");
  await m.publishJson(root, path, { schemaVersion: 1 });
  await m.publishJson(root, path, { schemaVersion: 2 });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { schemaVersion: 2 });
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  await symlink(path, join(root, "alias.json"));
  await assert.rejects(m.publishJson(root, join(root, "alias.json"), {}), /Symlink/);
}));

test("managed locks exclude concurrent consumers and release only their token", () => fixture(async (root) => {
  const release = await m.acquireManagedLock(root, "activation");
  await assert.rejects(m.acquireManagedLock(root, "activation", { timeoutMs: 5, retryMs: 1 }), /busy/);
  await release();
  await (await m.acquireManagedLock(root, "activation"))();
  const releaseChanged = await m.acquireManagedLock(root, "activation");
  await m.publishJson(root, join(root, "activation.lock", "owner.json"), { token: "other" });
  await assert.rejects(releaseChanged(), /ownership changed/);
  assert.ok(await lstat(join(root, "activation.lock")));
}));

test("stale birth identity is not PID ownership and lock stealing is refused", () => fixture(async (root) => {
  const owner = await m.ownIdentity();
  assert.equal(await m.identityLive(owner), true);
  assert.equal(await m.identityLive({ ...owner, start: "reused-pid" }), false);
  await assert.rejects(m.identityLive({ ...owner, host: "" }), /Unknown managed consumer identity/);
  await assert.rejects(m.identityLive({ pid: owner.pid, start: owner.start }), /Unknown managed consumer identity/);
  await m.ensurePrivateDirectory(root, join(root, "stale.lock"));
  await m.publishJson(root, join(root, "stale.lock", "owner.json"), { schemaVersion: 1, token: "stale", ...owner, start: "reused-pid" });
  await assert.rejects(m.acquireManagedLock(root, "stale"), /Stale managed lock/);
  assert.ok(await lstat(join(root, "stale.lock")), "retains recovery evidence; no ABA lock stealing");
}));

test("consumer leases count peers by resource and release idempotently", () => fixture(async (root) => {
  const a = await m.createConsumerLease(root, "proxy");
  const b = await m.createConsumerLease(root, "memory");
  assert.deepEqual(await m.activeConsumers(root, "proxy"), [a.token]);
  assert.equal((await m.activeConsumers(root)).length, 2);
  await a.release(); await a.release();
  assert.deepEqual(await m.activeConsumers(root), [b.token]);
  await b.release();
  await writeFile(join(root, "unknown"), "not an attested lease");
  await assert.rejects(m.activeConsumers(root), /Unknown/);
}));

test("space preflight rejects invalid, unavailable and insufficient capacity", () => fixture(async (root) => {
  await m.requireDiskSpace(root, 10, async () => ({ bavail: 20, bsize: 1 }));
  await assert.rejects(m.requireDiskSpace(root, 30, async () => ({ bavail: 20, bsize: 1 })), /Insufficient/);
  await assert.rejects(m.requireDiskSpace(root, 1, async () => { throw new Error("unsupported statfs"); }), /unsupported/);
  await assert.rejects(m.requireDiskSpace(root, -1), /Invalid/);
}));

async function stores(root) {
  const live = join(root, "live"), stage = join(root, "stage"), backup = join(root, "backup");
  await mkdir(live); await mkdir(stage);
  await writeFile(join(live, "db"), "original"); await writeFile(join(stage, "db"), "candidate");
  return { live, stage, backup };
}
test("treeBytes counts regular data and rejects symlink contents", () => fixture(async (root) => {
  const { live, stage } = await stores(root);
  assert.equal(await m.treeBytes(live), 8);
  await symlink(join(stage, "db"), join(live, "linked"));
  await assert.rejects(m.treeBytes(live), /Symlink/);
}));


test("untrusted writable parent cannot replace an otherwise private managed root", () => fixture(async (root) => {
  const parent = join(root, "untrusted"), child = join(parent, "owned");
  await mkdir(parent); await chmod(parent, 0o777);
  await assert.rejects(m.ensurePrivateDirectory(child), /Unsafe writable ancestor/);
  await chmod(parent, 0o1777);
  await m.ensurePrivateDirectory(child);
  assert.equal((await lstat(child)).mode & 0o777, 0o700);
}));

test("ps runs with a fixed locale and time zone so Node and Python compare identical start times", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { readFile } = await import("node:fs/promises");
  const env = m.psEnvironment({ PATH: process.env.PATH, TZ: "Asia/Tokyo", LC_ALL: "de_DE.UTF-8", KEEP: "1" });
  assert.equal(env.TZ, "UTC"); assert.equal(env.LC_ALL, "C"); assert.equal(env.KEEP, "1");
  assert.equal(m.psEnvironment({}).TZ, "UTC");
  // Python monitor must use the same environment (its own environment is filtered).
  const python = await readFile(new URL("../src/managed-proxy.py", import.meta.url), "utf8");
  assert.match(python, /"LC_ALL": "C", "TZ": "UTC"/);
  assert.match(python, /\["ps", "-p", str\(pid\), "-o", "lstart="\], timeout=5, text=True, env=ps_env/);
  // Mechanism check on hosts with ps: different caller time zones give one result.
  const run = (tz) => promisify(execFile)("ps", ["-p", String(process.pid), "-o", "lstart="], { env: m.psEnvironment({ PATH: process.env.PATH, TZ: tz }) });
  let a, b;
  try { a = (await run("Asia/Tokyo")).stdout; b = (await run("America/New_York")).stdout; } catch { return t.skip("ps unavailable"); }
  assert.equal(a, b);
});

async function deadPid() {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  await new Promise((resolve) => child.once("close", resolve));
  return child.pid;
}

test("a record written under another host name is live only while that exact process exists", () => fixture(async () => {
  const owner = await m.ownIdentity();
  // Renamed laptop: the same running process under an old host name is still live...
  assert.equal(await m.identityLive({ ...owner, host: "old-laptop-name" }), true);
  // ...but a different birth identity (reused PID) or a gone process is stale, never an error.
  assert.equal(await m.identityLive({ ...owner, host: "old-laptop-name", start: "reused-pid" }), false);
  assert.equal(await m.identityLive({ pid: await deadPid(), start: "linux:1", host: "old-laptop-name" }), false);
}));

test("a hostname change neither blocks consumers nor keeps dead leases alive", () => fixture(async (root) => {
  const owner = await m.ownIdentity();
  const gone = await deadPid();
  await m.ensurePrivateDirectory(root);
  const write = (token, record) => m.publishJson(root, join(root, `${token}.json`), { schemaVersion: 1, token, resource: "proxy", ...record });
  await write("aaaaaaaa-0000-0000-0000-00000000000a", { ...owner, host: "renamed-host" });
  await write("bbbbbbbb-0000-0000-0000-00000000000b", { pid: gone, start: "linux:1", host: "renamed-host" });
  const live = await m.activeConsumers(root, "proxy");
  assert.equal(live.length, 1, "only the live process counts; no 'foreign identity' failure");
}));

test("dead lease files are removed while live ones stay, and release tolerates a removed lease", () => fixture(async (root) => {
  const live = await m.createConsumerLease(root, "proxy");
  const doomed = await m.createConsumerLease(root, "proxy");
  const owner = await m.ownIdentity();
  const deadToken = "cccccccc-0000-0000-0000-000000000001";
  await m.publishJson(root, join(root, `${deadToken}.json`), { schemaVersion: 1, token: deadToken, resource: "proxy", pid: await deadPid(), start: "linux:1", host: owner.host });
  const reused = "cccccccc-0000-0000-0000-000000000002";
  await m.publishJson(root, join(root, `${reused}.json`), { schemaVersion: 1, token: reused, resource: "proxy", ...owner, start: "reused-pid" });
  assert.deepEqual((await m.activeConsumers(root, "proxy")).sort(), [live.token, doomed.token].sort());
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual((await readdir(root)).sort(), [`${live.token}.json`, `${doomed.token}.json`].sort(), "dead and PID-reused leases are gone");
  await rm(join(root, `${doomed.token}.json`));
  await doomed.release(); // already removed: nothing to release, no error
  await live.release();
}));

test("a lock held by a live process under an old host name is busy, not stale; a dead owner is stale and kept", () => fixture(async (root) => {
  const owner = await m.ownIdentity();
  await m.ensurePrivateDirectory(root, join(root, "busy.lock"));
  await m.publishJson(root, join(root, "busy.lock", "owner.json"), { schemaVersion: 1, token: "t", ...owner, host: "old-laptop-name" });
  await assert.rejects(m.acquireManagedLock(root, "busy", { timeoutMs: 20, retryMs: 5 }), /busy/);
  await m.ensurePrivateDirectory(root, join(root, "dead.lock"));
  await m.publishJson(root, join(root, "dead.lock", "owner.json"), { schemaVersion: 1, token: "t", pid: await deadPid(), start: "linux:1", host: "old-laptop-name" });
  await assert.rejects(m.acquireManagedLock(root, "dead"), new RegExp(`Stale managed lock; verify quiescence and remove manually: ${join(root, "dead.lock").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.ok(await lstat(join(root, "dead.lock")), "never stolen");
}));

test("leases released while activeConsumers is scanning are not an error and not counted", () => fixture(async (root) => {
  const leases = [];
  for (let i = 0; i < 150; i++) leases.push(await m.createConsumerLease(root, "proxy"));
  const kept = await m.createConsumerLease(root, "proxy");
  // Release everything else concurrently with the scan; a vanished entry must be skipped, never thrown.
  const releasing = (async () => { for (const lease of leases) { await lease.release(); } })();
  for (let round = 0; round < 5; round++) {
    const active = await m.activeConsumers(root, "proxy");
    assert.ok(active.includes(kept.token));
  }
  await releasing;
  assert.deepEqual(await m.activeConsumers(root, "proxy"), [kept.token]);
}));

test("H2: directories an earlier version left group/other-writable are repaired to owner-only", () => fixture(async (root) => {
  const managed = join(root, "managed");
  const deep = join(managed, "bin", "v1", "linux-arm64");
  await mkdir(deep, { recursive: true });
  for (const dir of [managed, join(managed, "bin"), join(managed, "bin", "v1"), deep]) await chmod(dir, 0o775);
  await m.ensurePrivateDirectory(managed, deep);
  for (const dir of [managed, join(managed, "bin"), join(managed, "bin", "v1"), deep]) {
    assert.equal((await lstat(dir)).mode & 0o777, 0o700, dir);
  }
  await m.assertNoSymlink(deep);
}));

test("H2: repair never reaches above the managed root, and symlinks inside it are still refused", () => fixture(async (root) => {
  const parent = join(root, "parent"); const managed = join(parent, "managed");
  await mkdir(managed, { recursive: true });
  await chmod(parent, 0o775); await chmod(managed, 0o775);
  await assert.rejects(m.ensurePrivateDirectory(managed), /Unsafe writable ancestor/);
  assert.equal((await lstat(parent)).mode & 0o777, 0o775, "the ancestor is left alone");
  assert.equal((await lstat(managed)).mode & 0o777, 0o775, "nothing is repaired when the ancestors are unsafe");
  await chmod(parent, 0o700);
  const outside = join(root, "outside"); await mkdir(outside); await chmod(outside, 0o775);
  await symlink(outside, join(managed, "link"));
  await assert.rejects(m.ensurePrivateDirectory(managed, join(managed, "link", "child")), /Symlink/);
  assert.equal((await lstat(outside)).mode & 0o777, 0o775, "a symlink target is never chmodded");
  await m.ensurePrivateDirectory(managed);
  assert.equal((await lstat(managed)).mode & 0o777, 0o700);
}));
