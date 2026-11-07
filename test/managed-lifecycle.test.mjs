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
  await m.publishJson(root, path, { schema: 1 });
  await m.publishJson(root, path, { schema: 2 });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { schema: 2 });
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
  await assert.rejects(m.identityLive({ ...owner, host: "other-host" }), /foreign/);
  await m.ensurePrivateDirectory(root, join(root, "stale.lock"));
  await m.publishJson(root, join(root, "stale.lock", "owner.json"), { schema: 1, token: "stale", ...owner, start: "reused-pid" });
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
test("promotion retains original snapshot and counts full regular data", () => fixture(async (root) => {
  const { live, stage, backup } = await stores(root);
  assert.equal(await m.treeBytes(live), 8);
  await m.promoteDirectory(root, live, stage, backup);
  assert.equal(await readFile(join(live, "db"), "utf8"), "candidate");
  assert.equal(await readFile(join(backup, "db"), "utf8"), "original");
}));

test("failed promotion restores original; failed restoration retains recovery data", () => fixture(async (root) => {
  const { live, stage, backup } = await stores(root);
  await assert.rejects(m.promoteDirectory(root, live, stage, backup, {
    rename: async (from, to) => { if (from === stage) throw new Error("injected promotion failure"); await rename(from, to); },
  }), /original restored/);
  assert.equal(await readFile(join(live, "db"), "utf8"), "original");
  await assert.rejects(m.promoteDirectory(root, live, stage, backup, {
    rename: async (from, to) => { if (from !== live) throw new Error("injected failure"); await rename(from, to); },
  }), /Publication and restoration failed/);
  assert.equal(await readFile(join(backup, "db"), "utf8"), "original");
  assert.equal(await readFile(join(stage, "db"), "utf8"), "candidate");
}));

test("backups and promotions reject overwrite, nested targets and symlink contents", () => fixture(async (root) => {
  const { live, stage, backup } = await stores(root);
  await mkdir(backup);
  await assert.rejects(m.promoteDirectory(root, live, stage, backup), /already exists/);
  await assert.rejects(m.promoteDirectory(root, live, join(live, "nested"), join(root, "other")), /Overlapping/);
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
