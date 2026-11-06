/** Authorized local-model acceptance. Never loads/unloads/reconfigures router. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createServer } from "node:net";
import { fork, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
if (process.env.WORKBENCH_LIVE_TESTS !== "1") throw new Error("Set WORKBENCH_LIVE_TESTS=1 for isolated exact-local-model acceptance");
const modelId = "Ornith-1.5-35B-A3B-q5-mtp0";
const home = await mkdtemp(join(tmpdir(), "wl-")), userHome = join(home, "h"), agent = join(home, "agent");
const jiti = createJiti(import.meta.url), run = promisify(execFile);
const { resolveWorkbenchPaths } = await jiti.import("../src/paths.ts");
const { ManagedHeadroomRuntime } = await jiti.import("../src/headroom-runtime.ts");
const { MemoryManager } = await jiti.import("../src/memory-manager.ts");
const { CodeGraphInstaller } = await jiti.import("../src/code-graph-installer.ts");
const { CodeGraphManager } = await jiti.import("../src/code-graph-manager.ts");
const { resolveCodeGraphProject } = await jiti.import("../src/code-graph-config.ts");
const paths = resolveWorkbenchPaths(userHome), report = { home, model: "llama.cpp/" + modelId, checks: [] };
let child, completed = false;
try {
  // Read only the selected provider credential. Never print/copy auth store.
  let auth;
  if (!process.env.LLAMA_BASE_URL || !process.env.LLAMA_API_KEY) {
    try { auth = JSON.parse(await readFile(process.env.WORKBENCH_AUTH_PATH ?? join(homedir(), ".pi", "agent", "auth.json"), "utf8"))["llama.cpp"]; }
    catch { throw new Error("Cannot read selected local-provider credential; use LLAMA_BASE_URL and LLAMA_API_KEY"); }
  }
  const base = process.env.LLAMA_BASE_URL ?? auth?.env?.LLAMA_BASE_URL;
  const key = process.env.LLAMA_API_KEY ?? auth?.key;
  assert.ok(base && key, "Exact local router credential/base unavailable");
  const target = new URL(base);
  assert.ok(target.origin === "http://192.168.2.48:8000" && target.pathname === "/" && !target.username && !target.password && !target.search && !target.hash,
    "Only explicitly authorized local router origin without URL credentials is permitted");
  const status = await fetch(base.replace(/\/$/, "") + "/models", { headers: { Authorization: "Bearer " + key }, signal: AbortSignal.timeout(10000) });
  assert.equal(status.status, 200); const listing = await status.json(); const loaded = listing.data.find(model => model.id === modelId);
  assert.equal(loaded?.status?.value, "loaded", "MODEL_NOT_READY: user must load exact model; inference may not autoload it");
  for (const dir of [userHome, agent, paths.root]) await mkdir(dir, { recursive: true, mode: 0o700 });
  const listener = createServer(); await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  await writeFile(paths.headroomConfig, JSON.stringify({ schemaVersion: 1, port, memoryNamespace: "fixture", compression: { mode: "lossless_then_lossy", protectAnalysisContext: true, protectRecent: 3 } }));
  const definition = { id: modelId, reasoning: true, input: ["text"], contextWindow: loaded.context_length, maxTokens: 512,
    compat: { thinkingFormat: "qwen-chat-template", thinkingTokenBudgetField: "thinking_budget_tokens" } };
  await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { "llama.cpp": { baseUrl: base.replace(/\/$/, "") + "/v1", api: "openai-completions", apiKey: "${LLAMA_API_KEY}", models: [definition] } } }));
  await writeFile(join(agent, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { mode: "off" } }));
  const runtime = new ManagedHeadroomRuntime({ paths }); assert.ok(await runtime.ensure(message => console.error(message)));
  const installer = new CodeGraphInstaller({ paths });
  const { resolveCompressionProject, setCompressionOptIn } = await jiti.import("../src/headroom-project.ts");
  for (const name of ["a", "b"]) {
    const cwd = join(home, name); await mkdir(cwd); await run("git", ["init", "--quiet"], { cwd });
    await writeFile(join(cwd, "fixture.ts"), "export function liveSentinel() { return 978163; }\n");
    await setCompressionOptIn(resolveCompressionProject(cwd, paths), true);
    const memory = new MemoryManager({ cwd, defaultRoot: paths.headroomMemory, runtime, userId: "fixture" });
    assert.ok(await memory.prepare(message => console.error(message))); await memory.createStore();
    const graph = new CodeGraphManager({ paths, ensureInstalled: cb => installer.ensureInstalled(cb), registerMcp: () => {}, unregisterMcp: () => {} });
    const project = resolveCodeGraphProject(cwd, paths); const activated = await graph.activate(project); assert.equal(activated.ok, true, activated.detail); await graph.shutdown();
    if (name === "a") { const state = JSON.parse(await readFile(project.statePath, "utf8")); state.version = "v0.8.1"; state.resolvedUrl = "https://fixture.invalid/controlled-old-identity"; state.sha256 = "a".repeat(64); await writeFile(project.statePath, JSON.stringify(state)); }
  }
  // Do not share real Pi agent resources or paid provider credentials with worker.
  const env = { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: userHome, USERPROFILE: userHome,
    PI_CODING_AGENT_DIR: agent, PI_SKIP_VERSION_CHECK: "1", LLAMA_API_KEY: key, LLAMA_BASE_URL: base, WORKBENCH_LIVE_TESTS: "1",
    WB_LIVE_HOME: home, WB_LIVE_AGENT: agent, WB_LIVE_PORT: String(port), WB_LIVE_MODEL: modelId };
  child = fork(fileURLToPath(new URL("./helpers/live-pi-worker.mjs", import.meta.url)), [], { cwd: home, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let output = "", errors = ""; child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { errors = (errors + data).slice(-20000); });
  const deadline = setTimeout(() => child.kill("SIGTERM"), 300000);
  const code = await new Promise(resolve => child.once("exit", resolve)); clearTimeout(deadline);
  errors = errors.replaceAll(key, "[REDACTED]");
  await writeFile(join(home, "worker.log"), errors, { mode: 0o600 });
  assert.equal(code, 0, errors);
  Object.assign(report, JSON.parse(output)); completed = true;
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  if (!completed || process.argv.includes("--keep")) console.error(`Retained live fixture: ${home}`);
  else await rm(home, { recursive: true, force: true });
}
