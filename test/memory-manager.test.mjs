import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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
