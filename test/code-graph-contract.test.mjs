import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { createJiti } from "jiti";
import { fakeCbmSource, fakeCbmTools } from "./helpers/fake-cbm.mjs";
import { writeCodeGraphFiles } from "./helpers/code-graph-files.mjs";
const jiti = createJiti(import.meta.url);
const { CodeGraphManager, defaultMcpHandshakeRunner, createCbmEnvironment } = await jiti.import("../src/code-graph-manager.ts");
const { resolveWorkbenchPaths } = await jiti.import("../src/paths.ts");
const { resolveCodeGraphProject } = await jiti.import("../src/code-graph-config.ts");
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "wb-cbm-contract-"));
  const paths = resolveWorkbenchPaths(root);
  const workspace = join(root, "workspace ü with spaces"); await mkdir(workspace);
  try { await fn({ root, paths, workspace, project: resolveCodeGraphProject(workspace, paths) }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
async function binary(root, config) {
  const path = join(root, "cbm.cjs");
  await writeFile(path, fakeCbmSource(config), { mode: 0o700 }); return path;
}
function probe(command, cwd) {
  return { command, cwd, args: [], env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: cwd }, timeoutMs: 2000, killGraceMs: 100 };
}

test("strict MCP accepts complete paginated tool names", () => fixture(async ({ root, workspace }) => {
  const command = await binary(root, { toolPageSize: 4 });
  const result = await defaultMcpHandshakeRunner()(probe(command, workspace));
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(result.tools, fakeCbmTools);
}));
for (const [label, config, error] of [
  ["same count with wrong names", { toolNames: [...fakeCbmTools.slice(0, -1), "invented_tool"] }, /tool-name/],
  ["duplicate names", { toolNames: [...fakeCbmTools.slice(0, -1), fakeCbmTools[0]] }, /duplicate/],
  ["repeated cursor", { toolPageSize: 4, cursorLoop: true }, /duplicate|cursor/],
  ["wrong backend version", { version: "0.8.1" }, /backend version/],
  ["newer backend version", { version: "0.99.0" }, /backend version/],
]) test(`strict MCP rejects ${label}`, () => fixture(async ({ root, workspace }) => {
  const command = await binary(root, config);
  const result = await defaultMcpHandshakeRunner()(probe(command, workspace));
  assert.equal(result.ok, false);
  assert.match(result.detail, error);
}));

test("CBM child environment binds owned namespace and workspace, ignores inherited overrides", () => {
  const source = { PATH: "/bin", HOME: "/home/example", CBM_RUNTIME_DIR: "/external", CBM_CACHE_DIR: "/wrong", CBM_ALLOWED_ROOT: "/", CBM_DOWNLOAD_URL: "https://bad" };
  const env = createCbmEnvironment({ projectDirectory: "/owned/cache", runtimeDirectory: "/owned/runtime", workspacePath: "/workspace/project", shimPath: "/owned/shim/curl", source });
  assert.equal(env.CBM_RUNTIME_DIR, "/owned/runtime"); assert.equal(env.CBM_CACHE_DIR, "/owned/cache");
  assert.equal(env.CBM_ALLOWED_ROOT, "/workspace/project"); assert.equal(env.CBM_DOWNLOAD_URL, undefined);
  assert.equal(source.CBM_RUNTIME_DIR, "/external");
});

async function seeded(fx, config) {
  const executable = await binary(fx.root, config);
  const identity = { version: "v0.12.1", resolvedUrl: "https://fixture.invalid/reviewed", sha256: "b".repeat(64) };
  await writeCodeGraphFiles(fx.project, identity);
  return new CodeGraphManager({ paths: fx.paths, ensureInstalled: async () => ({ ...identity, path: executable, reused: true }), registerMcp: () => {} });
}

test("project discovery follows pagination and ignores misleading first project", () => fixture(async (fx) => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ name: `other-${i}`, root_path: `/other/${i}` }));
  rows.push({ name: "exact-project", root_path: fx.project.projectPath });
  const manager = await seeded(fx, { projectRows: rows });
  assert.equal(await manager.fetchIndexSummary(fx.project, join(fx.root, "cbm.cjs")), "exact-project");
  const env = JSON.parse(manager.getMcpConfig(fx.project, { path: join(fx.root, "cbm.cjs"), version: "v0.12.1", resolvedUrl: "https://fixture.invalid/reviewed", sha256: "b".repeat(64) }).args[1]).env;
  assert.equal(env.CBM_RUNTIME_DIR, join(fx.paths.codeGraphIpc, createHash("sha256").update(fx.project.directory).digest("hex").slice(0, 16)));
}));
for (const [label, rows] of [
  ["ambiguous workspace", (path) => [{ name: "a", root_path: path }, { name: "b", root_path: path }]],
  ["string entries", () => ["old-project"]],
  ["unsafe names", (path) => [{ name: "../escape", root_path: path }]],
  ["wrong workspace", () => [{ name: "other", root_path: "/other" }]],
]) test(`project discovery rejects ${label}`, () => fixture(async (fx) => {
  const manager = await seeded(fx, { projectRows: rows(fx.project.projectPath) });
  assert.equal(await manager.fetchIndexSummary(fx.project, join(fx.root, "cbm.cjs")), null);
}));

// ── M14: failures after installation report their real kind, not "upgrade pending" ──
const { acquireManagedLock } = await jiti.import("../src/managed-lifecycle.ts");

