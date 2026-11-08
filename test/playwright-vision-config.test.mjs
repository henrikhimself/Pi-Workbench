import { test } from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
import { playwrightFixture } from "./helpers/playwright-fixture.mjs";
const jiti = createJiti(import.meta.url);
const m = await jiti.import("../src/playwright-vision-config.ts");
const { PlaywrightManager, formatPlaywrightStatus } = await jiti.import("../src/playwright-manager.ts");
const config = await jiti.import("../src/playwright-config.ts");
const { resolveWorkbenchPaths } = await jiti.import("../src/paths.ts");

test("parser accepts only the strict schema and treats null as unset", () => {
  assert.deepEqual(m.parsePlaywrightVisionConfig({ schemaVersion: 1, vision: { provider: "llama.cpp", model: "Qwen3-VL-4B-q4" } }), { state: "ready", target: { provider: "llama.cpp", model: "Qwen3-VL-4B-q4" } });
  assert.deepEqual(m.parsePlaywrightVisionConfig({ schemaVersion: 1, vision: { provider: "llama.cpp", model: null } }), { state: "unset" });
  assert.deepEqual(m.parsePlaywrightVisionConfig({ schemaVersion: 1, vision: { provider: null, model: "x" } }), { state: "unset" });
  assert.deepEqual(m.parsePlaywrightVisionConfig({ schemaVersion: 1 }), { state: "unset" });
  assert.deepEqual(m.parsePlaywrightVisionConfig({ schemaVersion: 1, vision: {} }), { state: "unset" });
  for (const bad of [null, [], "x", { schemaVersion: 2 }, { vision: {} }, { schemaVersion: 1, extra: 1 }, { schemaVersion: 1, vision: [] }, { schemaVersion: 1, vision: null },
    { schemaVersion: 1, vision: { provider: "a", model: "b", endpoint: "http://x" } }, { schemaVersion: 1, vision: { provider: "", model: "b" } },
    { schemaVersion: 1, vision: { provider: "a", model: "  " } }, { schemaVersion: 1, vision: { provider: 1, model: "b" } }, { schemaVersion: 1, vision: { provider: "a", model: "b\nc" } },
    { schemaVersion: 1, vision: { provider: "a", model: "x".repeat(201) } }]) assert.equal(m.parsePlaywrightVisionConfig(bad).state, "invalid", JSON.stringify(bad));
  const text = JSON.stringify(m.parsePlaywrightVisionConfig({ schemaVersion: 1, vision: { provider: "a", model: 5 } }));
  assert.doesNotMatch(text, /5/);
});

test("reader is passive and never creates the file; edits apply via mtime cache", async t => {
  const f = await playwrightFixture(t), path = join(f.root, "playwright.json"), read = m.createPlaywrightVisionConfigReader(path);
  assert.deepEqual(await read(), { state: "absent" });
  await assert.rejects(access(path), { code: "ENOENT" });
  await writeFile(path, JSON.stringify({ schemaVersion: 1, vision: { provider: "llama.cpp", model: null } }));
  assert.deepEqual(await read(), { state: "unset" });
  await writeFile(path, JSON.stringify({ schemaVersion: 1, vision: { provider: "llama.cpp", model: "Qwen3-VL-4B-q4" } }));
  assert.deepEqual(await read(), { state: "ready", target: { provider: "llama.cpp", model: "Qwen3-VL-4B-q4" } });
  await writeFile(path, "{not json");
  const broken = await read(); assert.equal(broken.state, "invalid"); assert.equal(await readFile(path, "utf8"), "{not json", "reader never repairs");
  await writeFile(path, JSON.stringify({ schemaVersion: 1, vision: { provider: "p", model: "m" } }));
  assert.equal((await read()).state, "ready");
});

test("reader refuses symlinks, directories and oversize files without following them", async t => {
  const f = await playwrightFixture(t), real = join(f.root, "real.json"), link = join(f.root, "link.json");
  await writeFile(real, JSON.stringify({ schemaVersion: 1, vision: { provider: "p", model: "m" } }));
  await symlink(real, link);
  assert.equal((await m.createPlaywrightVisionConfigReader(link)()).state, "invalid");
  const dir = join(f.root, "dir.json"); await mkdir(dir);
  assert.equal((await m.createPlaywrightVisionConfigReader(dir)()).state, "invalid");
  const big = join(f.root, "big.json"); await writeFile(big, " ".repeat(70 * 1024) + "{}");
  assert.equal((await m.createPlaywrightVisionConfigReader(big)()).state, "invalid");
});

