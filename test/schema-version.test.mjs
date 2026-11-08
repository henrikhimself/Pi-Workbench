import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { requireSchemaVersion, SCHEMA_VERSION } = await jiti.import("../src/schema-version.ts");

test("requireSchemaVersion accepts only schemaVersion 1", () => {
  assert.equal(SCHEMA_VERSION, 1);
  requireSchemaVersion({ schemaVersion: 1 }, "x");
  for (const record of [{}, { schemaVersion: 0 }, { schemaVersion: 2 }, { schemaVersion: "1" }, { schemaVersion: null }, { schema: 1 }, null, undefined, 1, "a", []]) {
    assert.throws(() => requireSchemaVersion(record, "the thing"), /^Error: the thing schemaVersion must be 1$/, JSON.stringify(record));
  }
});

// ─── Every parsed file kind refuses a record without schemaVersion 1 at parse time ───
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const VERSION_MESSAGE = /schemaVersion must be 1/;
const oldKey = ({ schemaVersion, ...rest }) => ({ schema: schemaVersion ?? 1, ...rest });
async function scratch(fn) {
  const dir = await mkdtemp(join(tmpdir(), "wb-schema-")); try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("Playwright record and spec parsers refuse a missing, wrong or old-key version before anything else", async () => {
  const config = await jiti.import("../src/playwright-config.ts");
  const { parsePlaywrightLauncherSpec } = await jiti.import("../src/playwright-launcher.ts");
  const { bootstrapPlaywrightMcp } = await jiti.import("../src/playwright-mcp-bootstrap.ts");
  const { resolveWorkbenchPaths } = await jiti.import("../src/paths.ts");
  const paths = resolveWorkbenchPaths("/nonexistent-home");
  const parsers = {
    runtime: raw => config.parsePlaywrightRuntime(raw, paths), selection: raw => config.parsePlaywrightSelection(raw, paths),
    session: config.parsePlaywrightSession, recovery: config.parsePlaywrightRecovery, launcher: parsePlaywrightLauncherSpec, bootstrap: bootstrapPlaywrightMcp,
  };
  for (const [name, parse] of Object.entries(parsers)) {
    for (const raw of [{}, { schema: 1 }, { schemaVersion: 0 }, { schemaVersion: 2 }, { schemaVersion: "1" }]) {
      await assert.rejects(async () => parse(raw), VERSION_MESSAGE, `${name} ${JSON.stringify(raw)}`);
    }
  }
});

test("Playwright opt-in with the old schema key is refused and left unchanged", async () => {
  const config = await jiti.import("../src/playwright-config.ts");
  const { resolveWorkbenchPaths } = await jiti.import("../src/paths.ts");
  await scratch(async dir => {
    const paths = resolveWorkbenchPaths(dir), workspace = join(dir, "ws"); await mkdir(workspace);
    const project = config.resolvePlaywrightProject(workspace, paths);
    await config.enablePlaywrightOptIn(project);
    const written = JSON.parse(await readFile(project.optInPath, "utf8"));
    assert.equal(written.schemaVersion, 1);
    const legacy = JSON.stringify(oldKey(written)); await writeFile(project.optInPath, legacy);
    await assert.rejects(config.playwrightOptedIn(project), VERSION_MESSAGE);
    assert.equal(await readFile(project.optInPath, "utf8"), legacy);
  });
});

test("lock owner records and consumer leases with the old schema key are refused", async () => {
  const lifecycle = await jiti.import("../src/managed-lifecycle.ts");
  await scratch(async dir => {
    const release = await lifecycle.acquireManagedLock(dir, "thing");
    const owner = join(dir, "thing.lock", "owner.json");
    const written = JSON.parse(await readFile(owner, "utf8")); assert.equal(written.schemaVersion, 1);
    await writeFile(owner, JSON.stringify(oldKey(written)));
    await assert.rejects(lifecycle.acquireManagedLock(dir, "thing", { timeoutMs: 100 }), VERSION_MESSAGE);
    await writeFile(owner, JSON.stringify(written)); await release();
    const leases = join(dir, "leases"); await mkdir(leases, { mode: 0o700 });
    const lease = await lifecycle.createConsumerLease(leases, "resource");
    const file = join(leases, `${lease.token}.json`), record = JSON.parse(await readFile(file, "utf8")); assert.equal(record.schemaVersion, 1);
    await writeFile(file, JSON.stringify(oldKey(record)), { mode: 0o600 });
    await assert.rejects(lifecycle.activeConsumers(leases), VERSION_MESSAGE);
  });
});

test("a Headroom store marker with the old schema key is refused at parse time and left unchanged", async () => {
  const { prepareDataStore, STORE_MARKER } = await jiti.import("../src/store-identity.ts");
  await scratch(async dir => {
    const identity = { schemaVersion: 1, layout: 1, headroomVersion: "0.41.0", kind: "memory" };
    await prepareDataStore(dir, identity);
    const marker = join(dir, STORE_MARKER), legacy = JSON.stringify(oldKey(JSON.parse(await readFile(marker, "utf8"))));
    await writeFile(marker, legacy);
    await assert.rejects(prepareDataStore(dir, identity), VERSION_MESSAGE);
    assert.equal(await readFile(marker, "utf8"), legacy);
  });
});

// ─── No file kind may be added or left behind with the old key, and removed evidence stays removed ───
function sourceFiles(dir, found = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name); const info = statSync(path);
    if (info.isDirectory()) { if (name !== "node_modules") sourceFiles(path, found); }
    else if (/\.(ts|mjs|py)$/.test(name)) found.push(path);
  }
  return found;
}
test("no source file writes or checks the old `schema` key", () => {
  const offenders = [];
  for (const file of sourceFiles(join(import.meta.dirname, "..", "src"))) {
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      if (/(^|[^A-Za-z_])schema\s*:\s*1\b|\.schema\s*[!=]==?|\.get\("schema"\)|\["schema"|"schema",/.test(line)) offenders.push(`${file}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test("the unused cleanup-pending.json evidence file is no longer written", () => {
  for (const file of sourceFiles(join(import.meta.dirname, "..", "src"))) assert.doesNotMatch(readFileSync(file, "utf8"), /cleanup-pending/, file);
});
