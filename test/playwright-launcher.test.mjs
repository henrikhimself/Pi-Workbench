import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, rm, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
import { managedPlaywrightFixture as fixture, nodePath } from "./helpers/playwright-managed-fixture.mjs";
const jiti = createJiti(import.meta.url);
const config = await jiti.import("../src/playwright-config.ts");
const runtimeModule = await jiti.import("../src/playwright-runtime.ts");
const processes = await jiti.import("../src/playwright-process.ts");
const { readPlaywrightOwnership } = await jiti.import("../src/playwright-ownership.ts");
const { PlaywrightOwnedTree } = await jiti.import("../src/playwright-tree.ts");
const { resolveWorkbenchPaths } = await jiti.import("../src/paths.ts");
const { publishJson, processBirth } = await jiti.import("../src/managed-lifecycle.ts");
const dead = async pid => { const birth = await processBirth(pid); return !birth || birth.startsWith("linux-dead:"); };
const { parsePlaywrightLauncherSpec } = await jiti.import("../src/playwright-launcher.ts");
const launcher = fileURLToPath(new URL("../src/playwright-launcher.mjs", import.meta.url));

async function waitFor(fn, timeout = 10000) {
  const deadline = Date.now() + timeout;
  do { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); } while (Date.now() < deadline);
  throw new Error("Synthetic launcher state timed out");
}
async function connect(f, selected) {
  return processes.PlaywrightStdioClient.connect({ command: nodePath, args: [launcher, JSON.stringify(selected.spec)], cwd: f.workspace, env: selected.env, timeoutMs: 15000 });
}

