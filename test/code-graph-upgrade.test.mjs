import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { fakeCbmSource } from "./helpers/fake-cbm.mjs";
const jiti = createJiti(import.meta.url);
const { CodeGraphManager } = await jiti.import("../src/code-graph-manager.ts");
const { resolveWorkbenchPaths } = await jiti.import("../src/paths.ts");
const { resolveCodeGraphProject, createCodeGraphState } = await jiti.import("../src/code-graph-config.ts");
const { getAsset, resolveAssetUrl } = await jiti.import("../src/code-graph-assets.ts");
const { createConsumerLease } = await jiti.import("../src/managed-lifecycle.ts");
const { captureAuthoredData, authoredFingerprint } = await jiti.import("../src/code-graph-upgrade.ts");
async function fixture(fn, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "wb-auto-upgrade-"));
  const paths = resolveWorkbenchPaths(root); const workspace = join(root, "workspace"); await mkdir(workspace);
  const project = resolveCodeGraphProject(workspace, paths); await mkdir(project.directory, { recursive: true });
  const index = join(project.directory, workspace.replace(/^\//, "").replace(/\//g, "-") + ".db");
  const db = new DatabaseSync(index);
  db.exec(`CREATE TABLE project_summaries(project TEXT PRIMARY KEY, summary TEXT NOT NULL, source_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO project_summaries VALUES ('fixture','ADR sentinel','source','2020-01-01','2020-01-01');
    CREATE TABLE observed_calls(project TEXT NOT NULL, caller_qn TEXT NOT NULL, callee_qn TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', count INTEGER NOT NULL DEFAULT 1, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, PRIMARY KEY(project,caller_qn,callee_qn,label));
    INSERT INTO observed_calls VALUES ('fixture','caller','callee','fixture',12,'2020-01-01','2020-01-01');
    CREATE TABLE observed_paths(project TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', path_json TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, PRIMARY KEY(project,label,path_json));
    INSERT INTO observed_paths VALUES ('fixture','fixture','["caller","callee"]',3,'2020-01-01','2020-01-01');`);
  db.close();
  await writeFile(join(project.directory, "_config.db"), "auto_index = true\n");
  const old = createCodeGraphState(project, { version: "v0.8.1", resolvedUrl: "https://example.invalid/old.tar.gz", sha256: "a".repeat(64) });
  await writeFile(project.statePath, JSON.stringify(old));
  const asset = getAsset("linux-amd64").asset;
  const directory = join(paths.codeGraphBin, asset.version, "linux-amd64"); await mkdir(directory, { recursive: true });
  const binary = join(directory, "codebase-memory-mcp");
  const calls = join(root, "calls.log");
  await writeFile(binary, fakeCbmSource({ sqliteIndex: true, dropAuthored: true, callLog: calls }), { mode: 0o700 });
  const statuses = [], registrations = [];
  const manager = new CodeGraphManager({ paths, ...overrides,
    ensureInstalled: async () => ({ ...asset, path: binary, resolvedUrl: resolveAssetUrl(asset), reused: true }),
    onStatus: message => statuses.push(message), registerMcp: (_name, config) => registrations.push(config), unregisterMcp: () => {} });
  try { await fn({ root, paths, workspace, project, index, binary, manager, statuses, registrations, calls }); }
  finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
}

test("extension activation automatically stages upgrade, restores ADR/traces and retains exact old backup", () => fixture(async (fx) => {
  const original = authoredFingerprint(await captureAuthoredData(fx.project.directory));
  const result = await fx.manager.restore(fx.project);
  assert.equal(result.ok, true, result.detail);
  assert.equal(JSON.parse(await readFile(fx.project.statePath, "utf8")).version, "v0.12.1");
  assert.equal(authoredFingerprint(await captureAuthoredData(fx.project.directory)), original);
  const backups = (await readdir(join(fx.paths.codeGraphRuntime, "backups"))).filter(x => x.startsWith(fx.project.identifier + ".backup-"));
  assert.equal(backups.length, 1);
  const backup = join(fx.paths.codeGraphRuntime, "backups", backups[0]);
  assert.equal(JSON.parse(await readFile(join(backup, "state.json"), "utf8")).version, "v0.8.1");
  assert.equal(authoredFingerprint(await captureAuthoredData(backup)), original);
  const again = await fx.manager.restore(fx.project); assert.equal(again.ok, true, again.detail);
  assert.equal((await readFile(fx.calls, "utf8")).split("index-repository").length - 1, 1);
  assert.equal(fx.registrations.length, 2);
}));

test("automatic upgrade defers for peer leases and retries after quiescence", () => fixture(async (fx) => {
  const peer = await createConsumerLease(join(fx.paths.codeGraphRuntime, "consumers", fx.project.identifier), fx.project.directory);
  try {
    const blocked = await fx.manager.restore(fx.project);
    assert.equal(blocked.ok, false); assert.equal(blocked.kind, "upgrade_pending");
    assert.match(blocked.detail, /Active workspace consumers/);
    assert.equal(JSON.parse(await readFile(fx.project.statePath, "utf8")).version, "v0.8.1");
    assert.equal(fx.registrations.length, 0);
  } finally { await peer.release(); }
  const retried = await fx.manager.restore(fx.project); assert.equal(retried.ok, true, retried.detail);
}));

test("unleased pre-refactor CBM process blocks upgrade without being killed", () => fixture(async (fx) => {
  const child = spawn(process.execPath, [fx.binary], { env: { ...process.env, CBM_CACHE_DIR: fx.project.directory }, stdio: ["pipe", "pipe", "pipe"] });
  await once(child, "spawn");
  try {
    const blocked = await fx.manager.restore(fx.project);
    assert.equal(blocked.ok, false); assert.match(blocked.detail, /Active workspace consumers/);
    assert.equal(child.exitCode, null, "never terminate existing consumer");
    assert.equal(JSON.parse(await readFile(fx.project.statePath, "utf8")).version, "v0.8.1");
  } finally { const closed = once(child, "close"); child.stdin.end(); await closed; }
}));

test("unreadable/corrupt staging data defers upgrade and leaves original bytes unchanged", () => fixture(async (fx) => {
  await writeFile(fx.index, "not SQLite"); const original = await readFile(fx.index);
  const result = await fx.manager.restore(fx.project);
  assert.equal(result.ok, false); assert.equal(result.kind, "upgrade_pending");
  assert.deepEqual(await readFile(fx.index), original);
  assert.equal(JSON.parse(await readFile(fx.project.statePath, "utf8")).version, "v0.8.1");
  assert.equal(fx.registrations.length, 0);
}));


test("interrupted publication is detected before fresh activation can replace missing live data", () => fixture(async (fx) => {
  const { rename } = await import("node:fs/promises");
  const backup = fx.project.directory + ".backup-interrupted";
  await rename(fx.project.directory, backup);
  const coordination = join(fx.paths.codeGraphRuntime, "coordination");
  await mkdir(coordination, { recursive: true, mode: 0o700 });
  await writeFile(join(coordination, fx.project.identifier + ".pending.json"), JSON.stringify({ live: fx.project.directory, backup }));
  const result = await fx.manager.activate(fx.project);
  assert.equal(result.ok, false); assert.match(result.detail, /Incomplete publication/);
  assert.equal(JSON.parse(await readFile(join(backup, "state.json"), "utf8")).version, "v0.8.1");
  await assert.rejects(readFile(fx.project.statePath), { code: "ENOENT" });
}));

test("actual MCP child lease protects data after asynchronous unregister intent is released", { timeout: 15000 }, () => fixture(async (fx) => {
  const { activeConsumers } = await jiti.import("../src/managed-lifecycle.ts");
  const result = await fx.manager.restore(fx.project); assert.equal(result.ok, true, result.detail);
  const config = fx.registrations.at(-1);
  const child = spawn(config.command, config.args, { cwd: config.cwd, env: config.env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", data => { stderr += data; });
  try {
    const reply = once(child.stdout, "data");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    const [data] = await reply;
    assert.equal(JSON.parse(String(data).trim()).result.serverInfo.version, "0.12.1", stderr);
    const leases = join(fx.paths.codeGraphRuntime, "consumers", fx.project.identifier);
    assert.equal((await activeConsumers(leases)).length, 2, "frontend plus registration intent");
    await fx.manager.stop(fx.project);
    assert.equal((await activeConsumers(leases)).length, 1, "real child outlives asynchronous unregister callback");
    await assert.rejects(fx.manager.removeProject(fx.project), /Active workspace consumers/);
    const closed = once(child, "close"); child.stdin.end(); await closed;
    assert.equal((await activeConsumers(leases)).length, 0);
    await fx.manager.removeProject(fx.project);
    await assert.rejects(readFile(fx.project.statePath), { code: "ENOENT" });
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "close"); } }
}));


test("newer or same-version mismatched data never auto-downgrades/reinterprets", () => fixture(async (fx) => {
  for (const version of ["v0.13.0", "v0.12.1", "v0.7.0"]) {
    const state = JSON.parse(await readFile(fx.project.statePath, "utf8")); state.version = version;
    const serialized = JSON.stringify(state); await writeFile(fx.project.statePath, serialized);
    const before = await readFile(fx.index);
    const result = await fx.manager.restore(fx.project);
    assert.equal(result.ok, false); assert.equal(result.kind, "upgrade_pending");
    assert.match(result.detail, /No reviewed adapter/);
    assert.equal(await readFile(fx.project.statePath, "utf8"), serialized);
    assert.deepEqual(await readFile(fx.index), before);
    assert.equal(fx.registrations.length, 0);
  }
}));

test("late staging handshake after shutdown cannot publish or register", () => fixture(async (fx) => {
  let entered, finish;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { finish = resolve; });
  const asset = getAsset("linux-amd64").asset;
  const registrations = [];
  const manager = new CodeGraphManager({ paths: fx.paths,
    ensureInstalled: async () => ({ ...asset, path: fx.binary, resolvedUrl: resolveAssetUrl(asset), reused: true }),
    runMcpHandshake: async () => { entered(); await gate; return { ok: true, tools: ["fixture"] }; },
    registerMcp: (...args) => registrations.push(args) });
  const before = await readFile(fx.project.statePath, "utf8");
  const pending = manager.restore(fx.project);
  await started; await manager.shutdown(); finish();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(await readFile(fx.project.statePath, "utf8"), before);
  assert.equal(registrations.length, 0);
}));


