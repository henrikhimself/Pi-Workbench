/** Real SDK sessions. Parent supplies only isolated roots and selected local credential. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices,
  createMcpExtension, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
if (process.env.WORKBENCH_LIVE_TESTS !== "1") throw new Error("Explicit live acceptance opt-in required");
const home = process.env.WB_LIVE_HOME, agentDir = process.env.WB_LIVE_AGENT, modelId = process.env.WB_LIVE_MODEL;
const extension = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const runtimes = [], checks = [], notices = [], statuses = [];
process.once("SIGTERM", () => {
  setTimeout(() => process.exit(1), 15000).unref();
  void Promise.allSettled(runtimes.map(async runtime => { await runtime.session.abort(); await runtime.dispose(); })).then(() => process.exit(1));
});
async function loaded() {
  const response = await fetch(process.env.LLAMA_BASE_URL.replace(/\/$/, "") + "/models", { headers: { Authorization: "Bearer " + process.env.LLAMA_API_KEY }, signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200); const data = await response.json();
  assert.equal(data.data.find(item => item.id === modelId)?.status?.value, "loaded", "MODEL_NOT_READY: do not autoload");
}
async function wait(condition, message, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (!await condition()) { if (Date.now() > deadline) throw new Error("Timed out: " + message + "; notices=" + JSON.stringify(notices.slice(-8))); await new Promise(resolve => setTimeout(resolve, 100)); }
}
const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
const model = modelRuntime.getModel("llama.cpp", modelId); assert.ok(model, "exact custom local model must resolve");
const jiti = createJiti(import.meta.url);
const { WORKBENCH_PATHS } = await jiti.import("../../src/paths.ts");
const { ProxyManager } = await jiti.import("../../src/proxy-manager.ts");
const proxy = new ProxyManager({ port: Number(process.env.WB_LIVE_PORT) });
async function session(cwd) {
  const factory = async ({ cwd: current, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd: current, agentDir, modelRuntime,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        additionalExtensionPaths: [extension], extensionFactories: [createMcpExtension()] } });
    const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel: "off", noTools: "builtin" });
    assert.equal(created.modelFallbackMessage, undefined); return { ...created, services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) }); runtimes.push(runtime);
  console.error(JSON.stringify({ cwd, diagnostics: servicesDiagnostic(runtime), extensions: runtime.services.resourceLoader.getExtensions().extensions.map(item => item.path) }));
  const ui = Object.create(runtime.session.extensionRunner.getUIContext());
  ui.notify = (message, type) => { notices.push(String(message)); console.error(JSON.stringify({ notice: String(message), type })); };
  ui.setStatus = (name, value) => { statuses.push({ name, value }); if (value) console.error(JSON.stringify({ status: name, value })); };
  await runtime.session.bindExtensions({ uiContext: ui, mode: "sdk", onError: error => notices.push(String(error)) });
  assert.equal(runtime.session.model.provider, "llama.cpp"); assert.equal(runtime.session.model.id, modelId);
  return runtime;
}
function servicesDiagnostic(runtime) { return runtime.diagnostics; }
function named(s, suffix) { return s.getActiveToolNames().find(name => name.endsWith("__" + suffix)); }
async function tool(s, suffix, args) {
  const name = named(s, suffix); assert.ok(name, "active direct tool: " + suffix);
  const definition = s.state.tools.find(item => item.name === name); assert.ok(definition);
  const result = await definition.execute("fixture-" + Date.now(), args, AbortSignal.timeout(60000));
  assert.notEqual(result?.isError, true); return result;
}
try {
  const a = await session(join(home, "a")), b = await session(join(home, "a")), c = await session(join(home, "b"));
  await wait(() => [a,c].every(runtime => named(runtime.session, "memory_search") && named(runtime.session, "search_graph")), "first workspace direct MCP readiness");
  await wait(() => named(b.session, "memory_search"), "peer Memory readiness");
  if (!named(b.session, "search_graph")) {
    await b.session.prompt("/wb:code-graph on");
    checks.push("busy startup safely defers graph; one later normal activation succeeds");
  }
  await wait(() => named(b.session, "search_graph"), "peer direct graph readiness");
  await wait(() => proxy.healthCheck(), "owned proxy readiness");
  const { resolveCodeGraphProject } = await jiti.import("../../src/code-graph-config.ts");
  const project = resolveCodeGraphProject(join(home, "a"), WORKBENCH_PATHS);
  assert.equal(JSON.parse(await readFile(project.statePath, "utf8")).version, "v0.12.1");
  const backups = await (await import("node:fs/promises")).readdir(join(WORKBENCH_PATHS.codeGraphRuntime, "backups"));
  assert.ok(backups.some(name => name.startsWith(project.identifier + ".backup-")), "startup upgrades opted-in controlled fixture without approval");
  checks.push("real Pi startup automatically upgrades controlled incompatible opt-in fixture with backup");
  for (const runtime of [a,b,c]) assert.equal(runtime.session.getAllTools().filter(item => item.name.endsWith("__search_graph")).length, 1);
  checks.push("three real SDK sessions register direct compatible MCP across same/different workspaces");
  const saved = await tool(a.session, "memory_save", { facts: ["Workbench live fixture sentinel violet_978163."] }); assert.ok(saved.content);
  assert.match(JSON.stringify(await tool(b.session, "memory_search", { query: "violet_978163 Workbench live fixture", top_k: 3 })), /violet_978163/);
  assert.doesNotMatch(JSON.stringify(await tool(c.session, "memory_search", { query: "violet_978163 Workbench live fixture", top_k: 3 })), /Workbench live fixture sentinel violet_978163/);
  checks.push("real direct Memory save/search, peer visibility and other-workspace isolation");
  const { compressionHistory } = await import("./live-context.mjs");
  for (const message of compressionHistory(model)) a.session.sessionManager.appendMessage(message);
  a.session.agent.state.messages = a.session.sessionManager.buildSessionContext().messages;
  await loaded();
  const search = named(a.session, "memory_search");
  const events = []; const unsub = a.session.subscribe(event => events.push(event));
  const abort = setTimeout(() => { void a.session.abort(); }, 90000);
  try { await a.session.prompt(`Call ${search} with query "violet_978163 Workbench live fixture" and top_k 1. Then reply with the retrieved sentinel. Use no other tool. This is synthetic acceptance data.`); }
  finally { clearTimeout(abort); unsub(); }
  const assistant = a.session.messages.filter(message => message.role === "assistant");
  assert.ok(assistant.length); assert.ok(assistant.every(message => !["error","aborted","length"].includes(message.stopReason)), "local inference must complete, not silently error/abort/truncate");
  assert.ok(events.some(event => event.type === "tool_execution_start" && event.toolName === search), "exact local model must actually invoke direct MCP tool");
  assert.match(a.session.getLastAssistantText(), /violet_978163/);
  const effectiveSystem = events.filter(event => event.type === "message_end" && event.message.role === "system").map(event => Object.values(event.message.sections ?? {}).join("\n")).join("\n");
  assert.match(effectiveSystem, /Headroom Memory provides project-scoped durable context/, "guidance follows actual normalized direct tool inventory in actual turn system sections");
  checks.push("exact already-loaded local model completes real MCP tool-call turn");
  const savings = statuses.find(item => item.name === "headroom-proxy" && /[1-9][0-9,]* saved/.test(item.value));
  assert.ok(savings, "real Pi context hook must compress explicit historical tool-output fixture, not merely bypass short context");
  assert.ok(!notices.some(message => /Compression request failed|safety fallback/i.test(message)));
  checks.push("real Pi context hook compresses explicit synthetic historical tool-output fixture over sealed managed transport: " + savings.value);
  const { STUDY_ENTRY_TYPE } = await jiti.import("../../src/study-mode.ts");
  await a.session.prompt("/wb:study-mode on");
  assert.ok(a.session.sessionManager.getBranch().some(entry => entry.type === "custom" && entry.customType === STUDY_ENTRY_TYPE && entry.data.enabled === true));
  await a.session.prompt("/wb:study-mode off");
  await a.session.prompt("/wb:code-graph off --confirm-delete");
  await wait(() => !named(a.session, "search_graph"), "owned tool removal"); assert.ok(named(b.session, "search_graph"));
  assert.ok((await tool(b.session, "list_projects", {})).content);
  checks.push("owned direct tool removal preserves active peer and busy data");
  await a.dispose(); assert.equal(await proxy.healthCheck(), true);
  const { cliAcceptance } = await import("./live-cli.mjs");
  checks.push(...await cliAcceptance({ cwd: join(home, "a"), extension, modelId, loaded, wait, search }));
  assert.match(JSON.stringify(await tool(b.session, "memory_search", { query: "violet_978163", top_k: 1 })), /violet_978163/);
  assert.equal(await proxy.healthCheck(), true, "separate CLI process exit preserves SDK peers");
  await b.session.prompt("/wb:headroom-proxy off"); assert.ok(named(b.session, "memory_search"));
  assert.equal(await proxy.healthCheck(), true, "different-workspace peer still consumes proxy");
  checks.push("session compression off/creator disposal preserve Memory and proxy peers");
  await b.dispose(); await c.dispose();
  await wait(async () => !await proxy.healthCheck(), "last consumer shutdown", 15000);
  checks.push("last real Pi consumers release owned proxy");
  console.log(JSON.stringify({ checks, directTools: { memory: search }, model: model.provider + "/" + model.id, sdk: true }, null, 2));
} finally { for (const runtime of runtimes.reverse()) await runtime.dispose().catch(() => {}); }
