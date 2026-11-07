/** Gated real SDK/MCP fixture. No normal stores, model switching, router control, or paid fallback. */
if (process.env.WORKBENCH_LIVE_TESTS !== "1" || process.env.WORKBENCH_PLAYWRIGHT_LIVE_TESTS !== "1") throw new Error("Explicit Playwright live approval gates required");
const { default: assert } = await import("node:assert/strict");
const { readFile } = await import("node:fs/promises");
const { join } = await import("node:path");
const { fileURLToPath } = await import("node:url");
const { createServer } = await import("node:http");
const { randomUUID } = await import("node:crypto");
const { Type } = await import("typebox");
const { createJiti } = await import("jiti");
const { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, createMcpExtension, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const root = process.env.WB_PLAYWRIGHT_LIVE_ROOT, agentDir = process.env.PI_CODING_AGENT_DIR, modelId = process.env.WB_PLAYWRIGHT_MODEL;
assert.equal(modelId, "Ornith-1.5-35B-A3B-q5-mtp0");
const extension = fileURLToPath(new URL("../../src/index.ts", import.meta.url)), runtimes = [], checks = [], notices = [], nested = [];
const report = { model: `llama.cpp/${modelId}`, checks, imagesCapturedInPi: 0, unverified: ["Provider/model image input and visual interpretation: authorized fixture model is text-only", "Real CLI TUI and RPC wire transport (SDK RPC-context dialogs only)"] };
let confirm = false, questions = 0;
const jiti = createJiti(import.meta.url, { fsCache: false });
const { WORKBENCH_PATHS } = await jiti.import("../../src/paths.ts");
const { resolvePlaywrightProject, resolvePlaywrightSession } = await jiti.import("../../src/playwright-config.ts");
const { readPlaywrightOwnership } = await jiti.import("../../src/playwright-ownership.ts");
const { PlaywrightOwnedTree } = await jiti.import("../../src/playwright-tree.ts");
const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
const model = modelRuntime.getModel("llama.cpp", modelId); assert.ok(model); assert.deepEqual(model.input, ["text"]);
const server = createServer((_request, response) => { response.setHeader("content-type", "text/html"); response.end("<!doctype html><title>Synthetic live</title><h1>WB_LIVE_PAGE</h1><p>Only synthetic acceptance content.</p>"); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const url = `http://127.0.0.1:${server.address().port}/`;
async function loaded() {
  const response = await fetch(process.env.LLAMA_BASE_URL.replace(/\/$/, "") + "/models", { headers: { Authorization: `Bearer ${process.env.LLAMA_API_KEY}` }, signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200); assert.equal((await response.json()).data.find(item => item.id === modelId)?.status?.value, "loaded", "MODEL_NOT_READY: no autoload permitted");
}
async function wait(condition, label, timeout = 60000) { const end = Date.now() + timeout; while (!await condition()) { if (Date.now() >= end) throw new Error(`Live deadline: ${label}`); await new Promise(resolve => setTimeout(resolve, 100)); } }
const name = suffix => `mcp__playwright__${suffix}`;
const ready = runtime => runtime.session.getActiveToolNames().includes(name("browser_snapshot"));
function probeExtension(pi) {
  pi.on("tool_call", event => { if (event.toolName.startsWith("mcp__playwright__")) nested.push({ name: event.toolName, parent: !!event.parentToolCallId }); });
  pi.registerTool({ name: "wb_playwright_live_probe", label: "Synthetic Playwright acceptance", description: "Synthetic nested-call acceptance fixture only", reachesTools: () => "all",
    parameters: Type.Object({ action: Type.Union(["snapshot", "image", "policy", "navigate", "state-set", "state-get"].map(value => Type.Literal(value))) }),
    execute: async (_id, input, signal, _update, ctx) => {
      const registered = pi.getMcpServers().find(item => item.name === "playwright"); assert.ok(registered);
      assert.equal(registered.config.toolExposure.browser_run_code_unsafe, "hidden"); assert.equal(registered.config.toolExposure["*"], "hidden");
      const spec = JSON.parse(registered.config.args[1]), session = resolvePlaywrightSession(resolvePlaywrightProject(ctx.cwd, WORKBENCH_PATHS), spec.sessionId);
      const call = async (tool, args = {}) => { const outcome = await ctx.executeTool(name(tool), args, { signal }); assert.equal(outcome.isError, false, `Nested ${tool} must succeed`); return outcome.result; };
      const evaluate = async expression => { const filename = join(session.artifacts, `live-${randomUUID()}.json`); await call("browser_evaluate", { function: expression, filename }); return JSON.parse(await readFile(filename, "utf8")); };
      let details = {};
      if (input.action === "navigate") await call("browser_navigate", { url });
      else if (input.action === "snapshot") { const result = await call("browser_snapshot"); assert.match(JSON.stringify(result), /WB_LIVE_PAGE/); }
      else if (input.action === "state-set") await evaluate("() => {localStorage.setItem('wb_live','WB_LIVE_STATE');return true}");
      else if (input.action === "state-get") details.state = await evaluate("() => localStorage.getItem('wb_live')");
      else if (input.action === "image") {
        const result = await call("browser_take_screenshot"); // Inline image plus automatic managed artifact; explicit filename returns only a link.
        const images = result.content.filter(part => part.type === "image" && part.mimeType === "image/png"); assert.ok(images.length); report.imagesCapturedInPi += images.length;
        // Never feed an image to this text-only model or pretend visual interpretation.
        details.images = images.length;
      } else if (input.action === "policy") {
        assert.equal(ctx.tools.some(tool => tool.name === name("browser_run_code_unsafe")), false);
        assert.equal((await ctx.executeTool(name("browser_run_code_unsafe"), { code: "() => 12345" }, { signal })).isError, true);
        assert.equal((await ctx.executeTool(name("browser_webmcp_call"), { name: "synthetic" }, { signal })).isError, true);
        assert.equal((await ctx.executeTool(name("browser_take_screenshot"), { filename: "escaped.png" }, { signal })).isError, true);
        assert.equal(await evaluate("() => 12345"), 12345); // Normal page evaluation remains reachable after denials.
      }
      return { content: [{ type: "text", text: "Synthetic probe completed" }], details };
    } });
}
async function bind(runtime) {
  const ui = Object.create(runtime.session.extensionRunner.getUIContext());
  ui.notify = message => notices.push(String(message)); ui.setStatus = () => {}; ui.confirm = async () => { questions++; return confirm; };
  await runtime.session.bindExtensions({ uiContext: ui, mode: "rpc", onError: error => notices.push(String(error)) });
}
async function session(cwd) {
  const factory = async ({ cwd: current, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd: current, agentDir, modelRuntime,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { mode: "off" } }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [extension], extensionFactories: [createMcpExtension(), probeExtension] } });
    const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel: "off", noTools: "builtin" });
    assert.equal(created.modelFallbackMessage, undefined); return { ...created, services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) }); runtimes.push(runtime); await bind(runtime);
  assert.equal(runtime.session.model.provider, "llama.cpp"); assert.equal(runtime.session.model.id, modelId); await wait(() => ready(runtime), "owned direct browser tools"); return runtime;
}
async function probe(runtime, action) {
  const definition = runtime.session.state.tools.find(tool => tool.name === "wb_playwright_live_probe"); assert.ok(definition);
  return definition.execute(`live-${randomUUID()}`, { action }, AbortSignal.timeout(90000));
}
async function scope(runtime) {
  // Probe command exposes no secrets; inspect only this SDK session's registered launcher spec.
  const cwd = runtime.session.sessionManager.getCwd(), directory = resolvePlaywrightProject(cwd, WORKBENCH_PATHS).directory;
  const { readdir } = await import("node:fs/promises"); const candidates = [];
  for (const id of await readdir(join(directory, "sessions"))) { const session = resolvePlaywrightSession(resolvePlaywrightProject(cwd, WORKBENCH_PATHS), id), evidence = await readPlaywrightOwnership(session); if (evidence) candidates.push(evidence); }
  return candidates; // Same-workspace peers are separately retained, never signalled by this helper.
}
process.once("SIGTERM", () => { setTimeout(() => process.exit(1), 15000).unref(); void Promise.allSettled(runtimes.map(runtime => runtime.dispose())).then(() => process.exit(1)); });
try {
  const first = await session(join(root, "a")), peer = await session(join(root, "a")), other = await session(join(root, "b"));
  assert.equal(first.session.getActiveToolNames().includes(name("browser_run_code_unsafe")), false);
  await loaded(); const events = [], unsubscribe = first.session.subscribe(event => events.push(event)); const timeout = setTimeout(() => { void first.session.abort(); }, 90000);
  try { await first.session.prompt(`Call ${name("browser_navigate")} with url ${JSON.stringify(url)}. Then reply with the page heading. Use no other tool. Synthetic acceptance only.`); }
  finally { clearTimeout(timeout); unsubscribe(); }
  assert.ok(events.some(event => event.type === "tool_execution_start" && event.toolName === name("browser_navigate"))); assert.match(first.session.getLastAssistantText(), /WB_LIVE_PAGE/);
  assert.ok(first.session.messages.filter(message => message.role === "assistant").every(message => !["error", "aborted", "length"].includes(message.stopReason)));
  checks.push("exact already-loaded local model invokes actual direct Playwright tool and reads synthetic page");
  await probe(first, "policy"); await probe(first, "image"); await probe(first, "state-set"); await probe(peer, "navigate");
  assert.equal((await probe(peer, "state-get")).details.state, null); assert.equal((await probe(first, "state-get")).details.state, "WB_LIVE_STATE");
  assert.ok(nested.some(event => event.parent && event.name === name("browser_evaluate"))); checks.push("actual nested Pi pipeline, hidden unsafe/WebMCP denials, managed outputs, page evaluation and screenshot image capture");
  if (process.env.WORKBENCH_PLAYWRIGHT_LIVE_COMPRESSION === "1") {
    await first.session.prompt("/wb:headroom-proxy on"); assert.ok(!notices.some(message => /unavailable|failed/i.test(message))); await probe(first, "image"); await first.session.prompt("/wb:headroom-proxy off");
    checks.push("Pi nested screenshot capture with explicitly opted-in managed compression online; provider image input remains unverified");
  } else report.unverified.push("Compression-on image capture: requires separate approved WORKBENCH_PLAYWRIGHT_LIVE_COMPRESSION=1");
  const oldScopes = await scope(first); await first.session.reload(); await bind(first); await wait(() => ready(first), "reload restores browser namespace");
  await probe(first, "navigate"); assert.equal((await probe(first, "state-get")).details.state, null);
  await probe(first, "state-set"); assert.equal((await first.newSession()).cancelled, false); await bind(first); await wait(() => ready(first), "session replacement restores browser namespace");
  await probe(first, "navigate"); assert.equal((await probe(first, "state-get")).details.state, null);
  // At least the old invoking session has stopped; same-workspace peer remains live.
  assert.ok((await Promise.all(oldScopes.map(async evidence => (await new PlaywrightOwnedTree(evidence.scope, evidence.roots).capture()).processes.length))).some(count => count === 0));
  checks.push("reload/session replacement reset isolated browser state while peer remains usable");
  const before = questions; confirm = false; await first.session.prompt("/wb:playwright off"); assert.ok(questions > before); assert.ok(ready(first));
  confirm = true; await first.session.prompt("/wb:playwright off"); await wait(() => !ready(first), "invoker tool removal"); await probe(peer, "snapshot"); assert.ok(notices.some(message => /same-workspace peers/.test(message)));
  await peer.dispose(); await first.session.prompt("/wb:playwright off"); await probe(other, "navigate"); await probe(other, "snapshot"); await other.session.prompt("/wb:playwright off");
  checks.push("SDK RPC-context confirmation refusal/approval, peer-busy retention, explicit later deletion and other-workspace protection");
  report.passed = true; console.log(JSON.stringify(report, null, 2));
} finally { await Promise.allSettled(runtimes.map(runtime => runtime.dispose())); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
