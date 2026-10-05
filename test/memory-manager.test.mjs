import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename as renamePath, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    assert.equal(config.command, "/managed/python");
    assert.deepEqual(config.args.slice(0, 3), ["-m", "headroom.memory.mcp_server", "--db"]);
    assert.equal(config.args.at(-1), "tester");
    assert.equal(config.exposure, "direct");
    assert.equal(config.timeout, 60);
    assert.equal(config.env.HEADROOM_EMBEDDER_RUNTIME, undefined);
    assert.equal(config.env.HF_HUB_OFFLINE, "1");
    assert.equal(config.env.TRANSFORMERS_OFFLINE, "1");

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