for (const restoreFails of [false, true]) {
  test("Code Graph failed promotion " + (restoreFails ? "retains interrupted recovery intent" : "restores exact original and permits retry"), () => fixture(async (fx) => {
    const original = await readFile(fx.index), state = await readFile(fx.project.statePath, "utf8");
    const result = await fx.manager.restore(fx.project);
    assert.equal(result.ok, false); assert.match(result.detail, /injected promotion/);
    const pending = join(fx.paths.codeGraphRuntime, "coordination", fx.project.identifier + ".pending.json");
    if (restoreFails) {
      const intent = JSON.parse(await readFile(pending, "utf8"));
      assert.deepEqual(await readFile(join(intent.backup, fx.index.split("/").at(-1))), original);
      const again = await fx.manager.activate(fx.project);
      assert.equal(again.ok, false); assert.match(again.detail, /Incomplete publication/);
      await assert.rejects(readFile(fx.project.statePath), { code: "ENOENT" });
    } else {
      assert.deepEqual(await readFile(fx.index), original);
      assert.equal(await readFile(fx.project.statePath, "utf8"), state);
      await assert.rejects(readFile(pending), { code: "ENOENT" });
    }
    assert.equal(fx.registrations.length, 0);
  }, { promoteUpgrade: async (root, live, stage, backup) => {
    const { promoteDirectory } = await jiti.import("../src/managed-lifecycle.ts");
    const { rename } = await import("node:fs/promises");
    return promoteDirectory(root, live, stage, backup, { rename: async (from, to) => {
      if (from === stage || (restoreFails && from === backup)) throw new Error("injected promotion/restore failure");
      await rename(from, to);
    } });
  } }));
}

test("Code Graph upgraded cache and retained snapshots have private containment", () => fixture(async (fx) => {
  const result = await fx.manager.restore(fx.project); assert.equal(result.ok, true, result.detail);
  const { lstat } = await import("node:fs/promises");
  assert.equal((await lstat(fx.project.directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(fx.paths.codeGraphRuntime, "backups"))).mode & 0o777, 0o700);
}));


test("legacy ADR-only schema permits newly created empty trace tables without changing old rows", () => fixture(async (fx) => {
  const db = new DatabaseSync(fx.index); db.exec("DROP TABLE observed_calls; DROP TABLE observed_paths;"); db.close();
  const expected = await captureAuthoredData(fx.project.directory);
  const result = await fx.manager.restore(fx.project); assert.equal(result.ok, true, result.detail);
  const current = await captureAuthoredData(fx.project.directory);
  assert.equal(authoredFingerprint(current.map(item => ({ ...item, tables: item.tables.filter(table => table.table === "project_summaries") }))), authoredFingerprint(expected));
  assert.ok(current[0].tables.some(table => table.table === "observed_calls" && table.rows.length === 0));
}));
