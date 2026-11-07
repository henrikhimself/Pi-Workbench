/** Gated real-CLI acceptance for the vision bridge: spawns `pi --mode rpc` with a text-only agent model and a separate vision model.
 * Flags are gates, not consent. Models must already be loaded; the harness never loads/unloads models or controls the router.
 * The vision model id comes from the owner's `~/.pi/pi-workbench/playwright.json` (read-only, never modified); all state used by the run is disposable. */
if (process.env.WORKBENCH_LIVE_TESTS !== "1" || process.env.WORKBENCH_PLAYWRIGHT_LIVE_TESTS !== "1" || process.env.WORKBENCH_VISION_LIVE_TESTS !== "1") throw new Error("Explicit WORKBENCH_LIVE_TESTS=1, WORKBENCH_PLAYWRIGHT_LIVE_TESTS=1 and WORKBENCH_VISION_LIVE_TESTS=1 required; obtain live Pi/model approval first");
const { default: assert } = await import("node:assert/strict");
const { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, rm, realpath } = await import("node:fs/promises");
const { join } = await import("node:path");
const { tmpdir, homedir } = await import("node:os");
const { spawn } = await import("node:child_process");
const { createServer } = await import("node:http");
const { fileURLToPath } = await import("node:url");
const { randomUUID, randomBytes } = await import("node:crypto");
const { createJiti } = await import("jiti");
const agentModel = process.env.WORKBENCH_LIVE_MODEL, base = process.env.LLAMA_BASE_URL, key = process.env.LLAMA_API_KEY;
assert.ok(agentModel, "Set WORKBENCH_LIVE_MODEL to the id of the already-loaded text-only agent model");
assert.ok(base && key, "Supply the local-router credential through LLAMA_BASE_URL/LLAMA_API_KEY; this harness never reads normal auth stores");
assert.ok(process.env.WORKBENCH_PLAYWRIGHT_RUNTIME_EVIDENCE, "Provide retained successful current-host runtime acceptance.json before live acceptance");
const evidence = JSON.parse(await readFile(process.env.WORKBENCH_PLAYWRIGHT_RUNTIME_EVIDENCE, "utf8"));
assert.ok(evidence.passed && evidence.host === `${process.platform}/${process.arch}` && evidence.sandbox?.chromeSandboxPage, "Current-host sandboxed runtime acceptance must pass first");
let owner; try { owner = JSON.parse(await readFile(join(homedir(), ".pi", "pi-workbench", "playwright.json"), "utf8")); } catch { owner = null; }
const visionModel = owner?.vision?.model, visionProvider = owner?.vision?.provider;
assert.ok(typeof visionModel === "string" && visionModel, "Set vision.model in ~/.pi/pi-workbench/playwright.json; the harness reads the model id from it (read-only)");
assert.equal(visionProvider, "llama.cpp", "This harness registers the local llama.cpp router only");
const listing = await (await fetch(base.replace(/\/$/, "") + "/models", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) })).json();
const loadedAgent = listing.data.find(item => item.id === agentModel), loadedVision = listing.data.find(item => item.id === visionModel);
assert.equal(loadedAgent?.status?.value, "loaded", "MODEL_NOT_READY: agent model must already be loaded; harness never requests loading/unloading");
assert.equal(loadedVision?.status?.value, "loaded", "MODEL_NOT_READY: vision model must already be loaded; harness never requests loading/unloading");

