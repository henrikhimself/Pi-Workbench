import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createJiti } from "jiti";
import { playwrightFixture } from "./helpers/playwright-fixture.mjs";
const jiti = createJiti(import.meta.url);
const tool = await jiti.import("../src/playwright-vision-tool.ts");
const { createPlaywrightIntegration, PLAYWRIGHT_PROMPT_SECTION } = await jiti.import("../src/playwright-integration.ts");
const { resolveWorkbenchPaths } = await jiti.import("../src/paths.ts");
const config = await jiti.import("../src/playwright-config.ts");
const { Value } = await import("typebox/value");
const READY = { state: "ready", target: { provider: "llama.cpp", model: "Qwen3-VL-4B-q4" } };
const png = Buffer.from("synthetic-png").toString("base64");
const shot = { toolCall: {}, isError: false, result: { content: [{ type: "text", text: "### Result\n- [Screenshot of viewport](/managed/artifacts/page-1.png)" }, { type: "image", data: png, mimeType: "image/png" }], details: {} } };

function toolFixture({ outcome = shot, registry, state = READY, available = true } = {}) {
  const calls = [], completions = [];
  const model = { id: "Qwen3-VL-4B-q4", provider: "llama.cpp", input: ["text", "image"], baseUrl: "http://router.invalid/v1" };
  const reg = registry ?? { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }), complete: async (...args) => { completions.push(args); return { stopReason: "stop", content: [{ type: "text", text: "An Approve button." }] }; } };
  const ctx = { modelRegistry: reg, executeTool: async (name, args, options) => { calls.push({ name, args, options }); return outcome; } };
  return { calls, completions, model, ctx, def: tool.createScreenshotDescribeTool({ config: async () => state, available: () => available }) };
}
const run = (f, params = {}, signal = new AbortController().signal) => f.def.execute("id", params, signal, undefined, f.ctx);

test("describe refuses before any screenshot when browser_take_screenshot is not callable", async () => {
  const f = toolFixture(); f.ctx.tools = [{ name: "mcp__playwright__browser_snapshot" }];
  await assert.rejects(run(f), /browser_take_screenshot.*active.*browser_snapshot/s); assert.equal(f.calls.length, 0);
  const g = toolFixture(); g.ctx.tools = [{ name: "mcp__playwright__browser_take_screenshot" }];
  await run(g).catch(() => {}); assert.equal(g.calls.length, 1);
});
test("tool schema is strict and the tool is inactive by default", () => {
  const f = toolFixture(); assert.equal(f.def.name, "wb_screenshot_describe"); assert.equal(f.def.defaultActive, false);
  assert.equal(Value.Check(f.def.parameters, {}), true); assert.equal(Value.Check(f.def.parameters, { question: "x", fullPage: true }), true);
  for (const bad of [{ filename: "../x.png" }, { question: 5 }, { fullPage: "yes" }, { question: "x".repeat(501) }, { scale: "device" }]) assert.equal(Value.Check(f.def.parameters, bad), false, JSON.stringify(bad));
});
test("success takes a guarded css screenshot, returns text only, never an image block", async () => {
  const model = { id: "Qwen3-VL-4B-q4", provider: "llama.cpp", input: ["text", "image"], baseUrl: "http://router.invalid/v1" }, completions = [];
  const registry = { find: () => model, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", baseUrl: model.baseUrl }), complete: async (...args) => { completions.push(args); return { stopReason: "stop", content: [{ type: "text", text: "An Approve button." }] }; } };
  const original = globalThis.fetch; globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: model.id, status: { value: "loaded" } }] }));
  try {
    const f = toolFixture({ registry }), result = await run(f, { question: "Which button is green?" });
    assert.deepEqual(f.calls.map(call => [call.name, call.args]), [["mcp__playwright__browser_take_screenshot", { scale: "css" }]]);
    assert.equal(f.calls[0].options.signal instanceof AbortSignal, true);
    assert.ok(result.content.every(part => part.type === "text"), "no image block returned");
    assert.match(result.content[0].text, /An Approve button\./); assert.match(result.content[0].text, /page-1\.png/);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(png)); assert.equal(result.details.model, "llama.cpp/Qwen3-VL-4B-q4");
    assert.ok(!("filename" in f.calls[0].args));
    await run(f, { fullPage: true }); assert.deepEqual(f.calls[1].args, { scale: "css", fullPage: true });
    assert.equal(completions.length, 2);
  } finally { globalThis.fetch = original; }
});
test("unavailable Playwright or unset config take no screenshot", async () => {
  for (const [label, options, pattern] of [["not available", { available: false }, /not available/], ["absent", { state: { state: "absent" } }, /No screenshot was taken.*Vision bridge: off/s], ["unset", { state: { state: "unset" } }, /No screenshot was taken/], ["invalid", { state: { state: "invalid", reason: "playwright.json is not valid JSON." } }, /not valid JSON/]]) {
    const f = toolFixture(options); await assert.rejects(run(f), pattern, label); assert.equal(f.calls.length, 0, label);
  }
});
test("screenshot and vision failures surface a reason, keep screenshot details, and never leak secrets", async () => {
  let f = toolFixture({ outcome: { ...shot, isError: true, result: { content: [{ type: "text", text: "browser closed" }], details: {} } } });
  await assert.rejects(run(f), /Screenshot failed: browser closed/);
  f = toolFixture({ outcome: { ...shot, result: { content: [{ type: "text", text: "no image here" }], details: {} } } });
  await assert.rejects(run(f), /returned no image.*no image here/s);
  f = toolFixture(); // find() returns undefined -> the configured model is missing from the registry
  await assert.rejects(run(f), error => /unavailable/.test(error.message) && /browser_snapshot/.test(error.message) && /page-1\.png/.test(error.message) && !error.message.includes(png));
  assert.equal(f.completions.length, 0);
});
test("caller abort is passed to the nested screenshot", async () => {
  const f = toolFixture(), controller = new AbortController();
  f.ctx.executeTool = async (_name, _args, options) => { assert.equal(options.signal, controller.signal); controller.abort(new Error("stop")); throw options.signal.reason; };
  await assert.rejects(run(f, {}, controller.signal), /stop/);
});

