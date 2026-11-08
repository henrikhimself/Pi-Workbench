import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { prepareDataStore, STORE_MARKER } = await jiti.import("../src/store-identity.ts");
const { TOOL_NAMES } = await jiti.import("../src/tool-names.ts");

const codeGraph = { schemaVersion: 1, layout: 1, kind: "code-graph", codeGraphVersion: "v0.12.1", resolvedUrl: "https://example.invalid/cbm.tar.gz", sha256: "a".repeat(64) };
const memory = { schemaVersion: 1, layout: 1, kind: "memory", headroomVersion: "0.41.0" };
const proxy = { schemaVersion: 1, layout: 1, kind: "proxy", headroomVersion: "0.41.0" };
const refusal = name => new RegExp(`^Error: ${name} data was written by another version, which this release does not read\\. It was left unchanged\\.$`);
async function scratch(fn) { const dir = await mkdtemp(join(tmpdir(), "wb-identity-")); try { await fn(join(dir, "store")); } finally { await rm(dir, { recursive: true, force: true }); } }

test("the tool names are the four display names", () => {
  assert.deepEqual(TOOL_NAMES, { compression: "Headroom compression", memory: "Headroom Memory", codeGraph: "Code Graph", playwright: "Playwright" });
});

test("a new directory gets the identity file once, and the same identity reopens it", async () => {
  for (const identity of [codeGraph, memory, proxy]) await scratch(async dir => {
    await prepareDataStore(dir, identity);
    const written = await readFile(join(dir, STORE_MARKER), "utf8");
    assert.deepEqual(JSON.parse(written), identity);
    await prepareDataStore(dir, identity);
    assert.equal(await readFile(join(dir, STORE_MARKER), "utf8"), written);
  });
});

test("every field of a Code Graph identity is compared exactly, and a mismatch changes nothing", async () => {
  for (const change of [{ codeGraphVersion: "v0.13.0" }, { resolvedUrl: "https://example.invalid/other.tar.gz" }, { sha256: "b".repeat(64) }, { layout: 2 }]) await scratch(async dir => {
    await prepareDataStore(dir, codeGraph);
    const before = await readFile(join(dir, STORE_MARKER), "utf8");
    await writeFile(join(dir, "_config.db"), "data");
    await assert.rejects(prepareDataStore(dir, { ...codeGraph, ...change }), refusal("Code Graph"));
    assert.equal(await readFile(join(dir, STORE_MARKER), "utf8"), before);
    assert.deepEqual((await readdir(dir)).sort(), ["_config.db", STORE_MARKER]);
  });
});

test("the refusal names the tool and no command, and never says migration or fresh", async () => {
  for (const [identity, name] of [[codeGraph, "Code Graph"], [memory, "Headroom Memory"], [proxy, "Headroom compression"]]) await scratch(async dir => {
    await prepareDataStore(dir, identity);
    await assert.rejects(prepareDataStore(dir, { ...identity, schemaVersion: 1, ...(identity.kind === "code-graph" ? { sha256: "c".repeat(64) } : { headroomVersion: "0.1.0" }) }), error => {
      assert.match(String(error), refusal(name)); assert.doesNotMatch(error.message, /migrat|fresh|\/wb:|run /i); return true;
    });
  });
});

test("a non-empty directory without an identity file is refused and left unchanged, including a leftover state.json", async () => {
  for (const files of [["state.json"], ["_config.db", "index.db"], ["anything"]]) await scratch(async dir => {
    await mkdir(dir, { recursive: true });
    for (const name of files) await writeFile(join(dir, name), "x");
    await assert.rejects(prepareDataStore(dir, codeGraph), refusal("Code Graph"));
    assert.deepEqual((await readdir(dir)).sort(), [...files].sort());
  });
});
