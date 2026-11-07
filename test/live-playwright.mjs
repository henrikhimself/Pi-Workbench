/** Unapproved until product-owner authorizes exact model/modes. Flags are gates, not consent. */
if (process.env.WORKBENCH_LIVE_TESTS !== "1" || process.env.WORKBENCH_PLAYWRIGHT_LIVE_TESTS !== "1") throw new Error("Explicit WORKBENCH_LIVE_TESTS=1 and WORKBENCH_PLAYWRIGHT_LIVE_TESTS=1 required; obtain live Pi/model approval first");
const { default: assert } = await import("node:assert/strict");
const { mkdtemp, mkdir, writeFile, readFile, rm } = await import("node:fs/promises");
const { join } = await import("node:path");
const { tmpdir } = await import("node:os");
const { fork } = await import("node:child_process");
const { fileURLToPath } = await import("node:url");
const { createServer } = await import("node:net");
const { createJiti } = await import("jiti");
const modelId = process.env.WORKBENCH_LIVE_MODEL, base = process.env.LLAMA_BASE_URL, key = process.env.LLAMA_API_KEY;
assert.ok(modelId, "Set WORKBENCH_LIVE_MODEL to the id of the already-loaded model to test");
assert.ok(base && key, "Supply selected local-router credential through LLAMA_BASE_URL/LLAMA_API_KEY; this harness never reads normal auth stores");
assert.ok(process.env.WORKBENCH_PLAYWRIGHT_RUNTIME_EVIDENCE, "Provide retained successful current-host runtime acceptance.json before live acceptance");
const evidence = JSON.parse(await readFile(process.env.WORKBENCH_PLAYWRIGHT_RUNTIME_EVIDENCE, "utf8"));
assert.ok(evidence.passed && evidence.host === `${process.platform}/${process.arch}` && evidence.sandbox?.chromeSandboxPage, "Current-host sandboxed runtime acceptance must pass first");
const response = await fetch(base.replace(/\/$/, "") + "/models", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
assert.equal(response.status, 200); const listing = await response.json(), loaded = listing.data.find(item => item.id === modelId);
assert.equal(loaded?.status?.value, "loaded", "MODEL_NOT_READY: user must load exact model; harness never requests loading/unloading");
const root = await mkdtemp(join(tmpdir(), "wb-playwright-live-")), home = join(root, "home"), agent = join(root, "agent");
let child, passed = false;
try {
  for (const path of [home, agent, join(root, "cache"), join(root, "config"), join(root, "data"), join(root, "tmp"), join(root, "a"), join(root, "b")]) await mkdir(path, { mode: 0o700 });
  const jiti = createJiti(import.meta.url, { fsCache: false }), { resolveWorkbenchPaths } = await jiti.import("../src/paths.ts"), paths = resolveWorkbenchPaths(home);
  const { PlaywrightRuntime } = await jiti.import("../src/playwright-runtime.ts"), { resolvePlaywrightProject, setPlaywrightOptIn } = await jiti.import("../src/playwright-config.ts");
  await new PlaywrightRuntime({ paths }).ensure(message => console.error(message));
  for (const name of ["a", "b"]) await setPlaywrightOptIn(resolvePlaywrightProject(join(root, name), paths), true);
  const definition = { id: modelId, reasoning: true, input: ["text"], contextWindow: loaded.context_length, maxTokens: 1024, compat: { thinkingFormat: "qwen-chat-template", thinkingTokenBudgetField: "thinking_budget_tokens" } };
  await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { "llama.cpp": { baseUrl: base.replace(/\/$/, "") + "/v1", api: "openai-completions", apiKey: "${LLAMA_API_KEY}", models: [definition] } } }), { mode: 0o600 });
  await writeFile(join(agent, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { mode: "off" } }), { mode: 0o600 });
  if (process.env.WORKBENCH_PLAYWRIGHT_LIVE_COMPRESSION === "1") {
    const socket = createServer(); await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve)); const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    await writeFile(paths.headroomConfig, JSON.stringify({ schemaVersion: 1, port }), { mode: 0o600 });
  }
  const env = { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent,
    XDG_CACHE_HOME: join(root, "cache"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), TMPDIR: join(root, "tmp"),
    PI_SKIP_VERSION_CHECK: "1", LLAMA_API_KEY: key, LLAMA_BASE_URL: base, WORKBENCH_LIVE_TESTS: "1", WORKBENCH_PLAYWRIGHT_LIVE_TESTS: "1",
    WORKBENCH_PLAYWRIGHT_LIVE_COMPRESSION: process.env.WORKBENCH_PLAYWRIGHT_LIVE_COMPRESSION === "1" ? "1" : "", WB_PLAYWRIGHT_LIVE_ROOT: root, WB_PLAYWRIGHT_MODEL: modelId };
  child = fork(fileURLToPath(new URL("./helpers/live-playwright-worker.mjs", import.meta.url)), [], { cwd: root, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let output = "", errors = ""; child.stdout.on("data", data => { output = (output + data).slice(-200000); }); child.stderr.on("data", data => { errors = (errors + data).slice(-200000); });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 600000); const code = await new Promise(resolve => child.once("exit", resolve)); clearTimeout(timeout);
  await writeFile(join(root, "worker.log"), errors.replaceAll(key, "[REDACTED]"), { mode: 0o600 });
  assert.equal(code, 0, "Live worker failed; inspect retained redacted worker.log");
  const report = JSON.parse(output); await writeFile(join(root, "acceptance.json"), JSON.stringify(report, null, 2), { mode: 0o600 }); console.log(JSON.stringify(report, null, 2)); passed = true;
} finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  if (!passed || process.argv.includes("--keep")) console.error(`Retained Playwright live fixture: ${root}`); else await rm(root, { recursive: true, force: true });
}
