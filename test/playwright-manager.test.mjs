import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
import { playwrightFixture } from "./helpers/playwright-fixture.mjs";
const jiti = createJiti(import.meta.url);
const { PlaywrightManager, formatPlaywrightStatus } = await jiti.import("../src/playwright-manager.ts");
const config = await jiti.import("../src/playwright-config.ts");
const { resolveWorkbenchPaths } = await jiti.import("../src/paths.ts");
const { createConsumerLease } = await jiti.import("../src/managed-lifecycle.ts");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, overrides = {}) {
  const f = await playwrightFixture(t), paths = resolveWorkbenchPaths(f.home), id = randomUUID(), slot = join(paths.playwrightRuntimes, config.PLAYWRIGHT_VERSION, id), calls = [];
  const ready = { schemaVersion: 1, policy: 1, id, version: config.PLAYWRIGHT_VERSION, engineVersion: config.PLAYWRIGHT_ENGINE_VERSION, manifestSha256: "0".repeat(64), slot,
    node: { path: process.execPath, version: process.versions.node, sha256: "0".repeat(64) }, npm: { path: join(f.root, "npm-cli.js"), version: "10.9.7", sha256: "0".repeat(64) },
    entrypoint: join(slot, "node_modules", "@playwright", "mcp", "cli.js"), browser: join(slot, "browsers", "synthetic", "chrome"), browserVersion: "synthetic", tools: [...config.PLAYWRIGHT_REQUIRED_TOOLS], validatedAt: new Date().toISOString() };
  let registry, alive = false;
  const deps = { paths, runtime: { ensure: async () => { calls.push("ensure"); return ready; }, selected: async () => ready },
    register: (name, value) => { calls.push("register"); registry = value; alive = true; },
    unregister: () => { calls.push("unregister"); registry = undefined; }, isCurrent: value => registry === value,
    observe: async () => alive, stop: async () => { calls.push("stop"); alive = false; },
    tools: () => ["mcp__playwright__browser_snapshot", "mcp__playwright__browser_run_code_unsafe"], startupTimeoutMs: 50, ...overrides };
  const manager = new PlaywrightManager(f.workspace, deps);
  return { ...f, paths, ready, calls, deps, manager, project: manager.project, registry: () => registry, override: value => { registry = value; } };
}

