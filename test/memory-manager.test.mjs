import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename as renamePath, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  createMcpEnvironment,
  createPreflightEnvironment,
  MemoryManager,
  MEMORY_SERVER_NAME,
} = await jiti.import("../src/memory-manager.ts");
const execFileAsync = promisify(execFile);

test("MemoryManager: creates configured Memory root without creating project store", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-headroom-memory-root-create-"));
  const root = join(tempDir, "missing-memory-root");
  try {
    const manager = new MemoryManager({
      cwd: join(tempDir, "project"),
      root,
      userId: "tester",
      ensurePython: async () => "/managed/python",
    });
    assert.equal(existsSync(root), false);
    await manager.ensureRoot();
    assert.equal(existsSync(root), true);
    assert.equal(manager.enabled, false);
    assert.equal(existsSync(manager.store.directory), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryManager: preflights ONNX and produces direct local MCP configuration", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-headroom-memory-manager-"));
  const project = join(tempDir, "project");
  const root = join(tempDir, "memory-root");
  const processCalls = [];
  const statuses = [];

  try {
    const manager = new MemoryManager({
      cwd: project,
      root,
      userId: "tester",
      ensurePython: async () => "/managed/python",
      runProcess: async (command, args, options) => {
        processCalls.push({ command, args, options });
      },
    });

    assert.equal(manager.enabled, false);
    assert.equal(await manager.prepare((message) => statuses.push(message)), "/managed/python");
    assert.equal(processCalls.length, 1);
    assert.equal(processCalls[0].command, "/managed/python");
    assert.deepEqual(processCalls[0].args.slice(0, 1), ["-c"]);
    assert.match(processCalls[0].args[1], /OnnxLocalEmbedder/);
    assert.match(processCalls[0].args[1], /embed\('Headroom Memory ONNX preflight'\)/);
    assert.equal(processCalls[0].options.env.HEADROOM_EMBEDDER_RUNTIME, undefined);
    assert.equal(processCalls[0].options.env.HF_HUB_OFFLINE, "0");
    assert.ok(statuses.some((message) => message.includes("ONNX model")));

    await manager.createStore();
    assert.equal(manager.enabled, true);

    const config = manager.getMcpConfig("/managed/python");
    assert.equal(MEMORY_SERVER_NAME, "headroom-memory");
    assert.equal(config.command, process.execPath);
    const spec = JSON.parse(config.args[1]);
    assert.equal(spec.command, "/managed/python");
    assert.deepEqual(spec.args.slice(0, 3), ["-m", "headroom.memory.mcp_server", "--db"]);
    assert.equal(spec.args.at(-1), "tester");
    assert.equal(config.exposure, "direct");
    assert.equal(config.timeout, 60);
    assert.equal(config.env, undefined, "nothing is registered through Pi's merged, interpolated env");
    assert.equal(spec.env.HEADROOM_EMBEDDER_RUNTIME, undefined);
    assert.equal(spec.env.HF_HUB_OFFLINE, "1");
    assert.equal(spec.env.TRANSFORMERS_OFFLINE, "1");

    await manager.deleteStore();
    assert.equal(manager.enabled, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Memory environments: remove MPS override and control offline mode", () => {
  const source = {
    HEADROOM_EMBEDDER_RUNTIME: "pytorch_mps",
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    SAFE_VALUE: "present",
    OMITTED: undefined,
  };

  const preflight = createPreflightEnvironment(source);
  const mcp = createMcpEnvironment(source);

  assert.equal(preflight.HEADROOM_EMBEDDER_RUNTIME, undefined);
  assert.equal(preflight.HF_HUB_OFFLINE, "0");
  assert.equal(preflight.TRANSFORMERS_OFFLINE, "0");
  assert.equal(mcp.HEADROOM_EMBEDDER_RUNTIME, undefined);
  assert.equal(mcp.HF_HUB_OFFLINE, "1");
  assert.equal(mcp.TRANSFORMERS_OFFLINE, "1");
  assert.equal(mcp.SAFE_VALUE, "present");
  assert.equal("OMITTED" in mcp, false);
});

test("MemoryManager: export preserves arbitrary directory siblings and replaces owned names", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-headroom-memory-export-"));
  const project = join(tempDir, "project");
  const root = join(tempDir, "memory-root");

  try {
    await mkdir(project);
    const manager = new MemoryManager({ cwd: project, root, userId: "tester", exportPath: ".git" });
    await manager.createStore();
    await execFileAsync("python3", ["-c", [
      "import sqlite3, sys",
      "memory, graph = sys.argv[1:]",
      "sqlite3.connect(memory).execute('CREATE TABLE memories (id, content, user_id, session_id, agent_id, turn_id, created_at, valid_from, valid_until, category, importance, supersedes, superseded_by, promoted_from, promotion_chain, entity_refs, metadata)').connection.commit()",
      "conn = sqlite3.connect(graph)",
      "conn.execute('CREATE TABLE entities (id, user_id, name, entity_type, description, properties, created_at, updated_at, metadata)')",
      "conn.execute('CREATE TABLE relationships (id, user_id, source_id, target_id, relation_type, weight, properties, created_at, metadata)')",
      "conn.commit()",
    ].join("\n"), manager.store.databasePath, join(manager.store.directory, "memory_graph.db")]);

    const bundle = manager.store.exportDirectory;
    assert.ok(bundle);
    await mkdir(join(bundle, "memories"), { recursive: true });
    await writeFile(join(bundle, "HEAD"), "git metadata\n");
    await writeFile(join(bundle, "memories", "unrelated.json"), "old bundle record\n");

    assert.deepEqual(JSON.parse(await manager.exportBundle("python3")), { entities: 0, memories: 0, relationships: 0 });
    assert.equal(await readFile(join(bundle, "HEAD"), "utf8"), "git metadata\n");
    assert.equal(existsSync(join(bundle, "memories", "unrelated.json")), false);
    assert.equal(existsSync(join(bundle, "manifest.json")), true);

    await execFileAsync("python3", [
      join(process.cwd(), "src", "memory-bundle.py"), "validate",
      "--store", manager.store.directory,
      "--bundle", bundle,
      "--namespace", "tester",
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryManager: export restores original directory when replacement rename fails", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-headroom-memory-export-rollback-"));
  const project = join(tempDir, "project");
  const root = join(tempDir, "memory-root");

  try {
    await mkdir(project);
    let failInstall = false;
    const manager = new MemoryManager({
      cwd: project,
      root,
      userId: "tester",
      exportPath: ".git",
      rename: async (oldPath, newPath) => {
        if (failInstall && newPath === manager.store.exportDirectory && oldPath.endsWith("/bundle")) {
          throw new Error("simulated replacement failure");
        }
        await renamePath(oldPath, newPath);
      },
    });
    await manager.createStore();
    await execFileAsync("python3", ["-c", [
      "import sqlite3, sys",
      "memory, graph = sys.argv[1:]",
      "sqlite3.connect(memory).execute('CREATE TABLE memories (id, content, user_id, session_id, agent_id, turn_id, created_at, valid_from, valid_until, category, importance, supersedes, superseded_by, promoted_from, promotion_chain, entity_refs, metadata)').connection.commit()",
      "conn = sqlite3.connect(graph)",
      "conn.execute('CREATE TABLE entities (id, user_id, name, entity_type, description, properties, created_at, updated_at, metadata)')",
      "conn.execute('CREATE TABLE relationships (id, user_id, source_id, target_id, relation_type, weight, properties, created_at, metadata)')",
      "conn.commit()",
    ].join("\n"), manager.store.databasePath, join(manager.store.directory, "memory_graph.db")]);

    const bundle = manager.store.exportDirectory;
    assert.ok(bundle);
    await mkdir(join(bundle, "memories"), { recursive: true });
    await writeFile(join(bundle, "HEAD"), "original git metadata\n");
    await writeFile(join(bundle, "memories", "old.json"), "original record\n");

    failInstall = true;
    await assert.rejects(manager.exportBundle("python3"), /simulated replacement failure/);
    assert.equal(await readFile(join(bundle, "HEAD"), "utf8"), "original git metadata\n");
    assert.equal(await readFile(join(bundle, "memories", "old.json"), "utf8"), "original record\n");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Memory bundle validation rejects symlinked manifest, record, and record directory", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-headroom-memory-bundle-symlink-"));
  const bundle = join(tempDir, "bundle");
  const external = join(tempDir, "external");
  const manifest = JSON.stringify({ version: 1, namespace: "tester", files: [] });
  const validate = async () => assert.rejects(
    execFileAsync("python3", [
      join(process.cwd(), "src", "memory-bundle.py"), "validate",
      "--store", tempDir, "--bundle", bundle, "--namespace", "tester",
    ]),
    /symbolic link/,
  );

  try {
    await mkdir(external);

    await mkdir(bundle);
    await writeFile(join(external, "manifest.json"), manifest);
    await symlink(join(external, "manifest.json"), join(bundle, "manifest.json"));
    await validate();
    await rm(bundle, { recursive: true, force: true });

    const record = `${JSON.stringify({ id: "record", user_id: "tester" })}\n`;
    const digest = createHash("sha256").update(record).digest("hex");
    const listedManifest = JSON.stringify({
      version: 1,
      namespace: "tester",
      files: [{ path: "memories/record.json", sha256: digest }],
    });
    await mkdir(join(bundle, "memories"), { recursive: true });
    await mkdir(join(bundle, "entities"));
    await mkdir(join(bundle, "relationships"));
    await writeFile(join(bundle, "manifest.json"), listedManifest);
    await writeFile(join(external, "record.json"), record);
    await symlink(join(external, "record.json"), join(bundle, "memories", "record.json"));
    await validate();
    await rm(bundle, { recursive: true, force: true });

    await mkdir(join(bundle, "entities"), { recursive: true });
    await mkdir(join(bundle, "relationships"));
    await writeFile(join(bundle, "manifest.json"), listedManifest);
    await mkdir(join(external, "memories"));
    await writeFile(join(external, "memories", "record.json"), record);
    await symlink(join(external, "memories"), join(bundle, "memories"));
    await validate();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MemoryManager: preflight failure is fail-open", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-headroom-memory-fail-"));
  try {
    const manager = new MemoryManager({
      cwd: join(tempDir, "project"),
      root: join(tempDir, "memory-root"),
      userId: "tester",
      ensurePython: async () => "/managed/python",
      runProcess: async () => {
        throw new Error("ONNX unavailable");
      },
    });
    const statuses = [];
    assert.equal(await manager.prepare((message) => statuses.push(message)), null);
    assert.equal(manager.enabled, false);
    assert.ok(statuses.some((message) => message.includes("preflight failed: ONNX unavailable")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("M13: show returns output larger than Node's default 1 MiB execFile buffer", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-headroom-memory-show-"));
  const project = join(tempDir, "project");
  try {
    await mkdir(project);
    const manager = new MemoryManager({ cwd: project, root: join(tempDir, "memory-root"), userId: "tester" });
    await manager.createStore();
    const fakePython = join(tempDir, "fake-python");
    await writeFile(fakePython, `#!${process.execPath}\nprocess.stdout.write("x".repeat(3 * 1024 * 1024));\n`, { mode: 0o755 });
    const output = await manager.showBundle(fakePython);
    assert.equal(output.length, 3 * 1024 * 1024);
  } finally { await rm(tempDir, { recursive: true, force: true }); }
});

test("M8: merge and import ask the bundle script to derive the manifest; strict validation elsewhere is unchanged", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-headroom-memory-derive-"));
  try {
    await mkdir(join(tempDir, "project"));
    const manager = new MemoryManager({ cwd: join(tempDir, "project"), root: join(tempDir, "memory-root"), userId: "tester", exportPath: ".headroom-memory" });
    await manager.createStore();
    const calls = [];
    manager.runBundle = async (python, operation, store, bundle, options) => { calls.push([operation, options?.deriveManifest === true]); return "{}"; };
    await manager.mergeBundle("python3");
    await manager.importBundle("python3");
    assert.deepEqual(calls, [["validate", true], ["merge", true], ["validate", true], ["replace", true]]);
  } finally { await rm(tempDir, { recursive: true, force: true }); }
});

async function stubbedManager(options = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-headroom-memory-nobackup-"));
  await mkdir(join(tempDir, "project"));
  const manager = new MemoryManager({ cwd: join(tempDir, "project"), root: join(tempDir, "memory-root"), userId: "tester", exportPath: ".headroom-memory", ...options });
  await manager.createStore();
  await writeFile(join(manager.store.directory, "sentinel"), "original");
  // The bundle script is replaced by a stand-in that writes the new content into the staged directory.
  manager.runBundle = async (_python, operation, store, bundle) => {
    if (operation === "replace" || operation === "merge") await writeFile(join(store, "sentinel"), "replacement");
    if (operation === "export") {
      for (const name of ["memories", "entities", "relationships"]) await mkdir(join(bundle, name), { recursive: true });
      await writeFile(join(bundle, "manifest.json"), "{}");
    }
    return "{}";
  };
  await mkdir(manager.store.exportDirectory, { recursive: true });
  return { tempDir, manager, beside: async directory => (await readdir(dirname(directory))).filter(name => /backup|\.pi-workbench-memory-/.test(name)) };
}

test("L10: import replaces the store and leaves no backup or staging beside it", async () => {
  const { tempDir, manager, beside } = await stubbedManager();
  try {
    assert.equal(await manager.importBundle("python3"), "{}");
    assert.equal(await readFile(join(manager.store.directory, "sentinel"), "utf8"), "replacement");
    assert.deepEqual(await beside(manager.store.directory), []);
    assert.equal(manager.recoveryPending, false);
  } finally { await rm(tempDir, { recursive: true, force: true }); }
});

test("L10: a failed import install restores the old store and the journal names a backup inside staging", async () => {
  let fail = false, journal;
  const { tempDir, manager, beside } = await stubbedManager({ rename: async (from, to) => {
    if (fail && from.endsWith("/store")) { journal = await readFile(manager.pendingPath, "utf8"); throw new Error("simulated install failure"); }
    await renamePath(from, to);
  } });
  try {
    fail = true;
    await assert.rejects(manager.importBundle("python3"), /simulated install failure/);
    assert.equal(await readFile(join(manager.store.directory, "sentinel"), "utf8"), "original");
    assert.match(JSON.parse(journal).backup, /\.pi-workbench-memory-import-[^/]+\/previous$/);
    assert.deepEqual(await beside(manager.store.directory), []);
    assert.equal(manager.recoveryPending, false);
  } finally { await rm(tempDir, { recursive: true, force: true }); }
});

test("L10: export leaves no backup beside the bundle, and two exports in the same second both succeed", async () => {
  const { tempDir, manager, beside } = await stubbedManager();
  try {
    await manager.exportBundle("python3");
    await manager.exportBundle("python3");
    assert.deepEqual(await beside(manager.store.exportDirectory), []);
    assert.equal(existsSync(join(manager.store.exportDirectory, "manifest.json")), true);
  } finally { await rm(tempDir, { recursive: true, force: true }); }
});

test("L10: two merges in the same second both succeed and each keeps its own backup beside the store", async () => {
  const { tempDir, manager } = await stubbedManager();
  try {
    await manager.mergeBundle("python3");
    await manager.mergeBundle("python3");
    const backups = (await readdir(dirname(manager.store.directory))).filter(name => name.includes(".merge-backup-"));
    assert.equal(backups.length, 2);
  } finally { await rm(tempDir, { recursive: true, force: true }); }
});

test("L14: every SQLite connection in the bundle script is closed, and before derived files are unlinked", async () => {
  const { stdout } = await execFileAsync("python3", ["-I", join(process.cwd(), "test", "helpers", "bundle-closes-connections.py"), join(process.cwd(), "src", "memory-bundle.py")]);
  const report = JSON.parse(stdout);
  assert.ok(report.opened >= 5, `expected the replace, merge and read connections, saw ${report.opened}`);
  assert.deepEqual({ allClosed: report.allClosed, closedBeforeUnlink: report.closedBeforeUnlink }, { allClosed: true, closedBeforeUnlink: true });
});