async function integrationFixture(t, { model } = {}) {
  const f = await playwrightFixture(t), paths = resolveWorkbenchPaths(f.home), commands = new Map(), registry = new Map(), statuses = [], registered = [];
  let vision = { state: "absent" }, tools = [], active = []; const setCalls = [];
  const pi = { registerCommand: (name, value) => commands.set(name, value), registerTool: def => registered.push(def), registerMcpServer: (name, value) => registry.set(name, value), unregisterMcpServer: name => registry.delete(name),
    getMcpServers: () => [...registry].map(([name, value]) => ({ name, config: value })), getAllTools: () => tools.map(name => ({ name })), getActiveTools: () => active, setActiveTools: names => { setCalls.push([...names]); active = [...names]; } };
  const ctx = { cwd: f.workspace, hasUI: false, mode: "print", model, ui: { theme: { fg: (_color, text) => text }, setStatus: (key, text) => statuses.push({ key, text }), notify() {}, confirm: async () => false } };
  const integration = createPlaywrightIntegration(pi, { paths, agentDir: () => join(f.root, "agent"), observationMs: 200,
    manager: (cwd, deps) => {
      let registeredServer = false, child = false;
      const server = { type: "stdio", command: "/synthetic-only", args: [cwd] }, project = config.resolvePlaywrightProject(cwd, paths);
      return { project, managedSession: config.resolvePlaywrightSession(project),
        get isManagedRegistration() { return registeredServer && deps.isCurrent(server); },
        async on() { registeredServer = true; child = true; deps.register("playwright", server); tools = ["mcp__playwright__browser_snapshot", "mcp__playwright__browser_take_screenshot"]; active = [...new Set([...active, ...tools])]; },
        async ownsToolRoute() { return registeredServer && child; }, async restore() {},
        async shutdown() { if (registeredServer && deps.isCurrent(server)) deps.unregister("playwright"); registeredServer = false; child = false; },
        async off() { return true; }, visionConfig: async () => vision,
        async status() { return { intent: "on", vision, registered: registeredServer, currentRegistration: this.isManagedRegistration, ownedChild: child, tools, selected: null, workspace: cwd, directory: project.directory, session: this.managedSession.directory, consumers: 1, failures: [] }; } };
    } });
  t.after(() => integration.shutdown());
  return { ...f, integration, ctx, statuses, registered, setCalls, active: () => active, setActive: names => { active = [...names]; }, setVision: value => { vision = value; }, command: raw => commands.get("wb:playwright").handler(raw, ctx),
    guidance: async () => { const options = { sections: {} }; await integration.beforeAgent(options, ctx); return options.sections[PLAYWRIGHT_PROMPT_SECTION]; } };
}
const textModel = { id: "Ornith", input: ["text"] }, imageModel = { id: "Qwen3-VL-4B-q4", input: ["text", "image"] };

