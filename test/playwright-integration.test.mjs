import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { createJiti } from "jiti";
import { playwrightFixture } from "./helpers/playwright-fixture.mjs";
const jiti = createJiti(import.meta.url);
const { createPlaywrightIntegration, PLAYWRIGHT_PROMPT_SECTION } = await jiti.import("../src/playwright-integration.ts");
const { resolveWorkbenchPaths } = await jiti.import("../src/paths.ts");
const config = await jiti.import("../src/playwright-config.ts");
const { ensurePrivateDirectory } = await jiti.import("../src/managed-lifecycle.ts");
const { PLAYWRIGHT_NORMAL_TOOLS, PLAYWRIGHT_TOOL_EXPOSURE } = await jiti.import("../src/playwright-policy.ts");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, hooks = {}) {
  const f = await playwrightFixture(t), paths = resolveWorkbenchPaths(f.home), commands = new Map(), registry = new Map(), statuses = [], notifications = [], managers = [];
  let tools = [], questions = 0;
  const pi = { registerCommand: (name, value) => commands.set(name, value), registerMcpServer: (name, value) => registry.set(name, value), unregisterMcpServer: name => registry.delete(name),
    getMcpServers: () => [...registry].map(([name, value]) => ({ name, config: value })), getAllTools: () => tools.map(name => ({ name })), getActiveTools: () => tools };
  const ctx = { cwd: f.workspace, hasUI: false, mode: "print", ui: { theme: { fg: (color, text) => `${color}:${text}` },
    setStatus: (key, text) => statuses.push({ key, text }), notify: (message, level) => notifications.push({ message, level }), confirm: async () => { questions++; return hooks.confirm ?? false; } } };
  const integration = createPlaywrightIntegration(pi, { paths, agentDir: () => join(f.root, "agent"), observationMs: 200,
    manager: (cwd, deps) => {
      let registered = false, child = false, intent = hooks.restore ?? false, epoch = 0;
      const server = { type: "stdio", command: "/synthetic-only", args: [cwd] }, project = config.resolvePlaywrightProject(cwd, paths);
      const m = { project, managedSession: config.resolvePlaywrightSession(project), onCalls: 0, offCalls: 0, stopCalls: 0,
        get isManagedRegistration() { return registered && deps.isCurrent(server); },
        async on() {
          m.onCalls++; const generation = epoch;
          const conflict = await deps.conflict(); if (conflict) throw new Error(conflict);
          if (hooks.on) await hooks.on(deps, m);
          if (generation !== epoch || deps.signal.aborted) throw new Error("Synthetic activation superseded");
          for (const stage of hooks.stages ?? []) deps.progress(stage);
          registered = true; child = true; intent = true; deps.register("playwright", server);
          if (!hooks.delayTools) tools = ["mcp__playwright__browser_snapshot", "mcp__playwright__browser_evaluate"];
        },
        async ownsToolRoute() { return m.isManagedRegistration && child; },
        async restore() { if (intent) await m.on(); },
        async shutdown() { epoch++; m.stopCalls++; if (registered && deps.isCurrent(server)) deps.unregister("playwright"); registered = false; child = false; },
        async off(confirmed) { if (!confirmed) return false; m.offCalls++; await m.shutdown(); intent = false; return true; },
        async status() {
          const snapshot = { intent: intent ? "on" : "off", registered, currentRegistration: m.isManagedRegistration, ownedChild: child, tools, selected: null, workspace: cwd, directory: project.directory, session: m.managedSession.directory, consumers: child ? 1 : 0, failures: [] };
          if (hooks.status) await hooks.status(m);
          return snapshot;
        },
      }; managers.push(m); return m;
    } });
  t.after(() => integration.shutdown());
  return { ...f, paths, pi, ctx, integration, commands, registry, statuses, notifications, managers, questions: () => questions, tools: names => { tools = names; }, command: raw => commands.get("wb:playwright").handler(raw, ctx) };
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test("Playwright integration factory registers command without starting managers or timers", async t => {
  const original = globalThis.setTimeout; globalThis.setTimeout = () => { throw new Error("Factory timer"); };
  let f; try { f = await fixture(t); assert.ok(f.commands.has("wb:playwright")); assert.equal(f.managers.length, 0); } finally { globalThis.setTimeout = original; }
});
test("Playwright normal core/vision exposure hides unsafe, optional, and later page-authored tools", () => {
  assert.equal(PLAYWRIGHT_NORMAL_TOOLS.length, 30); assert.equal(PLAYWRIGHT_TOOL_EXPOSURE["*"], "hidden");
  for (const name of ["browser_snapshot", "browser_evaluate", "browser_take_screenshot", "browser_mouse_click_xy"]) assert.equal(PLAYWRIGHT_TOOL_EXPOSURE[name], "direct");
  assert.equal(PLAYWRIGHT_TOOL_EXPOSURE.browser_run_code_unsafe, "hidden");
  for (const name of ["page_authored_tool", "browser_webmcp_call", "browser_pdf_save", "browser_start_tracing"]) assert.equal(PLAYWRIGHT_TOOL_EXPOSURE[name] ?? PLAYWRIGHT_TOOL_EXPOSURE["*"], "hidden");
});
test("Playwright footer and guidance follow passive startup, availability, and cleanup", async t => {
  const f = await fixture(t); await f.integration.start(f.ctx); assert.match(f.statuses.at(-1).text, /dim:○ Playwright off/);
  await f.command("on"); assert.match(f.statuses.at(-1).text, /success:✓ Playwright/);
  const options = { sections: {} }; await f.integration.beforeAgent(options, f.ctx); assert.match(options.sections[PLAYWRIGHT_PROMPT_SECTION], /image-capable model/); assert.match(options.sections[PLAYWRIGHT_PROMPT_SECTION], /call browser_snapshot to read page content/);
  assert.equal(f.integration.guidance(f.ctx), options.sections[PLAYWRIGHT_PROMPT_SECTION]);
  await f.integration.shutdown(); assert.equal(f.statuses.at(-1).text, undefined); await f.integration.beforeAgent(options, f.ctx); assert.equal(options.sections[PLAYWRIGHT_PROMPT_SECTION], undefined);
});
test("Playwright installation stages reach UI, never require invented percentages", async t => {
  const stages = ["Playwright waiting for installation lock...", "Playwright installing pinned npm packages...", "Playwright downloading Chromium...", "Playwright checking sandboxed browser readiness...", "Playwright registered; browser opens lazily on tool use"];
  const f = await fixture(t, { stages }); await f.command("on");
  for (const stage of stages) assert.ok(f.statuses.some(status => status.text?.includes(stage)));
  assert.equal(f.statuses.some(status => /\d+%/.test(status.text ?? "")), false);
});
test("Playwright delayed tool observation changes connecting footer without reactivation", async t => {
  const f = await fixture(t, { delayTools: true }); await f.command("on"); assert.match(f.statuses.at(-1).text, /connecting/);
  f.tools(["mcp__playwright__browser_snapshot"]); await wait(140); assert.match(f.statuses.at(-1).text, /✓ Playwright/); assert.equal(f.managers[0].onCalls, 1);
});
test("Playwright missing tools exhaust bounded observation without backend retry", async t => {
  const f = await fixture(t, { delayTools: true }); await f.command("on"); await wait(260);
  assert.match(f.statuses.at(-1).text, /unavailable/); assert.equal(f.managers[0].onCalls, 1);
});
test("Playwright headless refusal and RPC confirmation cancellation preserve active session", async t => {
  const f = await fixture(t); await f.command("on"); await f.command("off"); assert.equal(f.managers[0].offCalls, 0); assert.equal(f.questions(), 0);
  f.ctx.hasUI = true; f.ctx.mode = "rpc"; await f.command("off --confirm-delete"); assert.equal(f.questions(), 1); assert.equal(f.managers[0].offCalls, 0); assert.match(f.statuses.at(-1).text, /✓ Playwright/);
});
test("Playwright confirmed RPC off removes guidance and reports off", async t => {
  const f = await fixture(t, { confirm: true }); await f.command("on"); f.ctx.hasUI = true; f.ctx.mode = "rpc";
  await f.command("off"); assert.equal(f.managers[0].offCalls, 1); assert.match(f.statuses.at(-1).text, /Playwright off/); assert.equal(f.integration.guidance(f.ctx), undefined);
});
test("Playwright malformed arguments never withdraw healthy availability", async t => {
  const f = await fixture(t); await f.command("on"); const before = f.statuses.length; await f.command("status extra");
  assert.equal(f.statuses.length, before); assert.ok(f.integration.guidance(f.ctx)); assert.match(f.notifications.at(-1).message, /Usage:/);
});
for (const source of ["extension", "user", "project", "invalid"]) test(`Playwright ${source} MCP conflict leaves external configuration untouched`, async t => {
  const f = await fixture(t), external = { command: "/synthetic-external" };
  if (source === "extension") f.registry.set("playwright", external);
  else {
    const directory = source === "project" ? join(f.workspace, ".pi") : join(f.root, "agent"); await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "mcp.json"), source === "invalid" ? '{"synthetic-private-value":' : JSON.stringify({ mcpServers: { playwright: external } }));
  }
  await f.command("on"); assert.match(f.notifications.at(-1).message, /same-name|invalid/); assert.equal(f.notifications.at(-1).message.includes("synthetic-private-value"), false);
  assert.equal(f.registry.get("playwright"), source === "extension" ? external : undefined);
});
test("Playwright: an untrusted project's mcp.json is ignored (Pi ignores it too); a trusted one with a '_' spelling blocks registration", async t => {
  const f = await fixture(t), directory = join(f.workspace, ".pi"); await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "mcp.json"), "\ufeff" + JSON.stringify({ mcpServers: { playwright: { command: "/synthetic-external" } } }));
  f.ctx.isProjectTrusted = () => false; await f.command("on");
  assert.equal(f.registry.get("playwright") !== undefined, true, "untrusted project file does not block");
  await f.command("off");
  f.registry.clear(); f.ctx.isProjectTrusted = () => true;
  await f.command("on"); assert.match(f.notifications.at(-1).message, /same-name MCP declaration "playwright" in .*mcp\.json/);
  assert.equal(f.registry.get("playwright"), undefined);
});
test("Playwright unavailable public MCP APIs fail without unmanaged fallback", async t => {
  const f = await fixture(t); f.pi.registerMcpServer = undefined; await f.command("on"); assert.match(f.notifications.at(-1).message, /public Pi MCP APIs unavailable/); assert.equal(f.registry.size, 0);
});
test("Playwright direct and nested tool guards block unsafe/dynamic tools but retain page evaluation/uploads", async t => {
  const f = await fixture(t); await f.command("on"); const session = f.managers[0].managedSession;
  await ensurePrivateDirectory(session.project.root, session.artifacts);
  for (const parentToolCallId of [undefined, "codemode/1"]) {
    const result = await f.integration.toolCall({ toolName: "mcp__playwright__browser_run_code_unsafe", input: { code: "synthetic" }, parentToolCallId }, f.ctx); assert.equal(result.block, true);
  }
  assert.equal((await f.integration.toolCall({ toolName: "mcp__playwright__page_authored_tool", input: {} }, f.ctx)).block, true);
  assert.equal(await f.integration.toolCall({ toolName: "mcp__playwright__browser_evaluate", input: { function: "() => 1" } }, f.ctx), undefined);
  assert.equal(await f.integration.toolCall({ toolName: "mcp__playwright__browser_file_upload", input: { paths: [join(f.workspace, "upload.txt")] } }, f.ctx), undefined);
  assert.equal((await f.integration.toolCall({ toolName: "mcp__playwright__browser_take_screenshot", input: { filename: "project.png" } }, f.ctx)).block, true);
  const input = { filename: relative(f.workspace, join(session.artifacts, "allowed.png")) };
  assert.equal(await f.integration.toolCall({ toolName: "mcp__playwright__browser_take_screenshot", input }, f.ctx), undefined);
  assert.equal(input.filename, join(session.artifacts, "allowed.png"));
});
test("Playwright overridden registration withdraws guidance without modifying external namespace", async t => {
  const f = await fixture(t); await f.command("on"); const external = { command: "/synthetic-external" }; f.registry.set("playwright", external);
  await f.integration.refresh(f.ctx); assert.equal(f.integration.guidance(f.ctx), undefined); assert.match(f.statuses.at(-1).text, /unavailable/);
  await f.integration.shutdown(); assert.equal(f.registry.get("playwright"), external);
});
test("Playwright callable codemode exposure remains available without direct declarations", async t => {
  const f = await fixture(t); f.pi.getActiveTools = () => []; f.pi.getAllTools = () => [{ name: "mcp__playwright__browser_snapshot", exposure: "codemode" }];
  await f.command("on"); assert.match(f.statuses.at(-1).text, /✓ Playwright/); assert.ok(f.integration.guidance(f.ctx));
});
test("Playwright prefix-adjacent external namespaces are not guarded as owned", async t => {
  const f = await fixture(t); await f.command("on"); f.pi.getAllTools = () => [{ name: "mcp__playwright___browser_take_screenshot", namespace: { name: "mcp__playwright_" } }];
  assert.equal(await f.integration.toolCall({ toolName: "mcp__playwright___browser_take_screenshot", input: { filename: "external.png" } }, f.ctx), undefined);
});
test("Playwright unproven overridden route is not treated as an owned connection", async t => {
  const f = await fixture(t); await f.command("on"); f.managers[0].ownsToolRoute = async () => false;
  assert.equal(await f.integration.toolCall({ toolName: "mcp__playwright__browser_take_screenshot", input: { filename: "external.png" } }, f.ctx), undefined);
});
test("Playwright reconnectable owned route retains output guards while current child is offline", async t => {
  const f = await fixture(t); await f.command("on"); const previous = f.managers[0].status;
  f.managers[0].status = async () => ({ ...await previous(), ownedChild: false });
  await f.integration.refresh(f.ctx); assert.equal(f.integration.guidance(f.ctx), undefined);
  assert.equal((await f.integration.toolCall({ toolName: "mcp__playwright__browser_take_screenshot", input: { filename: "escaped.png" } }, f.ctx)).block, true);
});
test("Playwright tool result refreshes availability after reconnect without changing image content", async t => {
  const f = await fixture(t); await f.command("on"); const previous = f.managers[0].status;
  f.managers[0].status = async () => ({ ...await previous(), ownedChild: false }); await f.integration.refresh(f.ctx); assert.equal(f.integration.guidance(f.ctx), undefined);
  f.managers[0].status = previous;
  const event = { toolName: "mcp__playwright__browser_take_screenshot", content: [{ type: "image", mimeType: "image/png", data: "synthetic-image" }] }, original = structuredClone(event);
  await f.integration.toolResult(event, f.ctx); assert.match(f.statuses.at(-1).text, /✓ Playwright/); assert.deepEqual(event, original);
});
test("Playwright stale workspace calls are blocked without restricting unrelated tools", async t => {
  const f = await fixture(t); await f.command("on"); const cwd = join(f.root, "other-workspace"); await mkdir(cwd, { mode: 0o700 }); const ctx = { ...f.ctx, cwd };
  assert.equal((await f.integration.toolCall({ toolName: "mcp__playwright__browser_navigate", input: { url: "http://synthetic.invalid" } }, ctx)).block, true);
  assert.equal(f.integration.guidance(ctx), undefined); assert.equal(await f.integration.toolCall({ toolName: "bash", input: {} }, ctx), undefined);
});
test("Playwright stale status cannot update footer after shutdown", async t => {
  const hooks = {}, f = await fixture(t, hooks); await f.command("on"); const entered = deferred(), release = deferred();
  hooks.status = async () => { entered.resolve(); await release.promise; };
  const pending = f.integration.refresh(f.ctx); await entered.promise; await f.integration.shutdown(); const length = f.statuses.length;
  release.resolve(); await pending; assert.equal(f.statuses.length, length); assert.equal(f.statuses.at(-1).text, undefined);
});
test("Playwright late activation error after off cannot overwrite off footer", async t => {
  const entered = deferred(), release = deferred(), f = await fixture(t, { on: async () => { entered.resolve(); await release.promise; } });
  const on = f.command("on"); await entered.promise; await f.command("off --confirm-delete"); release.resolve(); await on;
  assert.match(f.statuses.at(-1).text, /Playwright off/); assert.equal(f.notifications.some(item => /superseded/.test(item.message)), false);
});
test("Playwright session replacement removes old guidance and ignores late old progress", async t => {
  let oldDeps; const f = await fixture(t, { on: async deps => { oldDeps = deps; } }); await f.command("on");
  const previous = f.managers[0]; await f.integration.start(f.ctx); assert.ok(previous.stopCalls); const length = f.statuses.length;
  oldDeps.progress("Playwright late old stage"); assert.equal(f.statuses.length, length); assert.equal(f.integration.guidance(f.ctx), undefined);
});
