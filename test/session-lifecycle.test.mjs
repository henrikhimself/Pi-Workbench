import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { default: extension } = await jiti.import("../src/index.ts");
const { resolveWorkbenchPaths } = await jiti.import("../src/paths.ts");
const { resolveCompressionProject, setCompressionOptIn } = await jiti.import("../src/headroom-project.ts");

// A deliberately unresolved bootstrap proves session_start does not await it.
test("SDK without UI theme stays non-blocking; shutdown fences late readiness and preserves original context", { timeout: 5000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "wb-session-fence-"));
  const paths = resolveWorkbenchPaths(home), handlers = new Map(), statuses = [], notifications = [];
  let finish, started = false, stops = 0;
  const waiting = new Promise(resolve => { finish = resolve; });
  const proxy = { isManaged: false, resume() {}, ensureRunning: async report => { started = true; report("fixture proxy starting"); return waiting; },
    healthCheck: async () => { throw new Error("unknown occupant must not receive requests"); },
    stop: async () => { stops++; }, tryRestart: async () => false };
  const pi = { on: (name, handler) => handlers.set(name, handler), registerCommand() {}, appendEntry() {},
    getActiveTools: () => [], registerMcpServer() { assert.fail("opted-out components must not register"); }, unregisterMcpServer() {} };
  const ctx = { cwd: home, hasUI: false, model: { id: "fixture" }, sessionManager: { getBranch: () => [] },
    ui: { setStatus: (...args) => statuses.push(args), notify: (...args) => notifications.push(args) } };
  try {
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
    await writeFile(paths.headroomConfig, JSON.stringify({ schemaVersion: 1 }));
    await setCompressionOptIn(resolveCompressionProject(home, paths), true);
    extension(pi, { workbenchPaths: paths, proxyManager: proxy });
    await assert.doesNotReject(handlers.get("session_start")({}, ctx), "missing theme must not interrupt actual progress callback");
    for (let attempt = 0; attempt < 100 && !started; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(started, true);
    assert.ok(statuses.some(([, text]) => text === "fixture proxy starting"), "missing theme must not interrupt actual progress callback");
    const event = { messages: [{ role: "user", content: "keep original", timestamp: 1 }] };
    assert.equal(await handlers.get("context")(event, ctx), undefined);
    assert.equal(event.messages[0].content, "keep original");
    await handlers.get("session_shutdown")();
    const before = statuses.length;
    finish(true); await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(stops, 1);
    assert.equal(statuses.length, before, "late bootstrap cannot revive status/watchdog after shutdown");
    const sections = {}; handlers.get("before_agent_start")({ systemPromptOptions: { sections } });
    assert.equal(sections["pi-workbench-code-graph"], undefined);
  } finally { finish(false); await handlers.get("session_shutdown")?.(); await rm(home, { recursive: true, force: true }); }
});