test("integration registers the describe tool inactive and declares it only when Playwright and vision are both ready", async t => {
  const f = await integrationFixture(t, { model: textModel });
  assert.deepEqual(f.registered.map(def => [def.name, def.defaultActive]), [["wb_screenshot_describe", false], ["wb_screenshot_locate", false]]);
  assert.equal(f.active().includes("wb_screenshot_describe"), false);
  await f.command("on"); await f.integration.refresh(f.ctx);
  assert.equal(f.active().includes("wb_screenshot_describe"), false, "playwright up but vision unset: tool stays undeclared");
  assert.doesNotMatch(await f.guidance(), /wb_screenshot_describe/);
  assert.doesNotMatch(f.statuses.at(-1).text, /vision/);
  f.setVision(READY); await f.integration.refresh(f.ctx);
  assert.equal(f.active().includes("wb_screenshot_describe"), true);
  assert.match(f.statuses.at(-1).text, /Playwright · vision/);
  f.setVision({ state: "invalid", reason: "playwright.json is not valid JSON." }); await f.integration.refresh(f.ctx);
  assert.equal(f.active().includes("wb_screenshot_describe"), false); assert.doesNotMatch(f.statuses.at(-1).text, /vision/);
  f.setVision(READY); await f.integration.refresh(f.ctx); assert.equal(f.active().includes("wb_screenshot_describe"), true);
  // L2: shutdown never touches the active set (Pi rebuilds it for the replacement session).
  const before = f.setCalls.length; await f.integration.shutdown(); assert.equal(f.setCalls.length, before, "session_shutdown makes no setActiveTools call");
});
test("L2: tools are added only on the unavailable-to-available edge and only for a model that cannot read images", async t => {
  const image = await integrationFixture(t, { model: imageModel });
  await image.command("on"); image.setVision(READY); await image.integration.refresh(image.ctx);
  assert.equal(image.active().includes("wb_screenshot_describe"), false, "an image-capable model reads screenshots itself");
  assert.equal(image.setCalls.length, 0);
  const text = await integrationFixture(t, { model: textModel });
  await text.command("on"); text.setVision(READY); await text.integration.refresh(text.ctx);
  assert.equal(text.active().includes("wb_screenshot_describe") && text.active().includes("wb_screenshot_locate"), true);
  const calls = text.setCalls.length;
  await text.integration.refresh(text.ctx); await text.integration.refresh(text.ctx);
  assert.equal(text.setCalls.length, calls, "no change between edges");
});
test("L2: a tool the user deactivated stays off while available, and a tool the user activated is never removed", async t => {
  const f = await integrationFixture(t, { model: textModel });
  f.setActive(["wb_screenshot_locate"]);                                  // the user already had locate on
  await f.command("on"); f.setVision(READY); await f.integration.refresh(f.ctx);
  assert.deepEqual(f.active().filter(n => n.startsWith("wb_")).sort(), ["wb_screenshot_describe", "wb_screenshot_locate"], "only the missing one is added");
  f.setActive(f.active().filter(n => n !== "wb_screenshot_describe"));       // the user turns describe off again
  await f.integration.refresh(f.ctx);
  assert.equal(f.active().includes("wb_screenshot_describe"), false, "not re-activated by a later refresh");
  f.setVision({ state: "unset" }); await f.integration.refresh(f.ctx);
  assert.equal(f.active().includes("wb_screenshot_locate"), true, "the user's own activation survives; Workbench removes only what it added");
  assert.equal(f.active().includes("wb_screenshot_describe"), false);
});
test("guidance recommends the tool only to a model without image input and follows model switches", async t => {
  const f = await integrationFixture(t, { model: textModel });
  await f.command("on"); f.setVision(READY);
  const text = await f.guidance();
  assert.match(text, /You cannot read images.*wb_screenshot_describe.*instead of browser_take_screenshot/s); assert.match(text, /untrusted page content/); assert.match(text, /browser_snapshot for structure/);
  f.ctx.model = imageModel; assert.doesNotMatch(await f.guidance(), /wb_screenshot_describe/);
  f.ctx.model = undefined; assert.doesNotMatch(await f.guidance(), /wb_screenshot_describe/);
  f.ctx.model = textModel; assert.match(await f.guidance(), /wb_screenshot_describe/);
  f.setVision({ state: "unset" }); assert.doesNotMatch(await f.guidance(), /wb_screenshot_describe/);
});
test("L2: switching from an image model to a text-only model adds the vision tools once", async t => {
  const f = await integrationFixture(t, { model: imageModel });
  await f.command("on"); f.setVision(READY); await f.integration.refresh(f.ctx);
  assert.deepEqual(f.active().filter(n => n.startsWith("wb_")), []);
  assert.equal(f.setCalls.length, 0);
  f.ctx.model = textModel;
  f.integration.modelSelect({ type: "model_select", model: textModel, previousModel: imageModel, source: "set" });
  assert.deepEqual(f.active().filter(n => n.startsWith("wb_")).sort(), ["wb_screenshot_describe", "wb_screenshot_locate"]);
  assert.equal(f.setCalls.length, 1);
  await f.integration.refresh(f.ctx); await f.integration.refresh(f.ctx);
  assert.equal(f.setCalls.length, 1);
  assert.match(await f.guidance(), /wb_screenshot_describe/);
  const lazy = await integrationFixture(t, { model: imageModel });
  await lazy.command("on"); lazy.setVision(READY); await lazy.integration.refresh(lazy.ctx);
  lazy.ctx.model = textModel;
  assert.match(await lazy.guidance(), /wb_screenshot_describe/);
  assert.deepEqual(lazy.active().filter(n => n.startsWith("wb_")).sort(), ["wb_screenshot_describe", "wb_screenshot_locate"]);
});
test("guidance names only the vision tools that are active", async t => {
  const f = await integrationFixture(t, { model: textModel });
  await f.command("on"); f.setVision(READY); await f.integration.refresh(f.ctx);
  f.setActive(f.active().filter(n => n !== "wb_screenshot_describe"));
  const text = await f.guidance();
  assert.doesNotMatch(text, /wb_screenshot_describe/);
  assert.match(text, /wb_screenshot_locate/);
  assert.equal(f.active().includes("wb_screenshot_describe"), false, "not re-added");
});
test("the registered tool refuses before any screenshot when Playwright is not available", async t => {
  const f = await integrationFixture(t, { model: textModel }), def = f.registered[0], calls = [];
  const ctx = { executeTool: async (...args) => { calls.push(args); return shot; }, modelRegistry: {} };
  await assert.rejects(def.execute("id", {}, undefined, undefined, ctx), /not available/); assert.equal(calls.length, 0);
  await f.command("on"); f.setVision({ state: "unset" });
  await assert.rejects(def.execute("id", {}, undefined, undefined, ctx), /No screenshot was taken/); assert.equal(calls.length, 0);
});

test("L3: the nested vision usage is returned on the describe tool result, and absent when the model reports none", async () => {
  const model = { id: "Qwen3-VL-4B-q4", provider: "llama.cpp", input: ["text", "image"], baseUrl: "http://router.invalid/v1" };
  const usage = { input: 900, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 930, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const make = withUsage => ({ find: () => model, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", baseUrl: model.baseUrl }), complete: async () => ({ stopReason: "stop", ...(withUsage ? { usage } : {}), content: [{ type: "text", text: "A page." }] }) });
  const original = globalThis.fetch; globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: model.id, status: { value: "loaded" } }] }));
  try {
    assert.deepEqual((await run(toolFixture({ registry: make(true) }))).usage, usage);
    assert.equal("usage" in await run(toolFixture({ registry: make(false) })), false);
  } finally { globalThis.fetch = original; }
});