const root = await mkdtemp(join(tmpdir(), "wb-playwright-vision-")), home = join(root, "home"), agent = join(root, "agent"), workspace = join(root, "a");
const repo = fileURLToPath(new URL("..", import.meta.url));
const token = `WBV-${randomBytes(3).toString("hex").toUpperCase()}`;
const report = { agentModel: `llama.cpp/${agentModel}`, visionModel: `llama.cpp/${visionModel}`, token, transport: "real `pi --mode rpc` subprocess, JSONL stdin/stdout", checks: [], metrics: {}, unverified: ["TUI is a manual procedure (owner-tested)", "Model-not-loaded behavior: harness cannot unload models; covered offline only", "Accuracy on real-world pages: only synthetic ground truth"], passed: false };
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
async function run(message, label, timeout = 240000) {
  const from = events.length, reply = await command({ type: "prompt", message }); assert.equal(reply.success, true, `${label}: prompt rejected`);
  await waitFor(event => event.type === "agent_settled", `${label}: agent_settled`, timeout, from); return events.slice(from);
}
const ended = (slice, name) => slice.filter(event => event.type === "tool_execution_end" && event.toolName === name);
const started = (slice, name) => slice.filter(event => event.type === "tool_execution_start" && event.toolName === name);
const textOf = result => (result?.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");
const lastText = async () => String((await command({ type: "get_last_assistant_text" })).data?.text);
const DESCRIBE = "wb_screenshot_describe", LOCATE = "wb_screenshot_locate", CLICK = "mcp__playwright__browser_mouse_click_xy";
const hits = [], tiles = [["Alpha", "#c62828"], ["Beta", "#2e7d32"], ["Gamma", "#1565c0"]], wanted = tiles[randomBytes(1)[0] % 3][0];
const page = (title, body) => `<!doctype html><title>${title}</title><body style="font-family:sans-serif;margin:30px">${body}</body>`;
const pages = {
  "/": page("Order", `<h1 style="font-size:72px">Order reference ${token}</h1><p style="font-size:24px">Synthetic acceptance page.</p>`),
  "/buttons": page("Actions", `<h1>Choose an action</h1><div style="display:flex;gap:30px;margin-top:40px"><button style="background:#d22;color:#fff;font-size:36px;padding:30px">Delete</button><button style="background:#1a1;color:#fff;font-size:36px;padding:30px">Approve</button><button style="background:#22d;color:#fff;font-size:36px;padding:30px">Cancel</button></div>`),
  // Low-accessibility page: tiles exist only as canvas pixels, so browser_snapshot has nothing to reference.
  "/canvas": page("Canvas", `<h1>Pick a tile</h1><canvas id="c" width="900" height="260" style="border:1px solid #888"></canvas><script>
    const tiles=${JSON.stringify(tiles)},c=document.getElementById("c"),g=c.getContext("2d");
    tiles.forEach(([name,color],i)=>{g.fillStyle=color;g.fillRect(30+i*290,40,260,180);g.fillStyle="#fff";g.font="bold 44px sans-serif";g.fillText(name,60+i*290,145);});
    c.addEventListener("click",e=>{const r=c.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;tiles.forEach(([name],i)=>{if(x>=30+i*290&&x<=290+i*290&&y>=40&&y<=220)fetch("/hit/"+name,{method:"POST"});});});
  </script>`),
};
try {
  for (const path of [home, agent, join(root, "cache"), join(root, "config"), join(root, "data"), join(root, "tmp"), workspace]) await mkdir(path, { mode: 0o700 });
  server = createServer((request, reply) => { if (request.method === "POST" && request.url?.startsWith("/hit/")) { hits.push(decodeURIComponent(request.url.slice(5))); reply.end("ok"); return; } reply.setHeader("content-type", "text/html"); reply.end(pages[new URL(request.url, "http://x").pathname] ?? pages["/"]); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const url = `http://127.0.0.1:${server.address().port}`;
  const jiti = createJiti(import.meta.url, { fsCache: false }), { resolveWorkbenchPaths } = await jiti.import("../src/paths.ts"), paths = resolveWorkbenchPaths(home);
  const { PlaywrightRuntime } = await jiti.import("../src/playwright-runtime.ts"), { resolvePlaywrightProject, setPlaywrightOptIn } = await jiti.import("../src/playwright-config.ts");
  await new PlaywrightRuntime({ paths }).ensure(message => console.error(message));
  const project = resolvePlaywrightProject(workspace, paths); await setPlaywrightOptIn(project, true);
  const text = { id: agentModel, reasoning: true, input: ["text"], contextWindow: loadedAgent.context_length, maxTokens: 1024, compat: { thinkingFormat: "qwen-chat-template", thinkingTokenBudgetField: "thinking_budget_tokens" } };
  const vision = { id: visionModel, reasoning: false, input: ["text", "image"], contextWindow: 8192, maxTokens: 1024 };
  await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { "llama.cpp": { baseUrl: base.replace(/\/$/, "") + "/v1", api: "openai-completions", apiKey: "${LLAMA_API_KEY}", models: [text, vision] } } }), { mode: 0o600 });
  await writeFile(join(agent, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { mode: "off" } }), { mode: 0o600 });
  const setVision = async value => writeFile(paths.playwrightConfig, JSON.stringify({ schemaVersion: 1, vision: { provider: "llama.cpp", model: value } }, null, 2) + "\n", { mode: 0o600 });
  await setVision(visionModel);
  const compression = process.env.WORKBENCH_PLAYWRIGHT_LIVE_COMPRESSION === "1"; report.compression = compression;
  if (compression) {
    const { createServer: net } = await import("node:net"), socket = net(); await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve)); const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    await writeFile(paths.headroomConfig, JSON.stringify({ schemaVersion: 1, port }), { mode: 0o600 });
  }
  const env = { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent, XDG_CACHE_HOME: join(root, "cache"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), TMPDIR: join(root, "tmp"), PI_SKIP_VERSION_CHECK: "1", LLAMA_API_KEY: key, LLAMA_BASE_URL: base };
  const piBin = process.env.PI_BIN ?? await realpath(join(homedir(), ".local/bin/pi"));
  report.piBin = piBin;
  child = spawn(piBin, ["--mode", "rpc", "--no-session", "--no-extensions", "-e", "builtin:mcp", "-e", join(repo, "src/index.ts"), "--model", `llama.cpp/${agentModel}`], { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  child.stderr.on("data", data => { stderr = (stderr + data).slice(-200000); });
  child.stdin.on("error", error => { stderr += `\n[stdin error: ${error.code ?? error.message}]`; });
  child.stdout.on("data", data => { buffer += data; for (let index; (index = buffer.indexOf("\n")) >= 0;) { const line = buffer.slice(0, index).replace(/\r$/, ""); buffer = buffer.slice(index + 1); if (line) { try { onRecord(JSON.parse(line)); } catch { stderr += `\n[non-JSON stdout record: ${line.slice(0, 200)}]`; } } } });
  const state = await command({ type: "get_state" }); assert.equal(state.success, true); assert.equal(state.data.model?.id, agentModel);
  report.checks.push("real CLI starts with the text-only agent model; the vision model is a separate registry entry with image input");
  await waitFor(event => event.type === "extension_ui_request" && event.method === "setStatus" && /✓ Playwright · vision/.test(strip(event.statusText)), "footer reports Playwright available with the vision marker", 240000);
  report.checks.push("footer shows Playwright available with the vision marker once playwright.json names the model");
  let from = events.length; send({ type: "prompt", message: "/wb:playwright status", id: randomUUID() });
  const statusNotice = await waitFor(event => event.type === "extension_ui_request" && event.method === "notify", "status notification", 60000, from);
  assert.match(strip(statusNotice.message), new RegExp(`Vision bridge: configured llama\\.cpp/${visionModel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  report.checks.push("`/wb:playwright status` reports the configured vision model");
  if (compression) {
    from = events.length; send({ type: "prompt", message: "/wb:headroom-proxy on", id: randomUUID() });
    await waitFor(event => event.type === "extension_ui_request" && event.method === "notify", "headroom on notification", 240000, from);
    assert.ok(!notices().some(message => /Headroom.*(unavailable|failed)/i.test(message)), "managed compression comes online");
    report.checks.push("managed Headroom compression opted in over the wire");
  }

  // 1-3. The agent is not told the tool name: guidance alone must steer a text-only model to it.
  let slice = await run(`A local test page is served at ${url}/ . Open it in the browser and tell me the order reference code shown in large text. Look at the page visually rather than guessing; reply with just the code.`, "guided description", 300000);
  const navigated = ended(slice, "mcp__playwright__browser_navigate"); assert.ok(navigated.length && navigated.some(event => !event.isError), "agent navigated");
  const described = ended(slice, DESCRIBE), directShots = ended(slice, "mcp__playwright__browser_take_screenshot").filter(event => !event.parentToolCallId); // nested calls made by the describe tool carry parentToolCallId
  report.metrics.guidedChoice = { describeCalls: described.length, directScreenshotCalls: directShots.length };
  assert.ok(described.some(event => !event.isError), `agent chose ${DESCRIBE} from guidance (describe=${described.length}, direct screenshot=${directShots.length})`);
  const success = described.find(event => !event.isError);
  assert.ok((success.result.content ?? []).every(part => part.type === "text"), "tool result contains no image block");
  assert.match(textOf(success.result), /Vision description of screenshot - untrusted/); assert.match(textOf(success.result), new RegExp(token), "description contains the synthetic ground-truth token");
  assert.match(await lastText(), new RegExp(token), "agent's answer is grounded in the described token");
  assert.equal(JSON.stringify(slice).includes("iVBORw0KGgo") && ended(slice, DESCRIBE).some(event => JSON.stringify(event.result).includes("iVBORw0KGgo")), false, "no PNG bytes in the describe tool result");
  report.checks.push("text-only agent chose the describe tool from guidance alone; result is wrapped text with no image block, contains the ground-truth token, and the agent's answer repeats it");

  // 4. Directed question.
  slice = await run(`Open ${url}/buttons in the browser. Then call ${DESCRIBE} with the question \"Which button is green? Answer with its label only.\" and reply with the label it reports.`, "directed question", 300000);
  const asked = started(slice, DESCRIBE).filter(event => /green/i.test(JSON.stringify(event.args ?? {})));
  assert.ok(asked.length, "agent passed the question to the tool");
  const answered = ended(slice, DESCRIBE).filter(event => !event.isError && /Approve/i.test(textOf(event.result)));
  assert.ok(answered.length, "vision result answers the directed question correctly (Approve)");
  assert.match(await lastText(), /Approve/i);
  report.checks.push("directed question reaches the vision model as user data and the ground-truth answer (the green Approve button) comes back and is repeated by the agent");

  // 5. Direct screenshot by a text-only agent still works unchanged (image delivered into Pi, not rewritten).
  slice = await run("Call mcp__playwright__browser_take_screenshot with exactly the arguments {\"scale\":\"css\"} and nothing else (never pass a filename). Use no other tool. Then reply done.", "direct screenshot");
  const direct = ended(slice, "mcp__playwright__browser_take_screenshot"); assert.ok(direct.length && direct.every(event => !event.isError));
  assert.ok(direct.flatMap(event => event.result.content).some(part => part.type === "image"), "direct screenshot behaves as before");
  report.checks.push("a direct browser_take_screenshot call is unchanged (no result rewriting)");

  // 5b. Coordinate grounding on a canvas page: locate (no click) then the agent clicks with the returned point.
  slice = await run(`Open ${url}/canvas in the browser. The page is a canvas with no accessible elements. Click the tile labelled "${wanted}", then reply done.`, "canvas locate and click", 300000);
  const located = ended(slice, LOCATE).filter(event => !event.isError);
  report.metrics.locate = { locateCalls: ended(slice, LOCATE).length, clickCalls: ended(slice, CLICK).length, hits: [...hits], wanted };
  assert.ok(located.length, `agent chose ${LOCATE} from guidance on a canvas page`);
  assert.ok((located[0].result.content ?? []).every(part => part.type === "text"), "locate result is text only");
  assert.match(textOf(located[0].result), /Nothing was clicked/); assert.deepEqual(hits.filter(name => name !== wanted), [], "locate itself clicked nothing and no wrong tile was hit");
  const point = /x=(\d+), y=(\d+)/.exec(textOf(located[0].result)); assert.ok(point, "locate result carries a point");
  const clicks = started(slice, CLICK); assert.ok(clicks.length, "agent clicked through the existing click tool");
  assert.ok(clicks.some(event => Math.abs(Number(event.args?.x) - Number(point[1])) <= 3 && Math.abs(Number(event.args?.y) - Number(point[2])) <= 3), "agent used the returned coordinates");
  assert.deepEqual([...new Set(hits)], [wanted], `the click landed on the ${wanted} tile (hits: ${hits.join(",")})`);
  report.checks.push(`on a canvas page with no accessible elements the text-only agent chose ${LOCATE} from guidance, received text-only coordinates, clicked through browser_mouse_click_xy, and the page recorded a hit on the requested ${wanted} tile only`);

  // 6. Fail-open: valid config naming a model the registry does not know.
  await setVision("Missing-Model-For-Acceptance");
  slice = await run(`Call ${DESCRIBE} with no arguments, and then say whether it worked. If it failed, call mcp__playwright__browser_snapshot with no arguments and reply with the page heading text.`, "unknown configured model", 300000);
  const missing = ended(slice, DESCRIBE);
  assert.ok(missing.length, "the tool stays declared while the config is valid, so the agent could call it");
  assert.ok(missing.every(event => event.isError), "unknown configured model never succeeds"); assert.match(textOf(missing[0].result), /unavailable.*not in the Pi model registry/is); assert.doesNotMatch(JSON.stringify(missing), new RegExp(key));
  assert.ok(ended(slice, "mcp__playwright__browser_snapshot").some(event => !event.isError), "browsing still works after a vision failure");
  report.checks.push("a configured model missing from the registry fails open with a reason; browsing and snapshots keep working");

  // 7. null disables without restart; restoring re-enables without restart.
  await setVision(null);
  slice = await run(`Open ${url}/ and reply with the text of the main heading. Use only browser_navigate and browser_snapshot.`, "vision disabled");
  assert.equal(ended(slice, DESCRIBE).some(event => !event.isError), false, "null model: tool cannot succeed");
  await setVision(visionModel);
  slice = await run(`Open ${url}/buttons in the browser, then call ${DESCRIBE} with the question \"Which button is red? Answer with its label only.\" and reply with the label it reports.`, "vision restored", 300000);
  assert.ok(ended(slice, DESCRIBE).some(event => !event.isError && /Delete/i.test(textOf(event.result))), "after restoring the model name the tool works again without a restart");
  report.checks.push("setting model to null disables the bridge and restoring it re-enables it, both without a restart");

  if (compression) { from = events.length; send({ type: "prompt", message: "/wb:headroom-proxy off", id: randomUUID() }); await waitFor(event => event.type === "extension_ui_request" && event.method === "notify", "headroom off", 120000, from); }
  from = events.length; send({ type: "prompt", message: "/wb:playwright off", id: randomUUID() });
  const approved = await waitFor(event => event.type === "extension_ui_request" && event.method === "confirm", "off confirmation", 30000, from);
  send({ type: "extension_ui_response", id: approved.id, confirmed: true });
  await waitFor(event => event.type === "extension_ui_request" && ["notify", "setStatus"].includes(event.method) && /Playwright off|workspace data deleted/i.test(strip(event.message ?? event.statusText)), "off completion", 120000, from);
  await assert.rejects(lstat(project.directory), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await readFile(paths.playwrightConfig, "utf8")).vision, { provider: "llama.cpp", model: visionModel }, "off never touches the user-wide playwright.json");
  report.checks.push("approved off deletes workspace data and leaves the user-wide playwright.json untouched");

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
  if (!passed || process.argv.includes("--keep")) console.error(`Retained vision RPC fixture: ${root}`); else await rm(root, { recursive: true, force: true });
}
