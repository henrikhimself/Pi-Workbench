/** Explicit isolated real-browser acceptance. No Pi/model, normal stores, profiles, or OS changes. */
if (process.env.WORKBENCH_RUNTIME_TESTS !== "1") throw new Error("Set WORKBENCH_RUNTIME_TESTS=1 to authorize isolated Playwright provisioning/browser acceptance");
const { default: assert } = await import("node:assert/strict");
const { mkdtemp, mkdir, readFile, readdir, lstat, writeFile, rm, readlink } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join, relative } = await import("node:path");
const { createHash, randomUUID } = await import("node:crypto");
const { createServer } = await import("node:http");
const home = await mkdtemp(join(tmpdir(), "wb-playwright-runtime-"));
const inherited = { PATH: process.env.PATH, https: process.env.WORKBENCH_PLAYWRIGHT_HTTPS_URL };
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, { PATH: inherited.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", HOME: home, USERPROFILE: home,
  PI_CODING_AGENT_DIR: join(home, "agent"), XDG_CACHE_HOME: join(home, "cache"), XDG_CONFIG_HOME: join(home, "config"),
  XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), TMPDIR: join(home, "tmp"), WORKBENCH_RUNTIME_TESTS: "1" });
if (inherited.https) process.env.WORKBENCH_PLAYWRIGHT_HTTPS_URL = inherited.https;
for (const path of ["agent", "cache", "config", "data", "state", "tmp"]) await mkdir(join(home, path), { mode: 0o700 });
const cancel = new AbortController(); process.on("SIGTERM", () => cancel.abort()); process.on("SIGINT", () => cancel.abort());
const { createJiti } = await import("jiti");
const jiti = createJiti(import.meta.url, { fsCache: false });
const { resolveWorkbenchPaths } = await jiti.import("../src/paths.ts");
const { PlaywrightRuntime } = await jiti.import("../src/playwright-runtime.ts");
const { PlaywrightManager } = await jiti.import("../src/playwright-manager.ts");
const { PlaywrightStdioClient } = await jiti.import("../src/playwright-process.ts");
const { readPlaywrightOwnership } = await jiti.import("../src/playwright-ownership.ts");
const { PlaywrightOwnedTree } = await jiti.import("../src/playwright-tree.ts");
const { assertPlaywrightToolCall, PLAYWRIGHT_NORMAL_TOOLS } = await jiti.import("../src/playwright-policy.ts");
const { PLAYWRIGHT_VERSION, PLAYWRIGHT_ENGINE_VERSION, assertPlaywrightMcpConfiguration } = await jiti.import("../src/playwright-config.ts");
const paths = resolveWorkbenchPaths(home), controllers = [];
const report = { home, host: `${process.platform}/${process.arch}`, node: process.version, model: "none; no Pi process or model used", checks: [], unverified: ["Live Pi/model delivery and interpretation", "Other platform/architecture targets", "Actual shipped-pin upgrade (initial release has one production pin)", "LAN/public browser connectivity outside explicitly supplied synthetic targets"] };
let completed = false, server;
const progress = message => console.error(`[Playwright acceptance] ${message}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(condition, label, timeout = 20000) { const deadline = Date.now() + timeout; while (!await condition()) { if (Date.now() >= deadline) throw new Error(`Acceptance deadline: ${label}`); await sleep(50); } }
async function fingerprint(root) {
  const records = [];
  async function visit(path) { for (const name of (await readdir(path)).sort()) { const entry = join(path, name), stat = await lstat(entry, { bigint: true }); records.push([relative(root, entry), String(stat.size), String(stat.mtimeNs), String(stat.mode), stat.isSymbolicLink() ? await readlink(entry) : ""]); if (stat.isDirectory()) await visit(entry); } }
  await visit(root); return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}
function controller(cwd) {
  let registry, connection, tools = [];
  const manager = new PlaywrightManager(cwd, { paths, progress, signal: cancel.signal,
    register: (name, config) => {
      registry = config; connection = PlaywrightStdioClient.connect({ command: config.command, args: config.args, env: config.env, cwd: config.cwd, timeoutMs: 90000 });
      void connection.then(async client => { tools = (await client.request("tools/list")).tools.map(tool => `mcp__playwright__${tool.name}`); }).catch(() => {});
    },
    unregister: () => { registry = undefined; void connection?.then(client => client.close()).catch(() => {}); }, isCurrent: config => registry === config, tools: () => tools,
  });
  const value = { manager, client: () => connection }; controllers.push(value); return value;
}
async function tool(controller, name, args = {}) {
  const input = structuredClone(args); await assertPlaywrightToolCall(controller.manager.managedSession, `mcp__playwright__${name}`, input);
  return (await controller.client()).call(name, input);
}
async function evaluate(controller, expression) {
  const filename = join(controller.manager.managedSession.artifacts, `evaluation-${randomUUID()}.json`);
  await tool(controller, "browser_evaluate", { function: expression, filename });
  return JSON.parse(await readFile(filename, "utf8")); // Never confuse echoed code with actual results.
}
async function snapshot(controller) {
  const filename = join(controller.manager.managedSession.artifacts, `snapshot-${randomUUID()}.yml`);
  await tool(controller, "browser_snapshot", { filename }); return readFile(filename, "utf8");
}
try {
  await mkdir(join(home, "workspace-a"), { mode: 0o700 }); await mkdir(join(home, "workspace-b"), { mode: 0o700 });
  const cwd = join(home, "workspace-a"); await writeFile(join(cwd, "upload.txt"), "WB_SYNTHETIC_UPLOAD", { mode: 0o600 });
  const runtime = new PlaywrightRuntime({ paths });
  const ready = await runtime.ensure(progress, cancel.signal); assert.equal(ready.version, PLAYWRIGHT_VERSION); assert.equal(ready.engineVersion, PLAYWRIGHT_ENGINE_VERSION);
  report.runtime = { id: ready.id, version: ready.version, engineVersion: ready.engineVersion, browserVersion: ready.browserVersion, manifestSha256: ready.manifestSha256, node: ready.node, npm: ready.npm, slot: ready.slot };
  const before = await fingerprint(ready.slot); assert.equal((await runtime.ensure(progress, cancel.signal)).id, ready.id); assert.equal(await fingerprint(ready.slot), before);
  report.checks.push("fresh exact-pin provisioning and immutable same-pin reuse");
  const hits = new Map();
  server = createServer((request, response) => {
    const path = new URL(request.url, "http://fixture.invalid").pathname; hits.set(path, (hits.get(path) ?? 0) + 1);
    if (path === "/api") { response.setHeader("content-type", "application/json"); response.end('{"sentinel":"WB_SYNTHETIC_API"}'); return; }
    if (path === "/download") { response.setHeader("content-disposition", 'attachment; filename="fixture-download.txt"'); response.end("WB_SYNTHETIC_DOWNLOAD"); return; }
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><title>Workbench synthetic acceptance</title><h1>WB_SYNTHETIC_PAGE</h1>
      <form onsubmit="event.preventDefault();document.querySelector('#result').textContent=document.querySelector('#name').value"><label>Name <input id="name" aria-label="Name"></label><button type="submit">Submit</button></form>
      <p id="result"></p><button id="coordinate" onclick="window.coordinateCount=(window.coordinateCount||0)+1">Coordinate</button>
      <input type="file" id="upload"><a id="download" href="/download">Download</a>
      <script>console.log('WB_SYNTHETIC_CONSOLE');fetch('/api');window.coordinateCount=0;
      if(navigator.modelContext?.registerTool)navigator.modelContext.registerTool({name:'wb_page_authored_fixture',description:'Synthetic page-provided tool',inputSchema:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'synthetic'}]})});</script>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const url = `http://127.0.0.1:${server.address().port}/`;
  const first = controller(cwd), peer = controller(cwd), other = controller(join(home, "workspace-b"));
  await first.manager.on(); const client = await first.client(), session = first.manager.managedSession;
  const listing = await client.request("tools/list"), names = listing.tools.map(tool => tool.name);
  assert.ok(PLAYWRIGHT_NORMAL_TOOLS.every(name => names.includes(name))); await writeFile(join(home, "tool-schemas.json"), JSON.stringify(listing, null, 2), { mode: 0o600 });
  const cfg = JSON.parse(await readFile(session.configPath, "utf8")); assertPlaywrightMcpConfiguration(cfg, session, ready.browser);
  await tool(first, "browser_navigate", { url: "chrome://sandbox" });
  const sandbox = await evaluate(first, "() => document.body.innerText");
  assert.match(sandbox, /adequately sandboxed|Namespace sandbox[\s\S]*Yes[\s\S]*Seccomp-BPF[\s\S]*Yes/i, "Effective sandbox evidence required; no fallback flags allowed");
  const evidence = await readPlaywrightOwnership(session), tree = new PlaywrightOwnedTree(evidence.scope, evidence.roots);
  let command, browserPid;
  await wait(async () => { for (const owner of (await tree.capture()).processes) { try { if ((await readlink(`/proc/${owner.pid}/exe`)) === ready.browser) { const args = (await readFile(`/proc/${owner.pid}/cmdline`, "utf8")).split("\0"); if (!args.includes("--remote-debugging-pipe") || args.some(arg => arg.startsWith("--type="))) continue; command = args; browserPid = owner.pid; return true; } } catch {} } return false; }, "owned Chromium process evidence");
  assert.ok(command.some(arg => arg.startsWith("--headless"))); assert.equal(command.includes("--no-sandbox"), false);
  assert.equal(await readlink(`/proc/${browserPid}/cwd`), session.tmp); assert.equal(await readlink(`/proc/${browserPid}/fd/0`), "/dev/null");
  report.sandbox = { fixedConfiguration: true, headlessArgument: true, noUnsandboxedFlag: true, chromeSandboxPage: true, browserWorkingDirectoryManaged: true, browserStandardInputPreserved: true };
  report.checks.push("actual sandbox page and owned launch arguments, not screenshot-only evidence");
  await tool(first, "browser_navigate", { url }); assert.match(await snapshot(first), /WB_SYNTHETIC_PAGE/);
  let page = await snapshot(first), textbox = /textbox "Name"[^\n]*\[ref=([^\]]+)\]/.exec(page)?.[1]; assert.ok(textbox);
  await tool(first, "browser_type", { target: textbox, text: "WB_SYNTHETIC_FORM" });
  page = await snapshot(first); const button = /button "Submit"[^\n]*\[ref=([^\]]+)\]/.exec(page)?.[1]; assert.ok(button); await tool(first, "browser_click", { target: button });
  assert.equal(await evaluate(first, "() => document.querySelector('#result').textContent"), "WB_SYNTHETIC_FORM");
  const outsideUpload = join(home, "outside-upload.txt"); await writeFile(outsideUpload, "WB_SYNTHETIC_OUTSIDE_UPLOAD", { mode: 0o600 });
  await tool(first, "browser_click", { target: "#upload" });
  await assert.rejects(tool(first, "browser_file_upload", { paths: [outsideUpload] }), /tool failed/);
  await tool(first, "browser_file_upload", { paths: [join(cwd, "upload.txt")] });
  assert.equal(await evaluate(first, "async () => await document.querySelector('#upload').files[0].text()"), "WB_SYNTHETIC_UPLOAD");
  const point = await evaluate(first, "() => {const r=document.querySelector('#coordinate').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}}");
  await tool(first, "browser_mouse_click_xy", point); assert.equal(await evaluate(first, "() => window.coordinateCount"), 1);
  const shot = join(session.artifacts, "screenshot.png");
  await tool(first, "browser_take_screenshot", { filename: shot });
  const image = await tool(first, "browser_take_screenshot"); // Upstream emits inline images only when filename is omitted.
  assert.ok(image.content.some(part => part.type === "image" && part.mimeType === "image/png" && Buffer.from(part.data, "base64").subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))));
  assert.ok((await readFile(shot)).subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
  const consolePath = join(session.artifacts, "console.log"), networkPath = join(session.artifacts, "network.log");
  await tool(first, "browser_console_messages", { filename: consolePath }); await tool(first, "browser_network_requests", { filename: networkPath });
  assert.match(await readFile(consolePath, "utf8"), /WB_SYNTHETIC_CONSOLE/); assert.match(await readFile(networkPath, "utf8"), /\/api/); assert.ok(hits.get("/api"));
  await evaluate(first, "() => {document.querySelector('#download').click();return true}");
  await wait(async () => { try { return await readFile(join(session.artifacts, "fixture-download.txt"), "utf8") === "WB_SYNTHETIC_DOWNLOAD"; } catch { return false; } }, "managed download");
  await assert.rejects(tool(first, "browser_take_screenshot", { filename: "escaped.png" }), /escapes/);
  assert.deepEqual((await readdir(cwd)).sort(), ["upload.txt"]);
  report.checks.push("navigation, snapshots, form, coordinate vision, real PNG, evaluation, console/network, workspace upload guardrails, managed downloads and explicit output policy");
  await evaluate(first, "() => {localStorage.setItem('wb_state','WB_SYNTHETIC_STATE');document.cookie='wb_cookie=synthetic;path=/';return true}");
  await peer.manager.on(); await other.manager.on();
  for (const isolated of [peer, other]) { await tool(isolated, "browser_navigate", { url }); assert.equal(await evaluate(isolated, "() => localStorage.getItem('wb_state')"), null); }
  assert.equal(await evaluate(first, "() => localStorage.getItem('wb_state')"), "WB_SYNTHETIC_STATE");
  await tool(first, "browser_close"); await tool(first, "browser_navigate", { url });
  assert.deepEqual(await evaluate(first, "() => ({storage:localStorage.getItem('wb_state'),cookie:document.cookie})"), { storage: null, cookie: "" });
  const afterPageTools = (await (await first.client()).request("tools/list")).tools.map(tool => tool.name); assert.deepEqual(afterPageTools.sort(), names.sort());
  assert.equal(cfg.webmcp, false); await assert.rejects(tool(first, "browser_run_code_unsafe", { code: "() => 1" }), /blocked/);
  report.checks.push("call-to-call storage continuity, same/different-workspace isolated browsers, browser-close state loss, fixed WebMCP/unsafe policy");
  const httpsTarget = process.env.WORKBENCH_PLAYWRIGHT_HTTPS_URL;
  if (httpsTarget) { const target = new URL(httpsTarget); assert.equal(target.protocol, "https:"); assert.ok(!target.username && !target.password && !target.search && !target.hash); await tool(first, "browser_navigate", { url: target.href }); await snapshot(first); report.checks.push("caller-supplied trusted synthetic HTTPS target"); }
  else report.unverified.push("HTTPS synthetic target: supply WORKBENCH_PLAYWRIGHT_HTTPS_URL with an anonymous trusted synthetic endpoint; no host trust changes are performed");
  const own = await readPlaywrightOwnership(session); process.kill(own.record.child.pid, "SIGKILL");
  await first.manager.shutdown();
  const drained = await readPlaywrightOwnership(session); assert.equal((await new PlaywrightOwnedTree(drained.scope, drained.roots).capture()).processes.length, 0);
  await assert.rejects(first.manager.off(true), /same-workspace peers/); await snapshot(peer); await snapshot(other);
  const peerBefore = await readPlaywrightOwnership(peer.manager.managedSession); assert.ok((await new PlaywrightOwnedTree(peerBefore.scope, peerBefore.roots).capture()).processes.length > 0, "peer browser tree must be live before normal shutdown");
  await peer.manager.shutdown(); await readFile(peer.manager.managedSession.markerPath); // No deferred deletion after peer exits.
  const peerAfter = await readPlaywrightOwnership(peer.manager.managedSession); assert.equal((await new PlaywrightOwnedTree(peerAfter.scope, peerAfter.roots).capture()).processes.length, 0, "normal shutdown must leave no owned descendants");
  await first.manager.off(true); await accessAbsent(first.manager.project.directory); await snapshot(other); await readFile(join(cwd, "upload.txt"));
  assert.equal(await fingerprint(ready.slot), before); report.checks.push("forced MCP exit/descendant cleanup, peer-busy refusal, explicit scoped deletion, other-workspace protection and shared-slot immutability");
  const eofOwn = await readPlaywrightOwnership(other.manager.managedSession), eofTree = new PlaywrightOwnedTree(eofOwn.scope, eofOwn.roots);
  assert.ok((await eofTree.capture()).processes.length > 0, "browser tree must be live before EOF");
  await (await other.client()).close(); // EOF on MCP stdio without manager shutdown.
  await wait(async () => (await eofTree.capture()).processes.length === 0, "owned descendants gone after EOF", 30000);
  report.checks.push("normal-shutdown and stdio-EOF descendant quiescence");
  await other.manager.shutdown(); await other.manager.off(true);
  completed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : "Runtime acceptance failed";
  throw error;
} finally {
  const cleanup = await Promise.allSettled(controllers.map(async controller => { await controller.manager.shutdown(); await (await controller.client())?.close(); }));
  report.cleanup = cleanup.map(result => result.status); if (cleanup.some(result => result.status === "rejected")) { completed = false; process.exitCode = 1; report.unverified.push("Owned cleanup incomplete; retain fixture and inspect ownership evidence"); }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  report.passed = completed;
  await writeFile(join(home, "acceptance.json"), JSON.stringify(report, null, 2), { mode: 0o600 }); console.log(JSON.stringify(report, null, 2));
  if (!completed || process.argv.includes("--keep")) console.error(`Retained Playwright acceptance fixture: ${home}`); else await rm(home, { recursive: true, force: true });
}
async function accessAbsent(path) { await assert.rejects(lstat(path), { code: "ENOENT" }); }
