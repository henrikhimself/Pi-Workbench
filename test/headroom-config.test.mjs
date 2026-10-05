import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
const config = await jiti.import("../src/headroom-config.ts");

test("Headroom config: bootstraps documented default once without overwriting user content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-headroom-config-"));
  const configPath = join(directory, "nested", "headroom.json");
  try {
    assert.equal(await config.ensureHeadroomConfigFile(configPath), true);
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { port: 8787 });
    await writeFile(configPath, '{"url":"http://127.0.0.1:9000"}\n');
    assert.equal(await config.ensureHeadroomConfigFile(configPath), false);
    assert.equal(await readFile(configPath, "utf8"), '{"url":"http://127.0.0.1:9000"}\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Headroom config: validates proxy, Memory, and compression values", () => {
  assert.deepEqual(config.parseHeadroomConfig({
    port: 9000,
    memoryRoot: "/data/memory",
    memoryNamespace: "alice",
    memory: { export: ".headroom-memory" },
    compression: {
      mode: "lossless_then_lossy",
      targetRatio: 0.75,
      compressUserMessages: false,
      protectRecent: 8,
      protectAnalysisContext: true,
      frozenMessageCount: 2,
    },
  }), {
    port: 9000,
    memoryRoot: "/data/memory",
    memoryNamespace: "alice",
    memory: { export: ".headroom-memory" },
    compression: {
      mode: "lossless_then_lossy",
      targetRatio: 0.75,
      compressUserMessages: false,
      protectRecent: 8,
      protectAnalysisContext: true,
      frozenMessageCount: 2,
    },
  });
  assert.deepEqual(config.parseHeadroomConfig({ url: "http://127.0.0.1:9000/" }), { url: "http://127.0.0.1:9000" });
  for (const mode of ["ccr", "lossy_inline", "lossless_then_lossy"]) {
    assert.deepEqual(config.parseHeadroomConfig({ compression: { mode } }), { port: 8787, compression: { mode } });
  }
  for (const value of [
    { url: "http://127.0.0.1:9000", port: 8787 },
    { port: 0 },
    { port: "8787" },
    { url: "ftp://example.com" },
    { url: "http://user@example.com" },
    { memoryNamespace: "" },
    { memoryNamespace: "line\nbreak" },
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
    assert.throws(() => config.parseHeadroomConfig(value), /headroom\.json/);
  }
});

test("Headroom config: loads JSON and detects ignored legacy environment variables", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-headroom-config-"));
  const configPath = join(directory, "headroom.json");
  try {
    await writeFile(configPath, JSON.stringify({ port: 9999, memoryNamespace: "tester" }));
    assert.deepEqual(await config.loadHeadroomConfig(configPath), { port: 9999, memoryNamespace: "tester" });
    assert.equal(config.hasLegacyHeadroomEnvironment({ HEADROOM_URL: "http://ignored" }), true);
    assert.equal(config.hasLegacyHeadroomEnvironment({ PI_MODEL: "test-only" }), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
