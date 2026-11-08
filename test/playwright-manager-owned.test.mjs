import { test } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { createJiti } from "jiti";
import { managedPlaywrightFixture } from "./helpers/playwright-managed-fixture.mjs";
const jiti = createJiti(import.meta.url);
const { PlaywrightManager } = await jiti.import("../src/playwright-manager.ts");
const { PlaywrightStdioClient } = await jiti.import("../src/playwright-process.ts");
const { processBirth } = await jiti.import("../src/managed-lifecycle.ts");
function controller(f, closeTransport = true) {
  let registry, connection, tools = [], registrations = 0;
  const manager = new PlaywrightManager(f.workspace, {
    paths: f.paths, startupTimeoutMs: 15000, shutdownTimeoutMs: closeTransport ? 6000 : 50,
    register: (name, config) => {
      registry = config; registrations++;
      connection = PlaywrightStdioClient.connect({ command: config.command, args: config.args, env: config.env, cwd: config.cwd, timeoutMs: 15000 });
      void connection.then(async client => { tools = (await client.request("tools/list")).tools.map(tool => `mcp__playwright__${tool.name}`); }).catch(() => {});
    },
    unregister: () => { registry = undefined; if (closeTransport) void connection?.then(client => client.close()).catch(() => {}); },
    isCurrent: config => config === registry, tools: () => tools,
  });
  return { manager, client: () => connection, registrations: () => registrations };
}
const dead = async pid => { const birth = await processBirth(pid); return !birth || birth.startsWith("linux-dead:"); };

test("Playwright manager hands parent leases to real owned Node fixture children and preserves live session on repeated on", { timeout: 30000 }, async t => {
  const f = await managedPlaywrightFixture(t), c = controller(f);
  try {
    await c.manager.on(); const client = await c.client();
    await client.call("browser_evaluate", { fixtureSet: { key: "live", value: "preserved" } });
    await c.manager.on(); assert.equal(c.registrations(), 1);
    assert.equal(JSON.parse((await client.call("browser_evaluate", { fixtureGet: "live" })).content[0].text).value, "preserved");
    const status = await c.manager.status(); assert.equal(status.ownedChild, true); assert.equal(status.consumers, 1);
    assert.equal(status.tools.includes("mcp__playwright__browser_run_code_unsafe"), false);
    await c.manager.off(true); await assert.rejects(access(f.project.directory), { code: "ENOENT" }); await access(f.record.slot);
  } finally { await c.manager.shutdown(); await (await c.client())?.close(); }
});
test("Playwright owned route proof survives transport closure without claiming a live child", { timeout: 30000 }, async t => {
  const f = await managedPlaywrightFixture(t), c = controller(f);
  try {
    await c.manager.on(); await (await c.client()).close();
    assert.equal((await c.manager.status()).ownedChild, false);
    assert.equal(await c.manager.ownsToolRoute(), true);
  } finally { await c.manager.shutdown(); await (await c.client())?.close(); }
});
test("Playwright manager forced cleanup reaches owned detached fixture groups without terminating Pi parent", { timeout: 30000 }, async t => {
  const f = await managedPlaywrightFixture(t), c = controller(f, false);
  try {
    await c.manager.on(); const client = await c.client();
    const info = JSON.parse((await client.call("browser_snapshot")).content[0].text);
    await c.manager.shutdown(); assert.equal(await dead(info.pid), true); assert.equal(await dead(info.descendant), true); process.kill(process.pid, 0);
    await access(f.project.optInPath); await c.manager.off(true);
  } finally { await c.manager.shutdown(); await (await c.client())?.close(); }
});
test("Playwright peer-busy owned-manager off neither kills peer nor schedules deferred deletion", { timeout: 40000 }, async t => {
  const f = await managedPlaywrightFixture(t), first = controller(f), peer = controller(f);
  try {
    await first.manager.on(); await peer.manager.on(); const peerClient = await peer.client();
    const info = JSON.parse((await peerClient.call("browser_snapshot")).content[0].text);
    await assert.rejects(first.manager.off(true), /same-workspace peers/);
    process.kill(info.pid, 0); process.kill(info.descendant, 0); await access(f.project.optInPath);
    await peer.manager.shutdown(); await access(f.project.directory); // No deferred off after peer exits.
    await first.manager.off(true); await assert.rejects(access(f.project.directory), { code: "ENOENT" });
  } finally { await first.manager.shutdown(); await peer.manager.shutdown(); await (await first.client())?.close(); await (await peer.client())?.close(); }
});
