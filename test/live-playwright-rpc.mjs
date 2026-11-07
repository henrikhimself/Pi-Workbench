/** Gated real-CLI wire acceptance: spawns `pi --mode rpc` and speaks JSONL. Flags are gates, not consent. */
if (process.env.WORKBENCH_LIVE_TESTS !== "1" || process.env.WORKBENCH_PLAYWRIGHT_LIVE_TESTS !== "1") throw new Error("Explicit WORKBENCH_LIVE_TESTS=1 and WORKBENCH_PLAYWRIGHT_LIVE_TESTS=1 required; obtain live Pi/model approval first");
const { default: assert } = await import("node:assert/strict");
const { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, rm, realpath } = await import("node:fs/promises");
const { join } = await import("node:path");
const { tmpdir, homedir } = await import("node:os");
const { spawn } = await import("node:child_process");
const { createServer } = await import("node:http");
const { fileURLToPath } = await import("node:url");
const { randomUUID } = await import("node:crypto");
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

const root = await mkdtemp(join(tmpdir(), "wb-playwright-rpc-")), home = join(root, "home"), agent = join(root, "agent"), workspace = join(root, "a");
const repo = fileURLToPath(new URL("..", import.meta.url));
const report = { model: `llama.cpp/${modelId}`, transport: "real `pi --mode rpc` subprocess, JSONL stdin/stdout", checks: [], unverified: ["Provider/model image input and visual interpretation: authorized fixture model is text-only", "TUI is a manual procedure (owner-tested)"], passed: false };
let child, server, passed = false, stderr = "";
const events = [], waiters = [], pending = new Map(); let buffer = "";
const strip = text => String(text ?? "").replace(/\u001b\[[0-9;]*m/g, "");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function send(record) { if (child.exitCode !== null || child.stdin.destroyed) throw new Error(`pi exited (code ${child.exitCode}) before ${record.type}; see rpc-stderr.log`); child.stdin.write(JSON.stringify(record) + "\n"); }
function command(record, timeout = 30000) {
  const id = randomUUID(); send({ ...record, id });
  return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`No response to ${record.type}`)), timeout); pending.set(id, value => { clearTimeout(timer); resolve(value); }); });
}
function onRecord(record) {
  if (record.type === "response" && pending.has(record.id)) { pending.get(record.id)(record); pending.delete(record.id); return; }
  events.push(record); for (const waiter of [...waiters]) if (waiter.test(record)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(record); }
}
function waitFor(test, label, timeout = 120000, from = 0) {
  const found = events.slice(from).find(test); if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => { const waiter = { test, resolve: value => { clearTimeout(timer); resolve(value); } }; const timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error(`Timed out: ${label}`)); }, timeout); waiters.push(waiter); });
}
const statusText = () => events.filter(event => event.type === "extension_ui_request" && event.method === "setStatus").map(event => strip(event.statusText));
const notices = () => events.filter(event => event.type === "extension_ui_request" && event.method === "notify").map(event => strip(event.message));
async function run(message, label, timeout = 180000) {
  const from = events.length, reply = await command({ type: "prompt", message }); assert.equal(reply.success, true, `${label}: prompt rejected`);
  await waitFor(event => event.type === "agent_settled", `${label}: agent_settled`, timeout, from); return events.slice(from);
}
const tool = (slice, name) => slice.filter(event => event.type === "tool_execution_end" && event.toolName === `mcp__playwright__${name}`);
try {
  for (const path of [home, agent, join(root, "cache"), join(root, "config"), join(root, "data"), join(root, "tmp"), workspace]) await mkdir(path, { mode: 0o700 });
  server = createServer((_request, reply) => { reply.setHeader("content-type", "text/html"); reply.end("<!doctype html><title>Synthetic live</title><h1>WB_LIVE_PAGE</h1><p>Only synthetic acceptance content.</p><button onclick=\"document.querySelector('#r').textContent='WB_CLICKED_OK'\">Go</button><p id=\"r\"></p>"); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const url = `http://127.0.0.1:${server.address().port}/`;
  const jiti = createJiti(import.meta.url, { fsCache: false }), { resolveWorkbenchPaths } = await jiti.import("../src/paths.ts"), paths = resolveWorkbenchPaths(home);
  const { PlaywrightRuntime } = await jiti.import("../src/playwright-runtime.ts"), { resolvePlaywrightProject, setPlaywrightOptIn } = await jiti.import("../src/playwright-config.ts");
  await new PlaywrightRuntime({ paths }).ensure(message => console.error(message));
  const project = resolvePlaywrightProject(workspace, paths); await setPlaywrightOptIn(project, true);
  const definition = { id: modelId, reasoning: true, input: ["text"], contextWindow: loaded.context_length, maxTokens: 1024, compat: { thinkingFormat: "qwen-chat-template", thinkingTokenBudgetField: "thinking_budget_tokens" } };
  await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { "llama.cpp": { baseUrl: base.replace(/\/$/, "") + "/v1", api: "openai-completions", apiKey: "${LLAMA_API_KEY}", models: [definition] } } }), { mode: 0o600 });
  await writeFile(join(agent, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { mode: "off" } }), { mode: 0o600 });
  const compression = process.env.WORKBENCH_PLAYWRIGHT_LIVE_COMPRESSION === "1"; report.compression = compression;
  if (compression) {
    const { createServer: net } = await import("node:net"), socket = net(); await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve)); const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    await writeFile(paths.headroomConfig, JSON.stringify({ schemaVersion: 1, port }), { mode: 0o600 });
  }
  const env = { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent, XDG_CACHE_HOME: join(root, "cache"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), TMPDIR: join(root, "tmp"), PI_SKIP_VERSION_CHECK: "1", LLAMA_API_KEY: key, LLAMA_BASE_URL: base };
  // The `pi` on PATH may be a HOME-relative shell wrapper that cannot run under the disposable HOME; run the real CLI entry directly. Override with PI_BIN.
  const piBin = process.env.PI_BIN ?? await realpath(join(homedir(), ".local/bin/pi"));
  report.piBin = piBin;
  child = spawn(piBin, ["--mode", "rpc", "--no-session", "--no-extensions", "-e", "builtin:mcp", "-e", join(repo, "src/index.ts"), "--model", `llama.cpp/${modelId}`], { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  child.stderr.on("data", data => { stderr = (stderr + data).slice(-200000); });
  child.stdin.on("error", error => { stderr += `\n[stdin error: ${error.code ?? error.message}]`; });
  child.stdout.on("data", data => { buffer += data; for (let index; (index = buffer.indexOf("\n")) >= 0;) { const line = buffer.slice(0, index).replace(/\r$/, ""); buffer = buffer.slice(index + 1); if (line) { try { onRecord(JSON.parse(line)); } catch { stderr += `\n[non-JSON stdout record: ${line.slice(0, 200)}]`; } } } });
  const state = await command({ type: "get_state" }); assert.equal(state.success, true); assert.equal(state.data.model?.id, modelId);
  report.checks.push("real CLI starts in RPC mode with `-e builtin:mcp` and the selected model; get_state answers over JSONL");
  await waitFor(event => event.type === "extension_ui_request" && event.method === "setStatus" && /✓ Playwright/.test(strip(event.statusText)), "footer reports Playwright available", 240000);
  report.checks.push("Playwright footer availability delivered as an extension_ui_request setStatus record");

  let from = events.length; send({ type: "prompt", message: "/wb:playwright status", id: randomUUID() });
  const statusNotice = await waitFor(event => event.type === "extension_ui_request" && event.method === "notify", "status notification", 60000, from);
  report.statusNotice = strip(statusNotice.message).slice(0, 600); assert.ok(report.statusNotice.length > 0 && !/failed|unavailable/i.test(report.statusNotice), "status reports a healthy managed feature");
  from = events.length; send({ type: "prompt", message: "/wb:playwright on", id: randomUUID() });
  await waitFor(event => event.type === "extension_ui_request" && event.method === "notify", "idempotent on notification", 60000, from);
  assert.ok(!notices().slice(-1)[0].match(/failed|unavailable/i), "repeat on is not an error");
  report.checks.push("`/wb:playwright status` and idempotent `on` answer over the wire without disturbing the session");
  if (compression) {
    from = events.length; send({ type: "prompt", message: "/wb:headroom-proxy on", id: randomUUID() });
    await waitFor(event => event.type === "extension_ui_request" && event.method === "notify", "headroom on notification", 240000, from);
    assert.ok(!notices().slice(from > 0 ? 0 : 0).some(text => /Headroom.*(unavailable|failed)/i.test(text)), "managed compression comes online");
    report.checks.push("managed Headroom compression opted in over the wire");
  }
  let slice = await run(`The page url is ${JSON.stringify(url)}. Step 1: call mcp__playwright__browser_navigate with that url. Step 2: call mcp__playwright__browser_snapshot with no arguments; its result contains the page structure inline. Step 3: reply with the text of the page heading. Do both tool calls before replying and use no other tool. The URL is a real local test page served on this machine; the tools are real and return real page content.`, "navigate+snapshot");
  const navigate = tool(slice, "browser_navigate"), snapshot = tool(slice, "browser_snapshot");
  assert.ok(navigate.length && navigate.every(event => !event.isError), "navigate executed without error"); assert.ok(snapshot.length && snapshot.every(event => !event.isError));
  assert.match(JSON.stringify(snapshot[0].result), /WB_LIVE_PAGE/);
  const answer = await command({ type: "get_last_assistant_text" }); assert.match(String(answer.data?.text), /WB_LIVE_PAGE/);
  report.checks.push("model calls direct MCP tools over the wire; snapshot result and the model's answer contain the synthetic page heading");

  slice = await run("Call mcp__playwright__browser_take_screenshot with exactly the arguments {\"scale\":\"css\"} and nothing else (never pass a filename: a filename returns only a link, and this step checks inline image delivery). Use no other tool. Then reply done.", "screenshot");
  const shots = tool(slice, "browser_take_screenshot"); assert.ok(shots.length && shots.every(event => !event.isError));
  const png = shots.flatMap(event => event.result.content).filter(part => part.type === "image" && part.mimeType === "image/png");
  assert.ok(png.length && Buffer.from(png[0].data, "base64").subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  report.checks.push("screenshot PNG delivered in the wire tool_execution_end record (delivery only; model is text-only)");

  slice = await run("Step 1: call mcp__playwright__browser_snapshot with no arguments and find the button named Go. Step 2: call mcp__playwright__browser_click with the target ref of that button from the snapshot. Step 3: call mcp__playwright__browser_snapshot again with no arguments (never pass a filename). Step 4: reply with the exact text that appeared on the page after the click. Use no other tool.", "click interaction");
  assert.ok(tool(slice, "browser_click").some(event => !event.isError), "at least one click executed successfully (the model may retry a bad ref; the sentinel below proves the click took effect)");
  assert.match(String((await command({ type: "get_last_assistant_text" })).data?.text), /WB_CLICKED_OK/);
  report.checks.push(`real form interaction through the model (${compression ? "compression on" : "compression off"}): the model's answer contains the sentinel that exists only after a real click`);

  slice = await run("Call mcp__playwright__browser_run_code_unsafe with code \"() => 1\". If the tool does not exist, say unavailable.", "unsafe tool");
  assert.equal(slice.some(event => event.type === "tool_execution_end" && event.toolName === "mcp__playwright__browser_run_code_unsafe" && !event.isError), false);
  report.checks.push("unsafe server code never succeeds through the real CLI");

  if (compression) { from = events.length; send({ type: "prompt", message: "/wb:headroom-proxy off", id: randomUUID() }); await waitFor(event => event.type === "extension_ui_request" && event.method === "notify", "headroom off", 120000, from); }
  const beforeCancel = statusText().length; from = events.length;
  send({ type: "prompt", message: "/wb:playwright off", id: randomUUID() });
  const refused = await waitFor(event => event.type === "extension_ui_request" && event.method === "confirm", "off confirmation dialog", 30000, from);
  send({ type: "extension_ui_response", id: refused.id, confirmed: false }); await sleep(3000);
  assert.equal(statusText().slice(beforeCancel).some(text => /Playwright off/.test(text)), false, "refusal must leave Playwright running");
  assert.ok(await lstat(project.directory), "workspace data retained after refusal");
  report.checks.push("off confirmation arrives as a wire confirm request; refusal retains the running session and data");

  from = events.length; send({ type: "prompt", message: "/wb:playwright off", id: randomUUID() });
  const approved = await waitFor(event => event.type === "extension_ui_request" && event.method === "confirm", "second off confirmation", 30000, from);
  send({ type: "extension_ui_response", id: approved.id, confirmed: true });
  await waitFor(event => event.type === "extension_ui_request" && ["notify", "setStatus"].includes(event.method) && /Playwright off|workspace data deleted/i.test(strip(event.message ?? event.statusText)), "off completion", 120000, from);
  await assert.rejects(lstat(project.directory), { code: "ENOENT" });
  report.checks.push("approved off deletes this workspace's data and reports completion over the wire");

  child.stdin.end(); const result = await Promise.race([exited, sleep(30000).then(() => "timeout")]); assert.notEqual(result, "timeout", "pi exits when stdin closes");
  const leaked = []; for (const pid of (await readdir("/proc")).filter(name => /^\d+$/.test(name))) { try { if ((await readFile(`/proc/${pid}/cmdline`, "utf8")).includes(root)) leaked.push(pid); } catch { /* process ended */ } }
  assert.deepEqual(leaked, [], "no process whose command line references the disposable root remains");
  report.checks.push("stdin EOF ends the real CLI and leaves no process referencing the disposable root");
  report.passed = true; passed = true; console.log(JSON.stringify(report, null, 2));
} finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await writeFile(join(root, "rpc-stderr.log"), stderr.replaceAll(key, "[REDACTED]"), { mode: 0o600 }).catch(() => {});
  await writeFile(join(root, "rpc-events.json"), JSON.stringify(events.filter(event => event.type !== "message_update").slice(-1500)).replaceAll(key, "[REDACTED]"), { mode: 0o600 }).catch(() => {});
  if (!passed || process.argv.includes("--keep")) console.error(`Retained Playwright RPC fixture: ${root}`); else await rm(root, { recursive: true, force: true });
}