async function seededWith(fx, deps) {
  const executable = await binary(fx.root, {});
  const identity = { version: "v0.12.1", resolvedUrl: "https://fixture.invalid/reviewed", sha256: "b".repeat(64) };
  await writeCodeGraphFiles(fx.project, identity, { index: true });
  return new CodeGraphManager({ paths: fx.paths, ensureInstalled: async () => ({ ...identity, path: executable, reused: true }), ...deps });
}

test("M14: a registration failure after install is mcp_failed with its own message", () => fixture(async (fx) => {
  const manager = await seededWith(fx, { registerMcp: () => { throw new Error("registration exploded"); } });
  const result = await manager.restore(fx.project);
  assert.equal(result.ok, false);
  assert.equal(result.kind, "mcp_failed", result.detail);
  assert.match(result.detail, /registration exploded/);
}));

test("M14: a busy project lock is reported as locked and keeps the lock path in the message", () => fixture(async (fx) => {
  const manager = await seededWith(fx, { registerMcp: () => {} });
  const coordination = join(fx.paths.codeGraphRuntime, "coordination");
  await mkdir(coordination, { recursive: true });
  const release = await acquireManagedLock(coordination, fx.project.identifier);
  try {
    const result = await manager.restore(fx.project);
    assert.equal(result.ok, false);
    assert.equal(result.kind, "locked");
    assert.notEqual(result.kind, "upgrade_pending");
    assert.match(result.detail, /lock/i);
  } finally { await release(); }
}));

// ── L1: only the two destructive tools are hidden; the tool-name contract still has all 17 ──
test("L1: delete_project and index_repository are the only hidden tools and remain in the 17-tool contract", () => fixture(async (fx) => {
  const { CODE_GRAPH_EXPECTED_TOOLS, CODE_GRAPH_HIDDEN_TOOLS } = await jiti.import("../src/code-graph-manager.ts");
  const manager = await seededWith(fx, { registerMcp: () => {} });
  const config = manager.getMcpConfig(fx.project, { path: join(fx.root, "cbm.cjs"), version: "v0.12.1", resolvedUrl: "https://fixture.invalid/reviewed", sha256: "b".repeat(64) });
  assert.deepEqual(Object.keys(config.toolExposure).sort(), ["delete_project", "index_repository"]);
  assert.ok(Object.values(config.toolExposure).every((value) => value === "hidden"));
  assert.equal(config.exposure, "direct");
  assert.equal(CODE_GRAPH_EXPECTED_TOOLS.length, 17);
  for (const name of CODE_GRAPH_HIDDEN_TOOLS) assert.ok(CODE_GRAPH_EXPECTED_TOOLS.includes(name));
}));

// ── M7: a same-name server from mcp.json blocks Code Graph registration ──
test("M7: Code Graph does not register when a conflict is reported, and says why", () => fixture(async (fx) => {
  const registered = [];
  const manager = await seededWith(fx, {
    registerMcp: (name, config) => registered.push({ name, config }),
    conflict: async () => 'same-name MCP declaration "codebase_memory" in /home/u/.pi/agent/mcp.json',
  });
  const result = await manager.restore(fx.project);
  assert.equal(result.ok, false);
  assert.match(result.detail, /codebase_memory.*mcp\.json|not registered/);
  assert.equal(registered.length, 0);
  assert.equal(manager.isMcpRegistered, false);
}));

// ── CG7: the launcher checks the identity file, never the opt-in ──
test("launcher marker is workbench-identity.json bound to the exact backend; a changed identity stops the server before it starts", () => fixture(async (fx) => {
  const { FixtureMcpClient } = await import("./helpers/mcp-client.mjs");
  const { readFile: read } = await import("node:fs/promises");
  const asset = { version: "v0.12.1", resolvedUrl: "https://fixture.invalid/reviewed", sha256: "b".repeat(64) };
  await mkdir(fx.paths.codeGraphBin, { recursive: true });
  const executable = join(fx.paths.codeGraphBin, "cbm.cjs");
  await writeFile(executable, fakeCbmSource({}), { mode: 0o700 });
  await writeCodeGraphFiles(fx.project, asset, { index: true });
  const manager = new CodeGraphManager({ paths: fx.paths, ensureInstalled: async () => ({ ...asset, path: executable, reused: true }), registerMcp: () => {} });
  const config = manager.getMcpConfig(fx.project, { ...asset, path: executable });
  const spec = JSON.parse(config.args[1]);
  assert.equal(spec.markerPath, fx.project.identityPath);
  assert.deepEqual(spec.expectedMarker, { codeGraphVersion: asset.version, resolvedUrl: asset.resolvedUrl, sha256: asset.sha256 });
  const clients = [];
  try {
    const good = new FixtureMcpClient(config, 10000); clients.push(good);
    await good.initialize();
    await good.close();
    const identity = JSON.parse(await read(fx.project.identityPath, "utf8"));
    await writeFile(fx.project.identityPath, JSON.stringify({ ...identity, sha256: "c".repeat(64) }), { mode: 0o600 });
    const bad = new FixtureMcpClient(config, 10000); clients.push(bad);
    await assert.rejects(bad.initialize(), /identity changed|exited/);
    assert.match(bad.stderr, /MCP data identity changed before child startup/);
  } finally { for (const client of clients) await client.close({ allowFailure: true }); }
}));