test("Playwright absent restore/status/confirmed off never prepare managed roots", async t => {
  const f = await playwrightFixture(t), paths = resolveWorkbenchPaths(f.home);
  const manager = new PlaywrightManager(f.workspace, { paths, register: () => assert.fail("registered"), unregister: () => assert.fail("unregistered") });
  await manager.restore(); const status = await manager.status(); assert.equal(status.intent, "off"); assert.equal(status.selected, null);
  assert.equal(await manager.off(true), true);
  await assert.rejects(access(paths.playwrightRoot), { code: "ENOENT" });
});
test("Playwright restore obeys absent opt-in before runtime seam", async t => {
  const f = await playwrightFixture(t), paths = resolveWorkbenchPaths(f.home);
  const manager = new PlaywrightManager(f.workspace, { paths, runtime: { ensure: async () => assert.fail("off Playwright must be gated before runtime preparation"), selected: async () => null }, register: () => assert.fail("off registration"), unregister: () => {} });
  await manager.restore(); await assert.rejects(access(paths.playwrightRoot), { code: "ENOENT" });
});
test("Playwright on is idempotent and uses direct managed stdio with unsafe code hidden", async t => {
  const f = await fixture(t); await f.manager.on(); const first = f.registry(); await f.manager.on();
  assert.equal(f.registry(), first); assert.equal(f.calls.filter(call => call === "register").length, 1);
  assert.equal(first.exposure, "direct"); assert.equal(first.toolExposure.browser_run_code_unsafe, "hidden");
  assert.equal(first.command, f.ready.node.path); assert.equal(first.env.NODE_OPTIONS, "");
  const spec = JSON.parse(first.args[1]); assert.equal(spec.runtimeId, f.ready.id); assert.equal(spec.workspace, f.workspace);
  assert.equal((await readdir(join(f.project.directory, "sessions"))).length, 1);
  assert.equal(await config.playwrightOptedIn(f.project), true); await f.manager.shutdown();
});
test("Playwright registration escapes Pi's $ and ! interpolation in every env value instead of rejecting paths", async t => {
  const f = await fixture(t);
  const original = join(f.paths.playwrightRoot, "npm$cache", "${HOME}");
  f.paths.playwrightNpmCache = original;
  await f.manager.on(); const env = f.registry().env;
  const entry = Object.entries(env).find(([, value]) => value.includes("npm$$cache"));
  assert.ok(entry, "the npm cache path is registered with escaped dollar signs");
  assert.ok(entry[1].includes("$${HOME}"));
  let resolveConfigValue;
  try { ({ resolveConfigValue } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js", import.meta.url).href)); }
  catch { await f.manager.shutdown(); return t.skip("Pi's internal resolver is not importable in this install"); }
  assert.equal(resolveConfigValue(entry[1], {}), original);
  for (const value of Object.values(env)) assert.notEqual(resolveConfigValue(value, {}), undefined, "no value references a missing variable");
  await f.manager.shutdown();
});
test("Playwright activation failure retains explicit intent and later restore retries", async t => {
  const f = await fixture(t); let fail = true;
  f.deps.runtime.ensure = async () => { if (fail) throw new Error("Synthetic readiness failure"); return f.ready; };
  await assert.rejects(f.manager.on(), /Synthetic readiness failure/); assert.equal(await config.playwrightOptedIn(f.project), true);
  fail = false; await f.manager.restore(); assert.ok(f.registry()); await f.manager.shutdown();
});
test("Playwright configured-server conflict preserves intent and never provisions or overrides server", async t => {
  const f = await fixture(t, { conflict: async () => "same-name configured server" });
  await assert.rejects(f.manager.on(), /same-name configured server/);
  assert.deepEqual(f.calls, []); assert.equal(await config.playwrightOptedIn(f.project), true);
});
test("Playwright off refusal leaves live session, intent, and artifacts untouched", async t => {
  const f = await fixture(t); await f.manager.on(); const server = f.registry();
  const session = JSON.parse(server.args[1]).sessionId, path = join(f.project.directory, "sessions", session, "artifacts", "keep");
  await writeFile(path, "keep"); const before = [...f.calls];
  assert.equal(await f.manager.off(false), false); assert.deepEqual(f.calls, before); assert.equal(f.registry(), server);
  assert.equal(await readFile(path, "utf8"), "keep"); assert.equal(await config.playwrightOptedIn(f.project), true); await f.manager.shutdown();
});
test("Playwright on and confirmed off end with the shared enabled and deleted messages", async t => {
  const progress = [], f = await fixture(t, { progress: message => progress.push(message) });
  await f.manager.on(); assert.equal(progress.at(-1), "Playwright enabled for this project");
  await f.manager.shutdown(); assert.equal(await f.manager.off(true), true);
  assert.equal(progress.at(-1), "Playwright data deleted for this project");
});
test("Playwright shutdown retains artifacts/intent; confirmed off deletes only workspace data", async t => {
  const f = await fixture(t); await f.manager.on(); const spec = JSON.parse(f.registry().args[1]);
  const artifact = join(f.project.directory, "sessions", spec.sessionId, "artifacts", "keep"); await writeFile(artifact, "retained");
  await mkdir(f.ready.slot, { recursive: true, mode: 0o700 }); await writeFile(join(f.ready.slot, "keep"), "shared runtime");
  await f.manager.shutdown(); assert.equal(await readFile(artifact, "utf8"), "retained"); assert.equal(await config.playwrightOptedIn(f.project), true);
  f.deps.remove = async path => { assert.equal(path, f.project.directory, "Only exact managed workspace may be deleted"); await rm(path, { recursive: true }); };
  assert.equal(await f.manager.off(true), true); await assert.rejects(access(f.project.directory), { code: "ENOENT" });
  assert.equal(await readFile(join(f.ready.slot, "keep"), "utf8"), "shared runtime"); assert.equal(await f.manager.off(true), true);
});
test("Playwright peer-busy off stops only invoker and retains workspace intent/data", async t => {
  const f = await fixture(t); await f.manager.on();
  const peer = await createConsumerLease(f.paths.playwrightConsumers, `workspace:${f.project.identifier}`);
  try {
    await assert.rejects(f.manager.off(true), /same-workspace peers remain active/);
    assert.equal(f.registry(), undefined); assert.equal(await config.playwrightOptedIn(f.project), true);
    assert.equal(f.calls.filter(call => call === "stop").length, 1); process.kill(process.pid, 0);
  } finally { await peer.release(); }
  assert.equal(await f.manager.off(true), true);
});
test("Playwright unregister failure prevents deletion and reports incomplete off", async t => {
  const f = await fixture(t); await f.manager.on(); f.deps.unregister = () => { throw new Error("Synthetic unregister failure"); };
  await assert.rejects(f.manager.off(true), /Synthetic unregister failure/); await access(f.project.directory);
  assert.equal(await config.playwrightOptedIn(f.project), true);
  assert.match(formatPlaywrightStatus(await f.manager.status()), /Problem:\s+Synthetic unregister failure/);
});
test("Playwright status uses the shared layout: state, project, data, version, link and details", async t => {
  const f = await fixture(t);
  const off = formatPlaywrightStatus(await f.manager.status()).split("\n");
  assert.equal(off[0], "Playwright"); assert.match(off[1], /^ {2}State: {4}off$/);
  assert.match(off[2], new RegExp(`^ {2}Project: {2}${f.project.projectPath}  \\(${f.project.identifier}\\)$`));
  assert.ok(off.some(line => /^ {2}Link: {5}not registered$/.test(line))); assert.ok(off.includes("  Details:"));
  await f.manager.on();
  const on = formatPlaywrightStatus(await f.manager.status());
  assert.match(on, /State: {4}on\n/); assert.ok(on.includes(`Data:     ${f.project.directory}`)); assert.match(on, /Link: {5}registered/);
  assert.match(on, /Version: {2}\S+ \(expected /);
  assert.doesNotMatch(on, /Problem:/); await f.manager.shutdown();
});
test("Playwright stop failure prevents workspace deletion", async t => {
  const f = await fixture(t); await f.manager.on(); f.deps.stop = async () => { throw new Error("Synthetic owned cleanup uncertain"); };
  await assert.rejects(f.manager.off(true), /owned cleanup uncertain/); assert.equal(await config.playwrightOptedIn(f.project), true);
});
test("Playwright overwritten registration is never unregistered as managed", async t => {
  const f = await fixture(t); await f.manager.on(); const external = { command: "/external-synthetic-server" }; f.override(external);
  const status = await f.manager.status(); assert.equal(status.currentRegistration, false); assert.deepEqual(status.tools, []);
  await f.manager.shutdown(); assert.equal(f.registry(), external); assert.equal(f.calls.includes("unregister"), false);
});
test("Playwright unsafe workspace symlink refuses deletion without touching target", async t => {
  const f = await fixture(t); await f.manager.on(); const target = join(f.root, "unrelated"); await mkdir(target, { mode: 0o700 }); await writeFile(join(target, "keep"), "unrelated");
  await rename(f.project.directory, join(f.root, "saved")); await symlink(target, f.project.directory);
  await assert.rejects(f.manager.off(true), /symlink|Unsafe/i); assert.equal(await readFile(join(target, "keep"), "utf8"), "unrelated");
});
test("Playwright partial deletion failure remains explicit and does not recreate removed session data", async t => {
  const f = await fixture(t); await f.manager.on();
  f.deps.remove = async path => { await rm(join(path, "sessions"), { recursive: true }); throw new Error("Synthetic partial deletion"); };
  await assert.rejects(f.manager.off(true), /Synthetic partial deletion/); assert.equal(await config.playwrightOptedIn(f.project), true);
  await assert.rejects(access(join(f.project.directory, "sessions")), { code: "ENOENT" });
});
test("Playwright late runtime result cannot register or recreate state after confirmed off", async t => {
  const entered = deferred(), release = deferred(), f = await fixture(t);
  f.deps.runtime.ensure = async () => { entered.resolve(); await release.promise; return f.ready; };
  const activation = f.manager.on(); void activation.catch(() => {}); await entered.promise;
  const off = f.manager.off(true); release.resolve(); await assert.rejects(activation); assert.equal(await off, true);
  assert.equal(f.calls.includes("register"), false); await assert.rejects(access(f.project.directory), { code: "ENOENT" });
});
test("Playwright late provisioning progress cannot overwrite confirmed off", async t => {
  const entered = deferred(), release = deferred(), progress = [], f = await fixture(t, { progress: message => progress.push(message) });
  f.deps.runtime.ensure = async callback => { entered.resolve(); await release.promise; callback("Playwright downloading Chromium late"); return f.ready; };
  const activation = f.manager.on(); void activation.catch(() => {}); await entered.promise;
  const off = f.manager.off(true); release.resolve(); await assert.rejects(activation); await off;
  assert.equal(progress.some(message => message.includes("downloading Chromium late")), false);
});
test("Playwright off fences an in-flight idempotence observation", async t => {
  const f = await fixture(t); await f.manager.on(); const entered = deferred(), release = deferred();
  f.deps.observe = async () => { entered.resolve(); await release.promise; return true; };
  const activation = f.manager.on(); void activation.catch(() => {}); await entered.promise;
  const off = f.manager.off(true); release.resolve(); await assert.rejects(activation); await off;
  assert.equal(f.calls.filter(call => call === "register").length, 1); await assert.rejects(access(f.project.directory), { code: "ENOENT" });
});
test("Playwright queued on cannot outlive a later off during shutdown", async t => {
  const f = await fixture(t); await f.manager.on(); const entered = deferred(), release = deferred();
  f.deps.stop = async () => { entered.resolve(); await release.promise; };
  const shutdown = f.manager.shutdown(); await entered.promise;
  const queued = f.manager.on(); void queued.catch(() => {}); const off = f.manager.off(true); release.resolve();
  await shutdown; await assert.rejects(queued, /superseded/); await off;
  assert.equal(f.calls.filter(call => call === "register").length, 1);
});
test("Playwright status separates historical readiness, current registration, and missing live-child evidence", async t => {
  const f = await fixture(t); await f.manager.on(); const before = [...f.calls]; const status = await f.manager.status();
  assert.equal(status.ownedChild, false); assert.equal(status.currentRegistration, true); assert.deepEqual(status.tools, ["mcp__playwright__browser_snapshot"]);
  const formatted = formatPlaywrightStatus(status); assert.match(formatted, /Last readiness:/); assert.match(formatted, /does not launch a browser or prove one is open/);
  assert.deepEqual(f.calls, before); await f.manager.shutdown();
});
