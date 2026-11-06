import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
const config = await jiti.import("../src/headroom-config.ts");
const { DEFAULT_MEMORY_ROOT, parseMemoryNamespace, resolveMemoryRoot } = await jiti.import("../src/memory-config.ts");

test("Headroom config: bootstraps documented default once without overwriting user content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-headroom-config-"));
  const configPath = join(directory, "nested", "headroom.json");
  try {
    assert.equal(await config.ensureHeadroomConfigFile(configPath), true);
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { schemaVersion: 1, port: 8787 });
    await writeFile(configPath, '{"url":"http://127.0.0.1:9000"}\n');
    assert.equal(await config.ensureHeadroomConfigFile(configPath), false);
    assert.equal(await readFile(configPath, "utf8"), '{"url":"http://127.0.0.1:9000"}\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Headroom config: validates proxy, Memory, and compression values", () => {
  assert.deepEqual(config.parseHeadroomConfig({
    schemaVersion: 1,
    port: 9000,
    memory: { root: "/data/memory", namespace: "alice", export: ".headroom-memory" },
    compression: {
      mode: "lossless_then_lossy",
      targetRatio: 0.75,
      compressUserMessages: false,
      protectRecent: 8,
      protectAnalysisContext: true,
      frozenMessageCount: 2,
    },
  }), {
    schemaVersion: 1,
    port: 9000,
    memory: { root: "/data/memory", namespace: "alice", export: ".headroom-memory" },
    compression: {
      mode: "lossless_then_lossy",
      targetRatio: 0.75,
      compressUserMessages: false,
      protectRecent: 8,
      protectAnalysisContext: true,
      frozenMessageCount: 2,
    },
  });
  assert.throws(() => config.parseHeadroomConfig({ schemaVersion: 1, url: "http://127.0.0.1:9000/" }), /url is unsupported/);
  assert.throws(() => config.parseHeadroomConfig({ port: 8787 }), /fresh schemaVersion/);
  for (const mode of ["ccr", "lossy_inline", "lossless_then_lossy"]) {
    assert.deepEqual(config.parseHeadroomConfig({ schemaVersion: 1, compression: { mode } }), { schemaVersion: 1, port: 8787, compression: { mode } });
  }
  for (const value of [
    { url: "http://127.0.0.1:9000", port: 8787 },
    { port: 0 },
    { port: "8787" },
    { url: "ftp://example.com" },
    { url: "http://user@example.com" },
    { memory: { namespace: "" } },
    { memory: { namespace: "line\nbreak" } },
    { memory: null },
    { memory: { export: "" } },
    { memory: { export: "/outside-project" } },
    { memory: { unknown: true } },
    { compression: null },
    { compression: { mode: "token" } },
    { compression: { targetRatio: 1.1 } },
    { compression: { targetRatio: Number.NaN } },
    { compression: { compressUserMessages: "false" } },
    { compression: { protectRecent: -1 } },
    { compression: { frozenMessageCount: 1.5 } },
    { compression: { sessionId: "must-not-be-configurable" } },
  ]) {
    assert.throws(() => config.parseHeadroomConfig({ schemaVersion: 1, ...value }), /headroom\.json/);
  }
});

test("Headroom config: nested namespace preserves export and defaults to project when omitted", () => {
  for (const memory of [undefined, {}, { export: ".headroom-memory" }]) {
    const parsed = config.parseHeadroomConfig({ schemaVersion: 1, memory });
    assert.equal(parseMemoryNamespace(parsed.memory?.namespace), "project");
    if (memory !== undefined) assert.deepEqual(parsed.memory, memory);
  }
  for (const memory of [{ namespace: "alice" }, { namespace: "alice", export: ".headroom-memory" }]) {
    const parsed = config.parseHeadroomConfig({ schemaVersion: 1, memory });
    assert.deepEqual(parsed.memory, memory);
    assert.equal(parseMemoryNamespace(parsed.memory.namespace), "alice");
    assert.equal(Object.hasOwn(parsed, "memoryNamespace"), false);
  }
});

test("Headroom config: namespace rejects invalid types and empty or multiline values", () => {
  for (const namespace of ["", null, false, 1, [], {}, "line\nbreak", "line\rbreak", "null\0byte"]) {
    assert.throws(() => config.parseHeadroomConfig({ schemaVersion: 1, memory: { namespace } }),
      /headroom\.json memory\.namespace must be a non-empty single-line string/);
  }
});

test("Headroom config: old top-level namespace is unsupported and configuration is never rewritten", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-headroom-namespace-"));
  const configPath = join(directory, "headroom.json");
  try {
    for (const memory of [undefined, { namespace: "new-value" }]) {
      const raw = JSON.stringify({ schemaVersion: 1, memoryNamespace: "old-value", memory }, null, 2) + "\n";
      await writeFile(configPath, raw);
      assert.throws(() => config.loadHeadroomConfigSync(configPath), /headroom\.json memoryNamespace is not supported\./);
      await assert.rejects(config.loadHeadroomConfig(configPath), /headroom\.json memoryNamespace is not supported\./);
      assert.equal(await config.ensureHeadroomConfigFile(configPath), false);
      assert.equal(await readFile(configPath, "utf8"), raw, "unsupported old key must not be migrated or rewritten");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Headroom config: nested root is optional and coexists with namespace and export", () => {
  for (const memory of [undefined, {}, { namespace: "alice", export: ".headroom-memory" }]) {
    const parsed = config.parseHeadroomConfig({ schemaVersion: 1, memory });
    assert.equal(parsed.memory?.root, undefined);
    assert.equal(resolveMemoryRoot(parsed.memory?.root), DEFAULT_MEMORY_ROOT);
  }
  for (const root of ["/data/memory", "~/memory"]) {
    for (const memory of [{ root }, { root, namespace: "alice", export: ".headroom-memory" }]) {
      const parsed = config.parseHeadroomConfig({ schemaVersion: 1, memory });
      assert.deepEqual(parsed.memory, memory);
      assert.equal(Object.hasOwn(parsed, "memoryRoot"), false);
    }
  }
});

test("Headroom config: nested root requires a non-empty string", () => {
  for (const root of ["", null, false, 1, [], {}]) {
    assert.throws(() => config.parseHeadroomConfig({ schemaVersion: 1, memory: { root } }),
      /headroom\.json memory\.root must be a non-empty string/);
  }
});

test("Headroom config: top-level memoryRoot is rejected without migration or rewriting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-headroom-root-"));
  const configPath = join(directory, "headroom.json");
  try {
    for (const memory of [undefined, { root: "/new-root", namespace: "alice", export: ".headroom-memory" }]) {
      const raw = JSON.stringify({ schemaVersion: 1, memoryRoot: "/old-root", memory }, null, 2) + "\n";
      await writeFile(configPath, raw);
      assert.throws(() => config.loadHeadroomConfigSync(configPath), /headroom\.json memoryRoot is not supported\./);
      await assert.rejects(config.loadHeadroomConfig(configPath), /headroom\.json memoryRoot is not supported\./);
      assert.equal(await config.ensureHeadroomConfigFile(configPath), false);
      assert.equal(await readFile(configPath, "utf8"), raw);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Headroom config: loads JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-headroom-config-"));
  const configPath = join(directory, "headroom.json");
  try {
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, port: 9999, memory: { namespace: "tester" } }));
    assert.deepEqual(await config.loadHeadroomConfig(configPath), { schemaVersion: 1, port: 9999, memory: { namespace: "tester" } });
    assert.deepEqual(config.loadHeadroomConfigSync(configPath), { schemaVersion: 1, port: 9999, memory: { namespace: "tester" } });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