test("Playwright launcher rejects malformed and arbitrary-script specifications", () => {
  assert.throws(() => parsePlaywrightLauncherSpec(null));
  assert.throws(() => parsePlaywrightLauncherSpec({ schemaVersion: 1, command: nodePath, args: ["/arbitrary.js"] }));
});
test("Playwright Pi environment blanks inherited loaders, backend overrides and credentials before Node startup", () => {
  const env = config.playwrightPiEnvironment({ HOME: "/private", PATH: "/private/bin" }, { NODE_OPTIONS: "--require=/unowned.js", LD_PRELOAD: "/unowned.so", PLAYWRIGHT_MCP_WEBMCP: "true", API_KEY: "synthetic-not-a-secret" });
  assert.equal(env.NODE_OPTIONS, ""); assert.equal(env.NODE_PATH, ""); assert.equal(env.LD_PRELOAD, ""); assert.equal(env.PLAYWRIGHT_MCP_WEBMCP, ""); assert.equal(env.API_KEY, ""); assert.equal(env.HOME, "/private");
});
test("Playwright owned launcher forwards MCP/images, records real child leases and cleans detached Node descendants", { timeout: 20000 }, async t => {
  const f = await fixture(t), selected = await f.session(); let client;
  try {
    client = await connect(f, selected);
    const response = await client.call("browser_take_screenshot"), info = JSON.parse(response.content[0].text);
    assert.equal(response.content[1].type, "image"); assert.equal(typeof info.descendant, "number");
    const ownership = await waitFor(async () => { const evidence = await readPlaywrightOwnership(selected.session); return evidence?.record.processes?.some(owner => owner.pid === info.descendant) ? evidence : null; });
    assert.equal(ownership.record.child.pid, info.pid); assert.equal(ownership.record.runtimeId, f.record.id);
    const leases = await runtimeModule.playwrightConsumers(f.paths, `workspace:${f.project.identifier}`); assert.equal(leases.length, 1); assert.equal(leases[0].active, true);
    await client.close(); client = null;
    assert.equal(await dead(info.descendant), true);
    assert.equal((await runtimeModule.playwrightConsumers(f.paths)).length, 0);
    assert.equal(JSON.parse(await readFile(join(selected.session.directory, "stopped.json"), "utf8")).clean, true);
    await assert.rejects(access(selected.session.home), { code: "ENOENT" });
    await access(selected.session.artifacts); assert.equal(await config.playwrightOptedIn(f.project), true);
  } finally { await client?.close(); }
});
test("Playwright MCP crash cleanup reaches detached synthetic browser after its parent exits", { timeout: 20000 }, async t => {
  const f = await fixture(t), selected = await f.session(); let client;
  try {
    client = await connect(f, selected);
    const info = JSON.parse((await client.call("browser_snapshot")).content[0].text);
    await waitFor(async () => (await readPlaywrightOwnership(selected.session))?.record.processes?.some(owner => owner.pid === info.descendant));
    process.kill(info.pid, "SIGKILL");
    await waitFor(() => dead(info.descendant));
    await client.close(); client = null;
    assert.equal((await runtimeModule.playwrightConsumers(f.paths)).length, 0);
  } finally { await client?.close(); }
});
test("Playwright separate owned sessions never stop peer or unrelated Node process", { timeout: 30000 }, async t => {
  const f = await fixture(t), a = await f.session(), b = await f.session(); let first, second;
  try {
    first = await connect(f, a); second = await connect(f, b);
    const one = JSON.parse((await first.call("browser_snapshot")).content[0].text), two = JSON.parse((await second.call("browser_snapshot")).content[0].text);
    assert.notEqual(one.descendant, two.descendant);
    await first.close(); first = null;
    process.kill(two.pid, 0); process.kill(two.descendant, 0); process.kill(process.pid, 0);
    assert.equal((await runtimeModule.playwrightConsumers(f.paths, `workspace:${f.project.identifier}`)).filter(lease => lease.active).length, 1);
    await second.close(); second = null;
  } finally { await first?.close(); await second?.close(); }
});
test("Playwright reconnect starts fresh transient state while retaining artifacts", { timeout: 25000 }, async t => {
  const f = await fixture(t), selected = await f.session(); let client;
  try {
    client = await connect(f, selected);
    await writeFile(join(selected.session.artifacts, "keep.txt"), "retained artifact");
    await writeFile(join(selected.session.home, "old-cookie"), "synthetic private state");
    await client.close(); client = null;
    await assert.rejects(access(selected.session.home), { code: "ENOENT" });
    client = await connect(f, selected);
    await access(selected.session.home);
    await assert.rejects(access(join(selected.session.home, "old-cookie")), { code: "ENOENT" });
    assert.equal(await readFile(join(selected.session.artifacts, "keep.txt"), "utf8"), "retained artifact");
  } finally { await client?.close(); }
});
test("Playwright duplicate launcher refuses an already active session without resetting it", { timeout: 25000 }, async t => {
  const f = await fixture(t), selected = await f.session(); let first, duplicate;
  try {
    first = await connect(f, selected);
    await first.call("browser_evaluate", { fixtureSet: { key: "live", value: "preserved" } });
    await assert.rejects(async () => { duplicate = await connect(f, selected); }, /closed|closing/);
    const after = JSON.parse((await first.call("browser_evaluate", { fixtureGet: "live" })).content[0].text);
    assert.equal(after.value, "preserved");
  } finally { await first?.close(); await duplicate?.close(); }
});
test("Playwright startup EOF fences late child creation without resurrecting state", { timeout: 15000 }, async t => {
  const f = await fixture(t), selected = await f.session();
  const result = await processes.runPlaywrightCommand({ command: nodePath, args: [launcher, JSON.stringify(selected.spec)], cwd: f.workspace, env: selected.env, timeoutMs: 10000 });
  assert.equal(result.exitCode, 0); assert.equal((await runtimeModule.playwrightConsumers(f.paths)).length, 0);
  await assert.rejects(access(join(selected.session.directory, "ownership.json")), { code: "ENOENT" });
});
test("Playwright recovery detects orphaned detached descendants without adopting another session", { timeout: 20000 }, async t => {
  const f = await fixture(t), selected = await f.session(); let client, recovery;
  try {
    client = await connect(f, selected);
    const info = JSON.parse((await client.call("browser_snapshot")).content[0].text);
    const evidence = await waitFor(async () => { const value = await readPlaywrightOwnership(selected.session); return value?.record.processes?.some(owner => owner.pid === info.descendant) ? value : null; });
    process.kill(evidence.record.child.pid, "SIGKILL"); process.kill(evidence.record.supervisor.pid, "SIGKILL");
    await client.close(); client = null;
    await waitFor(async () => (await dead(evidence.record.child.pid)) && (await dead(evidence.record.supervisor.pid)));
    assert.equal(await dead(info.descendant), false);
    assert.equal((await runtimeModule.playwrightConsumers(f.paths)).filter(consumer => consumer.active).length, 2);
    const orphan = await readPlaywrightOwnership(selected.session);
    recovery = new PlaywrightOwnedTree(orphan.scope, orphan.roots);
    await recovery.stop(); recovery = null;
    assert.equal(await dead(info.descendant), true);
    assert.equal((await runtimeModule.playwrightConsumers(f.paths)).filter(consumer => consumer.active).length, 0);
  } finally {
    await client?.close();
    if (!recovery) { const owned = await readPlaywrightOwnership(selected.session); if (owned) recovery = new PlaywrightOwnedTree(owned.scope, owned.roots); }
    await recovery?.stop();
  }
});
for (const mutation of ["entrypoint", "selection", "opt-in", "configuration"]) test(`Playwright launcher refuses changed ${mutation} without starting MCP/browser`, { timeout: 15000 }, async t => {
  const f = await fixture(t), selected = await f.session();
  if (mutation === "entrypoint") {
    const unowned = join(f.root, "unowned.mjs");
    await writeFile(unowned, await readFile(new URL("./helpers/fake-playwright-mcp.mjs", import.meta.url)));
    await writeFile(join(f.root, "fake-playwright-browser.mjs"), await readFile(new URL("./helpers/fake-playwright-browser.mjs", import.meta.url)));
    selected.spec.args = [unowned, "--config", selected.session.configPath];
  }
  if (mutation === "selection") selected.spec.runtimeId = randomUUID();
  if (mutation === "opt-in") await rm(f.project.optInPath);
  if (mutation === "configuration") { const cfg = JSON.parse(await readFile(selected.session.configPath, "utf8")); cfg.webmcp = true; await writeFile(selected.session.configPath, JSON.stringify(cfg)); }
  let connected;
  try { await assert.rejects(async () => { connected = await connect(f, selected); }, /closed|closing/); }
  finally { await connected?.close(); }
  assert.equal((await runtimeModule.playwrightConsumers(f.paths)).length, 0);
  await assert.rejects(access(join(selected.session.directory, "ownership.json")), { code: "ENOENT" });
});
test("M11: a new launcher stops the attested orphans of the previous launcher instead of refusing to start", { timeout: 30000 }, async t => {
  const f = await fixture(t), selected = await f.session(); let client, next;
  try {
    client = await connect(f, selected);
    const info = JSON.parse((await client.call("browser_snapshot")).content[0].text);
    const evidence = await waitFor(async () => { const value = await readPlaywrightOwnership(selected.session); return value?.record.processes?.some(owner => owner.pid === info.descendant) ? value : null; });
    process.kill(evidence.record.child.pid, "SIGKILL"); process.kill(evidence.record.supervisor.pid, "SIGKILL");
    await client.close(); client = null;
    await waitFor(async () => (await dead(evidence.record.child.pid)) && (await dead(evidence.record.supervisor.pid)));
    assert.equal(await dead(info.descendant), false, "the detached browser outlived the old launcher");
    next = await connect(f, selected);
    assert.equal(await dead(info.descendant), true, "the previous runtime's detached browser was stopped");
    const again = JSON.parse((await next.call("browser_snapshot")).content[0].text);
    assert.notEqual(again.descendant, info.descendant);
  } finally {
    await client?.close(); await next?.close();
    const owned = await readPlaywrightOwnership(selected.session);
    if (owned) await new PlaywrightOwnedTree(owned.scope, owned.roots).stop();
  }
});
test("M11: after the MCP server dies, a detached browser that ignores SIGTERM is gone well inside Pi's 2.5 s window", { timeout: 30000 }, async t => {
  const f = await fixture(t), selected = await f.session(); let client;
  try {
    client = await connect(f, selected);
    const info = JSON.parse((await client.call("browser_snapshot")).content[0].text);
    await waitFor(async () => (await readPlaywrightOwnership(selected.session))?.record.processes?.some(owner => owner.pid === info.descendant));
    const started = Date.now();
    process.kill(info.pid, "SIGKILL");
    await waitFor(() => dead(info.descendant), 5000);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1500, `browser stopped after ${elapsed} ms; the old 1.5 s SIGTERM wait alone exceeded this`);
    await client.close(); client = null;
    assert.equal((await runtimeModule.playwrightConsumers(f.paths)).length, 0);
  } finally { await client?.close(); }
});
