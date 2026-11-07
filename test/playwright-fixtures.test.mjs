import { test } from "node:test";
import assert from "node:assert/strict";
import { lstat, readFile, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { playwrightFixture, fakePlaywrightServices, syntheticPlaywrightOwnership } from "./helpers/playwright-fixture.mjs";

const script = fileURLToPath(new URL("./helpers/fake-playwright-mcp.mjs", import.meta.url));
function client(t, env, args = []) {
  const child = spawn(process.execPath, [script, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map(), notifications = [];
  let nextId = 0, errors = "";
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  child.stderr.on("data", chunk => { errors += chunk; });
  createInterface({ input: child.stdout }).on("line", line => {
    const message = JSON.parse(line);
    if (message.id !== undefined) pending.get(message.id)?.(message);
    else notifications.push(message);
  });
  async function close(signal) {
    if (child.exitCode === null && child.signalCode === null) {
      if (signal) child.kill(signal); else child.stdin.end();
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    try { return await exited; } finally { clearTimeout(timer); }
  }
  t.after(() => close());
  return { child, notifications, errors: () => errors, close,
    call(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Synthetic MCP timed out: ${method}: ${errors}`)); }, 2500);
        pending.set(id, message => { clearTimeout(timer); pending.delete(id); resolve(message); });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
  };
}
const textResult = response => JSON.parse(response.result.content[0].text);

test("Playwright fixture uses disposable private roots and leaves global environment unchanged", async t => {
  const homeBefore = process.env.HOME;
  const fixture = await playwrightFixture(t);
  assert.equal(process.env.HOME, homeBefore);
  assert.notEqual(fixture.env.HOME, homeBefore);
  assert.equal((await lstat(fixture.home)).mode & 0o077, 0);
  assert.equal(fixture.env.WORKBENCH_RUNTIME_TESTS, "");
  assert.equal(fixture.env.WORKBENCH_LIVE_TESTS, "");
  await assert.rejects(access(fixture.managed), { code: "ENOENT" });
  const ownership = await syntheticPlaywrightOwnership(fixture.root + "/leases", fixture.workspaceId);
  assert.equal((await lstat(ownership.path)).mode & 0o077, 0);
  assert.equal(JSON.parse(await readFile(ownership.path, "utf8")).start, "synthetic-not-live");
  const second = await playwrightFixture(t);
  assert.notEqual(second.workspaceId, fixture.workspaceId);
  assert.notEqual(second.sessionId, fixture.sessionId);
});

test("Playwright fixture services inject metadata, provisioning, readiness, spawn and publication", async () => {
  const services = fakePlaywrightServices();
  assert.equal((await services.metadata()).mcp, "0.0.84");
  assert.equal((await services.install()).exitCode, 0);
  assert.equal((await services.provisionBrowser()).exitCode, 0);
  assert.equal((await services.readiness()).browserVersion, "synthetic-chromium");
  assert.equal((await services.spawn()).synthetic, true);
  await services.publish();
  assert.deepEqual(services.calls.map(call => call.name), ["metadata", "install", "provisionBrowser", "readiness", "spawn", "publish"]);
  const signal = AbortSignal.abort();
  await assert.rejects(services.install({ signal }), /cancelled/);
  const failing = fakePlaywrightServices({ readiness: async () => { throw new Error("injected readiness failure"); } });
  await assert.rejects(failing.readiness(), /injected readiness failure/);
});

test("synthetic MCP offers protocol, image payloads and process-local state without real backend", async t => {
  const fixture = await playwrightFixture(t);
  const a = client(t, fixture.env), b = client(t, fixture.env);
  const initialized = await a.call("initialize", { protocolVersion: "2024-11-05" });
  assert.equal(initialized.result.serverInfo.name, "synthetic-playwright");
  assert.ok((await a.call("tools/list")).result.tools.some(tool => tool.name === "browser_run_code_unsafe"), "unsafe tool deliberately available for future filtering tests");
  await a.call("tools/call", { name: "browser_evaluate", arguments: { fixtureSet: { key: "cookie", value: "synthetic" } } });
  assert.equal(textResult(await a.call("tools/call", { name: "browser_evaluate", arguments: { fixtureGet: "cookie" } })).value, "synthetic");
  assert.equal(textResult(await b.call("tools/call", { name: "browser_evaluate", arguments: { fixtureGet: "cookie" } })).value, null);
  const screenshot = await a.call("tools/call", { name: "browser_take_screenshot" });
  assert.equal(screenshot.result.content[1].type, "image");
  assert.equal((await a.close()).code, 0);
  assert.equal((await b.close()).code, 0);
  assert.equal(a.errors(), "");
});

for (const signal of [undefined, "SIGTERM"]) test(`synthetic MCP cleans Node browser descendant on ${signal ?? "EOF"}`, async t => {
  const fixture = await playwrightFixture(t);
  const instance = client(t, fixture.env, ["--spawn-browser", "--ignore-browser-term"]);
  const deadline = Date.now() + 2500;
  while (!instance.notifications.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  const notification = instance.notifications.find(message => message.method === "notifications/fixture/browser");
  assert.ok(notification, instance.errors());
  const pid = notification.params.pid;
  assert.equal(typeof pid, "number");
  process.kill(pid, 0);
  assert.equal((await instance.close(signal)).code, 0);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
