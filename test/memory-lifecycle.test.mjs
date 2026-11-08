import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { MemoryManager } = await jiti.import("../src/memory-manager.ts");
const { createConsumerLease, publishJson } = await jiti.import("../src/managed-lifecycle.ts");
async function fixture(fn, renameOperation) {
  const root = await mkdtemp(join(tmpdir(), "wb-memory-lifecycle-"));
  const project = join(root, "project"); await mkdir(project);
  let pythonCalls = 0;
  const manager = new MemoryManager({ cwd: project, root: join(root, "configured-base"), userId: "fixture",
    ensurePython: async () => { pythonCalls++; return "/fixture/python"; },
    runProcess: async () => {}, rename: renameOperation });
  try { await fn({ root, project, manager, pythonCalls: () => pythonCalls }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("custom root never adopts old physical database as fresh opt-in", () => fixture(async ({ root, manager }) => {
  const old = join(root, "configured-base", "projects", manager.store.identifier);
  await mkdir(old, { recursive: true }); await writeFile(join(old, "memory.db"), "old sentinel");
  assert.equal(manager.enabled, false);
  assert.ok(manager.store.directory.includes("workbench-memory-v1"));
  await manager.createStore(); assert.equal(manager.enabled, true);
  assert.equal(await readFile(join(old, "memory.db"), "utf8"), "old sentinel");
  assert.equal(JSON.parse(await readFile(join(manager.store.directory, "workbench-identity.json"), "utf8")).kind, "memory");
}));

test("unmarked database in new namespace is rejected rather than adopted", () => fixture(async ({ manager, pythonCalls }) => {
  await manager.ensureRoot(); await mkdir(manager.store.directory, { recursive: true, mode: 0o700 });
  await writeFile(manager.store.databasePath, "unknown database");
  assert.equal(manager.enabled, false);
  await assert.rejects(manager.createStore(), /Headroom Memory data was written by another version/);
  assert.equal(await readFile(manager.store.databasePath, "utf8"), "unknown database");
  assert.equal(pythonCalls(), 0);
}));

test("incompatible Memory identity fails before Python/model/store opening", () => fixture(async ({ manager, pythonCalls }) => {
  await manager.createStore();
  const marker = join(manager.store.directory, "workbench-identity.json");
  const identity = JSON.parse(await readFile(marker, "utf8")); identity.headroomVersion = "0.1.0";
  await writeFile(marker, JSON.stringify(identity)); const messages = [];
  assert.equal(await manager.prepare(message => messages.push(message)), null);
  assert.match(messages.join("\n"), /Headroom Memory data was written by another version, which this release does not read\. It was left unchanged\./); assert.equal(pythonCalls(), 0);
}));

test("live Memory peer protects store from deletion and allows later safe retry", () => fixture(async ({ manager }) => {
  await manager.createStore();
  const peer = await createConsumerLease(join(manager.store.root, "consumers", manager.store.identifier), manager.store.directory);
  try {
    await assert.rejects(manager.deleteStore(), /store busy/);
    assert.equal(manager.enabled, true);
  } finally { await peer.release(); }
  await manager.deleteStore(); assert.equal(manager.enabled, false);
}));

test("caught physical promotion failure restores old store and clears pending intent", async () => {
  let live, stage;
  await fixture(async ({ manager }) => {
    await manager.createStore(); live = manager.store.directory;
    await writeFile(join(live, "sentinel"), "original");
    stage = join(manager.store.root, "candidate"); await mkdir(stage); await writeFile(join(stage, "sentinel"), "candidate");
    await assert.rejects(manager.swapStagedDirectory(stage, live, live + ".backup", true), /injected promotion/);
    assert.equal(await readFile(join(live, "sentinel"), "utf8"), "original");
    assert.equal(manager.recoveryPending, false);
  }, async (from, to) => { if (from === stage) throw new Error("injected promotion"); await rename(from, to); });
});

test("failed restoration retains full old store, candidate and recovery identity", async () => {
  let live, stage, backup;
  await fixture(async ({ manager }) => {
    await manager.createStore(); live = manager.store.directory; backup = live + ".backup";
    await writeFile(join(live, "sentinel"), "original");
    stage = join(manager.store.root, "candidate"); await mkdir(stage); await writeFile(join(stage, "sentinel"), "candidate");
    await assert.rejects(manager.swapStagedDirectory(stage, live, backup, true), /Automatic restore failed/);
    assert.equal(manager.recoveryPending, true);
    assert.equal(await readFile(join(backup, "sentinel"), "utf8"), "original");
    assert.equal(await readFile(join(stage, "sentinel"), "utf8"), "candidate");
    await assert.rejects(manager.createStore(), /Incomplete Memory publication/);
    assert.equal(existsSync(live), false);
  }, async (from, to) => { if (from === stage || from === backup) throw new Error("injected replacement/restore"); await rename(from, to); });
});

test("interrupted Memory swap cannot silently recreate a missing store", () => fixture(async ({ manager }) => {
  await manager.createStore(); const backup = manager.store.directory + ".backup-interrupted";
  await rename(manager.store.directory, backup);
  const coordination = join(manager.store.root, "coordination");
  await publishJson(coordination, join(coordination, manager.store.identifier + ".pending.json"), { live: manager.store.directory, backup });
  await assert.rejects(manager.createStore(), /Incomplete Memory publication/);
  assert.equal(existsSync(manager.store.directory), false);
  assert.ok((await readdir(backup)).includes("memory.db"));
}));


test("embedding asset change cannot reuse existing vectors even at same package/model/dimension", () => fixture(async ({ root, project }) => {
  let modelHash = "a".repeat(64);
  const manager = new MemoryManager({ cwd: project, root: join(root, "model-bound-store"),
    ensurePython: async () => "/fixture/python",
    runProcess: async () => JSON.stringify({ modelSha256: modelHash, tokenizerSha256: "b".repeat(64), modelRevision: "c".repeat(40) }),
  });
  assert.equal(await manager.prepare(() => {}), "/fixture/python"); await manager.createStore();
  await writeFile(manager.store.databasePath, "existing vector/data sentinel");
  const marker = join(manager.store.directory, "workbench-identity.json");
  const original = await readFile(marker, "utf8");
  modelHash = "d".repeat(64); const messages = [];
  assert.equal(await manager.prepare(message => messages.push(message)), null);
  assert.match(messages.join("\n"), /Headroom Memory data was written by another version, which this release does not read\. It was left unchanged\./);
  assert.equal(await readFile(marker, "utf8"), original);
  assert.equal(await readFile(manager.store.databasePath, "utf8"), "existing vector/data sentinel");
}));


test("successful physical/logical swaps retain original backups without pruning", () => fixture(async ({ manager }) => {
  await manager.createStore(); const live = manager.store.directory;
  await writeFile(join(live, "sentinel"), "original");
  const stage = join(manager.store.root, "candidate"); await mkdir(stage);
  await writeFile(join(stage, "sentinel"), "replacement");
  const backup = live + ".backup";
  await manager.swapStagedDirectory(stage, live, backup);
  assert.equal(await readFile(join(live, "sentinel"), "utf8"), "replacement");
  assert.equal(await readFile(join(backup, "sentinel"), "utf8"), "original");
}));