test("template creation writes null model once and never overwrites any existing file", async t => {
  const f = await playwrightFixture(t), path = join(f.root, "playwright.json");
  assert.equal(await m.ensurePlaywrightUserConfig(path), true);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { schemaVersion: 1, vision: { provider: "llama.cpp", model: null } });
  assert.equal((await m.createPlaywrightVisionConfigReader(path)()).state, "unset");
  for (const content of [JSON.stringify({ schemaVersion: 1, vision: { provider: "llama.cpp", model: "Edited" } }, null, 4), "{corrupt", JSON.stringify({ schemaVersion: 9, nope: true })]) {
    await writeFile(path, content);
    assert.equal(await m.ensurePlaywrightUserConfig(path), false);
    assert.equal(await readFile(path, "utf8"), content, "existing bytes untouched");
  }
  const link = join(f.root, "linked.json"); await symlink(join(f.root, "missing-target.json"), link);
  await assert.rejects(m.ensurePlaywrightUserConfig(link), /Symlink/);
  await assert.rejects(access(join(f.root, "missing-target.json")), { code: "ENOENT" });
});

async function managerFixture(t) {
  const f = await playwrightFixture(t), paths = resolveWorkbenchPaths(f.home), id = randomUUID(), slot = join(paths.playwrightRuntimes, config.PLAYWRIGHT_VERSION, id);
  const ready = { schemaVersion: 1, policy: 1, id, version: config.PLAYWRIGHT_VERSION, engineVersion: config.PLAYWRIGHT_ENGINE_VERSION, manifestSha256: "0".repeat(64), slot,
    node: { path: process.execPath, version: process.versions.node, sha256: "0".repeat(64) }, npm: { path: join(f.root, "npm-cli.js"), version: "10.9.7", sha256: "0".repeat(64) },
    entrypoint: join(slot, "node_modules", "@playwright", "mcp", "cli.js"), browser: join(slot, "browsers", "synthetic", "chrome"), browserVersion: "synthetic", tools: [...config.PLAYWRIGHT_REQUIRED_TOOLS], validatedAt: new Date().toISOString() };
  let registry, alive = false;
  const deps = { paths, runtime: { ensure: async () => ready, selected: async () => ready }, register: (_name, value) => { registry = value; alive = true; }, unregister: () => { registry = undefined; },
    isCurrent: value => registry === value, observe: async () => alive, stop: async () => { alive = false; }, tools: () => [], startupTimeoutMs: 50 };
  return { ...f, paths, manager: new PlaywrightManager(f.workspace, deps) };
}

test("opt-in creates the template; restore, status and off never write it", async t => {
  const f = await managerFixture(t);
  await f.manager.restore(); assert.equal((await f.manager.status()).vision.state, "absent");
  await assert.rejects(access(f.paths.playwrightConfig), { code: "ENOENT" });
  assert.equal(await f.manager.off(true), true);
  await assert.rejects(access(f.paths.playwrightConfig), { code: "ENOENT" });
  await f.manager.on();
  assert.deepEqual(JSON.parse(await readFile(f.paths.playwrightConfig, "utf8")), { schemaVersion: 1, vision: { provider: "llama.cpp", model: null } });
  assert.match(formatPlaywrightStatus(await f.manager.status()), /Vision bridge: off \(set vision\.provider and vision\.model/);
  const owner = JSON.stringify({ schemaVersion: 1, vision: { provider: "llama.cpp", model: "Qwen3-VL-4B-q4" } }, null, 4);
  await writeFile(f.paths.playwrightConfig, owner);
  await f.manager.on(); await f.manager.restore();
  assert.equal(await readFile(f.paths.playwrightConfig, "utf8"), owner, "owner edit untouched by on/restore");
  assert.match(formatPlaywrightStatus(await f.manager.status()), /Vision bridge: configured llama\.cpp\/Qwen3-VL-4B-q4/);
  assert.equal(await f.manager.off(true), true);
  assert.equal(await readFile(f.paths.playwrightConfig, "utf8"), owner, "off never deletes the user-wide file");
});

test("corrupt or unsafe config disables only the bridge; Playwright opt-in still succeeds and file is untouched", async t => {
  const f = await managerFixture(t);
  await mkdir(f.paths.root, { recursive: true, mode: 0o700 });
  await writeFile(f.paths.playwrightConfig, "{corrupt");
  await f.manager.on();
  assert.equal(await readFile(f.paths.playwrightConfig, "utf8"), "{corrupt");
  const status = await f.manager.status(); assert.equal(status.intent, "on"); assert.equal(status.vision.state, "invalid");
  assert.match(formatPlaywrightStatus(status), /Vision bridge: off \(playwright\.json is not valid JSON\.\)/);
  await chmod(f.paths.playwrightConfig, 0o644);
});
