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
  assert.throws(() => config.parseHeadroomConfig({ port: 8787 }), /new schemaVersion/);
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

test("Headroom config: an unknown top-level key is rejected and the file is not rewritten", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-headroom-unknown-key-"));
  const configPath = join(directory, "headroom.json");
  try {
    for (const key of ["memoryNamespace", "memoryRoot", "somethingElse"]) {
      for (const memory of [undefined, { namespace: "alice" }]) {
        const raw = JSON.stringify({ schemaVersion: 1, [key]: "value", memory }, null, 2) + "\n";
        await writeFile(configPath, raw);
        assert.throws(() => config.loadHeadroomConfigSync(configPath), new RegExp(`headroom\\.json ${key} is not supported\\.`));
        assert.equal(await config.ensureHeadroomConfigFile(configPath), false);
        assert.equal(await readFile(configPath, "utf8"), raw, "the file must not be rewritten");
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Headroom config: loads JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-headroom-config-"));
  const configPath = join(directory, "headroom.json");
  try {
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, port: 9999, memory: { namespace: "tester" } }));
    assert.deepEqual(config.loadHeadroomConfigSync(configPath), { schemaVersion: 1, port: 9999, memory: { namespace: "tester" } });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Headroom config: proxy tuning section accepts bounded values and maps to Headroom variables", () => {
  const proxy = { compressionTimeoutSeconds: 90, backgroundCompression: true, backgroundCompressionMinTokens: 20000, quarantineThreshold: 2, quarantineMaxSeconds: 120 };
  assert.deepEqual(config.parseHeadroomConfig({ schemaVersion: 1, proxy }).proxy, proxy);
  assert.deepEqual(config.parseHeadroomConfig({ schemaVersion: 1, proxy: {} }).proxy, {});
  assert.deepEqual(config.proxyTuningEnvironment(proxy), {
    HEADROOM_COMPRESSION_TIMEOUT_SECONDS: "90", HEADROOM_BACKGROUND_COMPRESSION: "1",
    HEADROOM_BACKGROUND_COMPRESSION_MIN_TOKENS: "20000", HEADROOM_COMPRESSION_QUARANTINE_THRESHOLD: "2",
    HEADROOM_COMPRESSION_QUARANTINE_MAX_SECONDS: "120",
  });
  assert.equal(config.proxyTuningEnvironment({ backgroundCompression: false }).HEADROOM_BACKGROUND_COMPRESSION, "0");
  assert.deepEqual(config.proxyTuningEnvironment({}), {});
  assert.deepEqual(config.proxyTuningEnvironment(undefined), {});
  assert.deepEqual(config.parseHeadroomConfig({ schemaVersion: 1 }).proxy, undefined);
});

test("Headroom config: proxy tuning rejects unknown keys, wrong types and out-of-range values", () => {
  const bad = (proxy, pattern) => assert.throws(() => config.parseHeadroomConfig({ schemaVersion: 1, proxy }), pattern);
  bad("fast", /proxy must be a JSON object/);
  bad([], /proxy must be a JSON object/);
  bad(null, /proxy must be a JSON object/);
  bad({ HEADROOM_COMPRESSION_TIMEOUT_SECONDS: 30 }, /proxy\.HEADROOM_COMPRESSION_TIMEOUT_SECONDS is not supported/);
  bad({ port: 1 }, /proxy\.port is not supported/);
  for (const value of [4, 601, 0, -1, 30.5, "30", null, Number.NaN, Infinity]) bad({ compressionTimeoutSeconds: value }, /proxy\.compressionTimeoutSeconds must be an integer from 5 to 600/);
  bad({ backgroundCompression: "yes" }, /proxy\.backgroundCompression must be a boolean/);
  bad({ backgroundCompression: 1 }, /proxy\.backgroundCompression must be a boolean/);
  bad({ backgroundCompressionMinTokens: 0 }, /backgroundCompressionMinTokens must be an integer from 1 to 10000000/);
  bad({ quarantineThreshold: 65 }, /quarantineThreshold must be an integer from 1 to 64/);
  bad({ quarantineMaxSeconds: 3601 }, /quarantineMaxSeconds must be an integer from 1 to 3600/);
});

test("Headroom config: client request timeout always exceeds the proxy's compression timeout", () => {
  assert.equal(config.headroomRequestTimeoutMs(), 45_000, "30 s server default plus 15 s");
  assert.equal(config.headroomRequestTimeoutMs({}), 45_000);
  assert.equal(config.headroomRequestTimeoutMs({ compressionTimeoutSeconds: 120 }), 135_000);
  assert.equal(config.headroomRequestTimeoutMs({ compressionTimeoutSeconds: 5 }), 20_000);
});
