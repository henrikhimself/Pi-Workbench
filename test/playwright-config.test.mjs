import { test } from "node:test";
import assert from "node:assert/strict";
import { access, chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
import { playwrightFixture } from "./helpers/playwright-fixture.mjs";
const jiti = createJiti(import.meta.url);
const m = await jiti.import("../src/playwright-config.ts");
const { resolveWorkbenchPaths } = await jiti.import("../src/paths.ts");
const { publishJson } = await jiti.import("../src/managed-lifecycle.ts");
async function fixture(t) {
  const f = await playwrightFixture(t), paths = resolveWorkbenchPaths(f.home);
  return { ...f, paths, project: m.resolvePlaywrightProject(f.workspace, paths) };
}
function runtime(paths) {
  const id = randomUUID(), slot = join(paths.playwrightRuntimes, m.PLAYWRIGHT_VERSION, id);
  return { schemaVersion: 1, policy: 1, id, version: m.PLAYWRIGHT_VERSION, engineVersion: m.PLAYWRIGHT_ENGINE_VERSION, manifestSha256: "a".repeat(64), slot,
    node: { path: process.execPath, version: "22.22.2", sha256: "b".repeat(64) }, npm: { path: "/fixture/npm-cli.js", version: "10.9.7", sha256: "c".repeat(64) },
    entrypoint: join(slot, "node_modules", "@playwright", "mcp", "cli.js"), browser: join(slot, "browsers", "chromium", "chrome"), browserVersion: "synthetic", tools: ["browser_snapshot"], validatedAt: new Date().toISOString() };
}

test("Playwright paths are separate managed namespaces and passive absence prepares nothing", async t => {
  const f = await fixture(t);
  assert.equal(f.paths.playwrightRoot, join(f.paths.root, "playwright"));
  for (const [field, suffix] of [["playwrightRuntimes", "runtimes"], ["playwrightNpmCache", "cache/npm"], ["playwrightCoordination", "coordination"], ["playwrightConsumers", "consumers"], ["playwrightProjects", "projects"], ["playwrightSelected", "selected.json"]]) {
    assert.equal(f.paths[field], join(f.paths.playwrightRoot, suffix));
  }
  assert.equal(await m.playwrightOptedIn(f.project), false);
  assert.equal(await m.readPlaywrightJson(f.paths.playwrightRoot, f.paths.playwrightSelected), null);
  await assert.rejects(access(f.paths.root), { code: "ENOENT" });
});
test("Playwright uses canonical workspace hashing and independent stores/sessions", async t => {
  const f = await fixture(t), alias = join(f.root, "alias");
  await symlink(f.workspace, alias);
  assert.deepEqual(m.resolvePlaywrightProject(alias, f.paths), f.project);
  const graph = (await jiti.import("../src/code-graph-config.ts")).resolveCodeGraphProject(f.workspace, f.paths);
  assert.equal(f.project.identifier, graph.identifier);
  assert.notEqual(f.project.directory, graph.directory);
  const a = m.resolvePlaywrightSession(f.project), b = m.resolvePlaywrightSession(f.project);
  assert.notEqual(a.id, b.id); assert.notEqual(a.directory, b.directory);
  assert.throws(() => m.resolvePlaywrightSession(f.project, "../../escape"), /identity/);
  assert.throws(() => m.assertPlaywrightProject({ ...f.project, directory: f.workspace }), /mismatch/);
});
test("Playwright opt-in is atomic private explicit intent and removable without losing unrelated artifacts", async t => {
  const f = await fixture(t);
  await m.preparePlaywrightRoot(f.paths);
  await m.enablePlaywrightOptIn(f.project);
  assert.equal(await m.playwrightOptedIn(f.project), true);
  assert.equal((await lstat(f.project.optInPath)).mode & 0o777, 0o600);
  const first = await readFile(f.project.optInPath, "utf8");
  await m.enablePlaywrightOptIn(f.project);
  assert.equal(await readFile(f.project.optInPath, "utf8"), first);
  await writeFile(join(f.project.directory, "artifact"), "keep");
  await rm(f.project.optInPath);
  assert.equal(await m.playwrightOptedIn(f.project), false);
  assert.equal(await readFile(join(f.project.directory, "artifact"), "utf8"), "keep");
});
for (const [label, mutate] of [
  ["malformed", () => "{"], ["unknown fields", state => JSON.stringify({ ...state, extra: true })],
  ["schemaVersion", state => JSON.stringify({ ...state, schemaVersion: 2 })], ["wrong projectPath", state => JSON.stringify({ ...state, projectPath: "/elsewhere" })],
  ["old workspace key", ({ projectPath, ...state }) => JSON.stringify({ ...state, workspace: projectPath })],
  ["wrong identifier", state => JSON.stringify({ ...state, identifier: "other" })], ["false enabled", state => JSON.stringify({ ...state, enabled: false })],
]) test(`Playwright refuses ${label} opt-in and does not overwrite it`, async t => {
  const f = await fixture(t); await m.enablePlaywrightOptIn(f.project);
  const raw = mutate(JSON.parse(await readFile(f.project.optInPath, "utf8")));
  await writeFile(f.project.optInPath, raw);
  await assert.rejects(m.playwrightOptedIn(f.project));
  await assert.rejects(m.enablePlaywrightOptIn(f.project));
  assert.equal(await readFile(f.project.optInPath, "utf8"), raw);
});
test("Playwright opt-in uses the shared record: schemaVersion, enabled, projectPath, identifier", async t => {
  const f = await fixture(t); await m.enablePlaywrightOptIn(f.project);
  assert.deepEqual(JSON.parse(await readFile(f.project.optInPath, "utf8")),
    { schemaVersion: 1, enabled: true, projectPath: f.project.projectPath, identifier: f.project.identifier });
});
test("Playwright rejects unsafe directory/file permissions and symlink ancestry without repair", async t => {
  const f = await fixture(t); await m.enablePlaywrightOptIn(f.project);
  await chmod(f.project.directory, 0o755);
  await assert.rejects(m.playwrightOptedIn(f.project), /Unsafe/);
  assert.equal((await lstat(f.project.directory)).mode & 0o777, 0o755);
  await chmod(f.project.directory, 0o700);
  await chmod(f.project.optInPath, 0o644);
  await assert.rejects(m.playwrightOptedIn(f.project), /Unsafe/);
  await chmod(f.project.optInPath, 0o600);
  const alias = join(f.paths.playwrightRoot, "alias.json"); await symlink(f.project.optInPath, alias);
  await assert.rejects(m.readPlaywrightJson(f.paths.playwrightRoot, alias), /Symlink/);
  await assert.rejects(m.readPlaywrightJson(f.paths.playwrightRoot, join(f.root, "outside")), /escapes/);
});
test("Playwright refuses wrong-owner state without modifying owner or data", async t => {
  const f = await fixture(t); await m.enablePlaywrightOptIn(f.project);
  const original = process.getuid;
  try { process.getuid = () => original() + 1; await assert.rejects(m.playwrightOptedIn(f.project), /Unsafe/); }
  finally { process.getuid = original; }
  assert.equal(await m.playwrightOptedIn(f.project), true);
});
test("Playwright cancelled intent and interrupted JSON publication never adopt partial records", async t => {
  const f = await fixture(t);
  await assert.rejects(m.enablePlaywrightOptIn(f.project, AbortSignal.abort()));
  await assert.rejects(access(f.paths.playwrightRoot), { code: "ENOENT" });
  await mkdir(f.project.directory, { recursive: true, mode: 0o700 });
  await writeFile(f.project.optInPath + ".interrupted.tmp", "{", { mode: 0o600 });
  assert.equal(await m.playwrightOptedIn(f.project), false);
  await m.enablePlaywrightOptIn(f.project);
  assert.equal(await m.playwrightOptedIn(f.project), true);
});
test("Playwright runtime/selection schemas bind identity and canonical managed entrypoints", async t => {
  const f = await fixture(t), record = runtime(f.paths);
  assert.deepEqual(m.parsePlaywrightRuntime(record, f.paths), record);
  const selection = { schemaVersion: 1, id: record.id, version: record.version, slot: record.slot };
  assert.deepEqual(m.parsePlaywrightSelection(selection, f.paths), selection);
  for (const changed of [{ schemaVersion: 2 }, { policy: 2 }, { extra: 1 }, { id: "bad" }, { slot: f.workspace }, { entrypoint: "/external.js" }, { browser: "/usr/bin/chromium" }, { validatedAt: "yesterday" }, { tools: ["dup", "dup"] }, { node: { ...record.node, sha256: "bad" } }]) {
    assert.throws(() => m.parsePlaywrightRuntime({ ...record, ...changed }, f.paths));
  }
  assert.throws(() => m.parsePlaywrightSelection({ ...selection, slot: "/external" }, f.paths));
});
test("Playwright fresh session has fixed sandbox/headless/vision/idle/output policy and private configuration", async t => {
  const f = await fixture(t), record = runtime(f.paths), session = m.resolvePlaywrightSession(f.project);
  await assert.rejects(m.preparePlaywrightSession(session, record), /not opted in/);
  await m.enablePlaywrightOptIn(f.project);
  await m.preparePlaywrightSession(session, record);
  const config = JSON.parse(await readFile(session.configPath, "utf8"));
  assert.equal(config.browser.isolated, true); assert.equal(config.browser.launchOptions.chromiumSandbox, true);
  assert.equal(config.browser.launchOptions.headless, true); assert.equal(config.browser.launchOptions.executablePath, record.browser);
  assert.deepEqual(config.capabilities, ["vision"]); assert.equal(config.webmcp, false); assert.equal(config.ignoreRoots, true);
  assert.equal(config.outputDir, session.artifacts); assert.equal(config.outputMaxSize, 0); assert.equal(config.timeouts.idle, 0);
  assert.equal(config.network, undefined); assert.equal(config.allowUnrestrictedFileAccess, false);
  assert.equal(config.browser.userDataDir, undefined); assert.equal(config.saveSession, false);
  m.assertPlaywrightMcpConfiguration(config, session, record.browser);
  for (const changed of [{ webmcp: true }, { network: { allowedOrigins: ["https://example.invalid"] } }, { outputDir: f.workspace }, { browser: { ...config.browser, launchOptions: { ...config.browser.launchOptions, chromiumSandbox: false } } }]) {
    assert.throws(() => m.assertPlaywrightMcpConfiguration({ ...config, ...changed }, session, record.browser), /mismatch/);
  }
  assert.equal((await lstat(session.configPath)).mode & 0o777, 0o600);
  const marker = m.parsePlaywrightSession(JSON.parse(await readFile(session.markerPath, "utf8")));
  assert.equal(marker.sessionId, session.id); assert.equal(marker.workspace, f.workspace);
  assert.throws(() => m.parsePlaywrightSession({ ...marker, owner: { ...marker.owner, pid: -1 } }));
  await assert.rejects(m.preparePlaywrightSession(session, record), { code: "EEXIST" });
});
test("Playwright child environment ignores inherited injection, attach, policy, profile and cache overrides", async t => {
  const f = await fixture(t), record = runtime(f.paths), session = m.resolvePlaywrightSession(f.project);
  const env = m.playwrightChildEnvironment(session, record, f.paths.playwrightNpmCache);
  for (const key of ["NODE_OPTIONS", "NODE_PATH", "PLAYWRIGHT_MCP_CONFIG", "PLAYWRIGHT_MCP_CDP_ENDPOINT", "PLAYWRIGHT_MCP_USER_DATA_DIR", "PLAYWRIGHT_MCP_SANDBOX", "DISPLAY", "PWDEBUG", "API_KEY", "HTTP_PROXY"]) assert.equal(env[key], undefined);
  assert.equal(env.HOME, session.home); assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, join(record.slot, "browsers"));
  assert.equal(env.PLAYWRIGHT_SKIP_BROWSER_GC, "1");
  assert.equal(env.NPM_CONFIG_CACHE, f.paths.playwrightNpmCache);
  assert.throws(() => m.playwrightChildEnvironment(session, record, f.workspace), /escapes/);
});
test("Playwright explicit output guard rejects project, escaped and symlink outputs but accepts managed files", async t => {
  const f = await fixture(t), record = runtime(f.paths), session = m.resolvePlaywrightSession(f.project);
  await m.enablePlaywrightOptIn(f.project); await m.preparePlaywrightSession(session, record);
  assert.equal(await m.assertPlaywrightArtifact(session, join(session.artifacts, "shot.png")), join(session.artifacts, "shot.png"));
  for (const name of ["shot.png", "../../escape", f.workspace, session.artifacts, "", null]) await assert.rejects(m.assertPlaywrightArtifact(session, name));
  await symlink(f.workspace, join(session.artifacts, "link"));
  await assert.rejects(m.assertPlaywrightArtifact(session, join(session.artifacts, "link", "shot.png")), /Symlink/);
});
test("Playwright recovery schemas reject unknown operations, identities and extra fields", () => {
  const record = { schemaVersion: 1, operation: "cleanup", runtimeId: randomUUID(), detail: "synthetic failure", createdAt: new Date().toISOString() };
  assert.deepEqual(m.parsePlaywrightRecovery(record), record);
  for (const changed of [{ operation: "delete-everything" }, { runtimeId: "../escape" }, { extra: 1 }]) assert.throws(() => m.parsePlaywrightRecovery({ ...record, ...changed }));
});
