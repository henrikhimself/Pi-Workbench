/** Deliberate defects in disposable source copies. Never mutate the working tree. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, cp, symlink, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const mutations = [
  { name: "Memory startup opt-in gate removed", file: "src/index.ts", from: '    if (!createStore && !manager.enabled) {\n      setMemoryStatus(ctx, "off");\n      return false;\n    }', to: "// Deliberate off Memory root preparation", test: "project-startup", pattern: "opted-out startup never prepares", evidence: /off Memory must be gated before ensureRoot/ },
  { name: "compression startup opt-in gate removed", file: "src/index.ts", from: "if (!compressionCurrent(generation, epoch) || !optedIn) return;", to: "if (!compressionCurrent(generation, epoch)) return;", test: "project-startup", pattern: "opted-out startup never prepares", evidence: /off features must not emit Headroom root\/runtime warnings/ },
  { name: "project compression on intent not persisted", file: "src/headroom-project.ts", from: '      await publishJson(project.directory, project.statePath, {\n        schemaVersion: 1, enabled: true, projectPath: project.projectPath, identifier: project.identifier,\n      });', to: "// Deliberate missing intent publication", test: "headroom-project", pattern: "compression absent opt-in and off", evidence: /false !== true/ },
  { name: "headless theme fallback removed", file: "src/index.ts", from: "return ctx.ui.theme?.fg?.(color, text) ?? text;", to: "return ctx.ui.theme.fg(color, text);", test: "session-lifecycle", pattern: "SDK without UI theme", evidence: /missing theme must not interrupt actual progress callback/ },
  { name: "deny shim timestamp collision reintroduced", file: "src/code-graph-manager.ts", from: "const tempPath = `${shimPath}.${process.pid}-${randomUUID()}.tmp`;", to: "const tempPath = `${shimPath}.${process.pid}-${Date.now().toString(36)}.tmp`;", test: "code-graph-manager", pattern: "same-process concurrent deny shim", evidence: /ENOENT|EEXIST/ },
  { name: "proxy log close on callback failure lost", file: "src/proxy-manager.ts", from: "} finally { await log.close(); }", to: "} finally { /* deliberate leaked log */ }", test: "proxy-manager", pattern: "proxy launch closes log handle", evidence: /throwing callback must not leak opened file handle/ },
  { name: "native normalized Memory tool name lost", file: "src/memory-guidance.ts", from: 'const searchAvailable = activeTools.has("mcp__headroom_memory__memory_search");', to: 'const searchAvailable = activeTools.has("mcp__headroom-memory__memory_search");', test: "memory-guidance", pattern: "Memory guidance names match actual Pi", evidence: /off.*normal|normal.*off/ },
  { name: "bad reviewed digest", file: "src/code-graph-assets.ts", from: "8c3d0341064301e78ecc84cf7348d4e2c6562a0f57448243ea560aaa34de36c1", to: "0".repeat(64), test: "code-graph-pins", pattern: "both reviewed portable assets", evidence: /8c3d0341064301e/ },
  { name: "backend version check removed", file: "src/code-graph-manager.ts", from: "!init || init.serverInfo?.version !== CODE_GRAPH_REQUIRED_VERSION.slice(1)", to: "!init", test: "code-graph-contract", pattern: "strict MCP rejects wrong backend version", evidence: /true !== false/ },
  { name: "tool-name check removed", file: "src/code-graph-manager.ts", from: 'if (tools.length !== CODE_GRAPH_EXPECTED_TOOLS.length || CODE_GRAPH_EXPECTED_TOOLS.some((name) => !tools.includes(name))) throw new Error("MCP tool-name contract mismatch");', to: "// Deliberate missing name check", test: "code-graph-contract", pattern: "strict MCP rejects same count with wrong names", evidence: /true !== false/ },
  { name: "runtime namespace propagation lost", file: "src/code-graph-manager.ts", from: 'CBM_RUNTIME_DIR: options.runtimeDirectory ?? join(dirname(options.projectDirectory), ".runtime", basename(options.projectDirectory)),', to: "CBM_RUNTIME_DIR: options.projectDirectory,", test: "code-graph-contract", pattern: "CBM child environment binds owned namespace", evidence: /owned\/cache|owned\/runtime/ },
  { name: "health ownership proof removed", file: "src/proxy-manager.ts", from: 'if (response.headers.get("x-pi-workbench-owner") !== proof || response.headers.get("x-pi-workbench-runtime") !== expected) return false;', to: "// Deliberate missing proof check", test: "proxy-manager", pattern: "replayed health response cannot", evidence: /true !== false/ },
  { name: "authored data restoration lost", file: "src/code-graph-upgrade.ts", from: "await restoreAuthoredData(stage.directory, authored);", to: "// Deliberate data loss", test: "code-graph-upgrade", pattern: "extension activation automatically stages upgrade", evidence: /ADR sentinel/ },
  { name: "direct MCP registration removed", file: "src/code-graph-manager.ts", from: "this.deps.registerMcp(CODE_GRAPH_MCP_SERVER_NAME, this.getMcpConfig(project, binaryPath));", to: "// Deliberate missing direct registration", test: "code-graph-manager", pattern: "activate: full transaction publishes state", evidence: /0 !== 1/ },
  { name: "SDK transport bypasses ownership adapter", file: "src/headroom-client.ts", from: "const value = await proxy.requestOwned(path, body, method);", to: "const value = await (await fetch(proxy.baseUrl + path, { method, body: JSON.stringify(body) })).json();", test: "headroom-client", pattern: "actual SDK compress and raw calls use owned transport", evidence: /Unsealed fetch must not run/ },
  { name: "Playwright absent opt-in adopted", file: "src/playwright-config.ts", from: 'const raw = await readPlaywrightJson(project.root, project.statePath);\n  if (raw === null) return false;', to: 'const raw = await readPlaywrightJson(project.root, project.statePath);\n  if (raw === null) return true;', test: "playwright-manager", pattern: "restore obeys absent opt-in before runtime seam", evidence: /off Playwright must be gated before runtime preparation/ },
  { name: "Playwright Chromium sandbox disabled", file: "src/playwright-config.ts", from: "chromiumSandbox: true", to: "chromiumSandbox: false", test: "playwright-config", pattern: "fresh session has fixed sandbox", evidence: /false !== true/ },
  { name: "Playwright unsafe server code directly exposed", file: "src/playwright-policy.ts", from: 'browser_run_code_unsafe: "hidden"', to: 'browser_run_code_unsafe: "direct"', test: "playwright-integration", pattern: "normal core/vision exposure hides unsafe", evidence: /direct.*hidden|hidden.*direct/s },
  { name: "Playwright WebMCP enabled", file: "src/playwright-config.ts", from: "webmcp: false", to: "webmcp: true", test: "playwright-config", pattern: "fresh session has fixed sandbox", evidence: /true !== false/ },
  { name: "Playwright deletion escapes workspace", file: "src/playwright-manager.ts", from: '(this.deps.remove ?? (path => rm(path, { recursive: true })))(this.project.directory)', to: '(this.deps.remove ?? (path => rm(path, { recursive: true })))(this.paths.playwrightRoot)', test: "playwright-manager", pattern: "confirmed off deletes only workspace data", evidence: /Only exact managed workspace may be deleted/ },
  { name: "Playwright detached browser lease prematurely quiescent", file: "src/playwright-runtime.ts", from: "active = snapshot.processes.length > 0;", to: "active = false;", test: "playwright-launcher", pattern: "recovery detects orphaned detached descendants", evidence: /0 !== 2/ },

  { name: "Vision sent with no configured model", file: "src/playwright-vision-tool.ts", from: "if (vision.state !== \"ready\") throw new Error(", to: "if (false) throw new Error(", test: "playwright-vision-tool", pattern: "unavailable Playwright or unset config", evidence: /not ok \d+ - unavailable\ Playwright\ or\ unset\ config/ },
  { name: "Vision request goes to a model other than the configured one", file: "src/playwright-vision.ts", from: "deps.registry.find(deps.target.provider, deps.target.model)", to: "deps.registry.find(deps.target.provider, deps.target.model + \"-x\")", test: "playwright-vision", pattern: "success wraps", evidence: /not ok \d+ - success\ wraps/ },
  { name: "Vision request sent to a model without image input", file: "src/playwright-vision.ts", from: "if (!Array.isArray(model.input) || !model.input.includes(\"image\"))", to: "if (false)", test: "playwright-vision", pattern: "gates refuse before any request", evidence: /not ok \d+ - gates\ refuse\ before\ any\ request/ },
  { name: "Image block returned to the agent", file: "src/playwright-vision-tool.ts", from: "return { content: [{ type: \"text\", text: `${described.text}${note}` }],", to: "return { content: [{ type: \"text\", text: `${described.text}${note}` }, image],", test: "playwright-vision-tool", pattern: "success takes a guarded css screenshot", evidence: /not ok \d+ - success\ takes\ a\ guarded\ css\ screenshot/ },
  { name: "Tool recommended to an image-capable chat model", file: "src/playwright-integration.ts", from: "Array.isArray(ctx.model.input) && !ctx.model.input.includes(\"image\")", to: "Array.isArray(ctx.model.input)", test: "playwright-vision-tool", pattern: "guidance recommends the tool", evidence: /not ok \d+ - guidance\ recommends\ the\ tool/ },
  { name: "Credentials leaked into vision diagnostics", file: "src/playwright-vision.ts", from: "return fail(classify(error instanceof Error ? error.message : undefined), \"Vision model request failed.\");", to: "return fail(classify(error instanceof Error ? error.message : undefined), \"Vision model request failed: \" + (error instanceof Error ? error.message : \"\"));", test: "playwright-vision", pattern: "failure matrix", evidence: /not ok \d+ - failure\ matrix/ },
  { name: "Untrusted wrapper omitted", file: "src/playwright-vision.ts", from: "return `${VISION_BEGIN}\\n${body}\\n${VISION_END}`;", to: "return body;", test: "playwright-vision", pattern: "success wraps", evidence: /not ok \d+ - success\ wraps/ },
  { name: "Failure drops screenshot artifact details", file: "src/playwright-vision-tool.ts", from: "Use browser_snapshot instead.${note}`", to: "Use browser_snapshot instead.`", test: "playwright-vision-tool", pattern: "screenshot and vision failures", evidence: /not ok \d+ - screenshot\ and\ vision\ failures/ },
  { name: "Router auto-load instead of require-loaded", file: "src/playwright-vision.ts", from: "const gate = await requireLoaded(deps, model, signal);\n    if (gate) return gate;", to: "const gate = null;", test: "playwright-vision", pattern: "require-loaded", evidence: /not ok \d+ - require\-loaded/ },
  { name: "Existing playwright.json overwritten by template", file: "src/playwright-vision-config.ts", from: "flag: \"wx\", mode: 0o600", to: "flag: \"w\", mode: 0o600", test: "playwright-vision-config", pattern: "template creation writes null model once", evidence: /not ok \d+ - template\ creation\ writes\ null\ model\ once/ },
  { name: "plaintext context accidentally attached", file: "src/owned-transport.ts", from: 'JSON.stringify({ v: 1, iv: iv.toString("base64"), data: data.toString("base64") })', to: 'JSON.stringify({ v: 1, leak: value, iv: iv.toString("base64"), data: data.toString("base64") })', test: "proxy-manager", pattern: "compression authenticates both directions", evidence: /true !== false/ },
];
const root = await mkdtemp(join(tmpdir(), "wb-test-quality-")), results = [];
let completed = false;
try {
  for (const [index, mutation] of mutations.entries()) {
    const copy = join(root, String(index)), home = join(copy, "home"); await mkdir(home, { recursive: true, mode: 0o700 });
    for (const entry of ["src", "test", "assets", "package.json", "tsconfig.json"]) await cp(join(repository, entry), join(copy, entry), { recursive: true });
    await symlink(join(repository, "node_modules"), join(copy, "node_modules"), "dir");
    const path = join(copy, mutation.file), original = await readFile(path, "utf8");
    assert.equal(original.split(mutation.from).length - 1, 1, `Unique mutation anchor: ${mutation.name}`);
    await writeFile(path, original.replace(mutation.from, mutation.to));
    const child = spawnSync(process.execPath, ["--test", `--test-name-pattern=${mutation.pattern}`, join(copy, "test", mutation.test + ".test.mjs")], {
      cwd: copy, env: { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: home, USERPROFILE: home,
        PI_CODING_AGENT_DIR: join(home, "agent"), PYTHONDONTWRITEBYTECODE: "1",
        NODE_OPTIONS: `--import=${join(copy, "test/helpers/offline-guard.mjs")}` }, encoding: "utf8", timeout: 45000, maxBuffer: 8 * 1024 * 1024,
    });
    const output = child.stdout + child.stderr;
    await writeFile(join(root, `mutation-${index}.log`), output);
    assert.equal(child.status, 1, `${mutation.name} must be killed by intended assertion: ${output}`);
    assert.match(output, /not ok/); assert.match(output, mutation.evidence, mutation.name);
    assert.doesNotMatch(output, /Offline policy violation|Cannot find package|SyntaxError|Timed out waiting/);
    results.push({ fault: mutation.name, caught: true, assertion: mutation.pattern });
  }
  completed = true;
  console.log(JSON.stringify({ cases: results.length, results }, null, 2));
} finally {
  if (!completed || process.argv.includes("--keep")) console.error(`Retained negative controls: ${root}`);
  else await rm(root, { recursive: true, force: true });
}
