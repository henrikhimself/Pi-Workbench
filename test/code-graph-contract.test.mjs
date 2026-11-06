import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { createJiti } from "jiti";
import { fakeCbmSource, fakeCbmTools } from "./helpers/fake-cbm.mjs";
const jiti = createJiti(import.meta.url);
const { CodeGraphManager, defaultMcpHandshakeRunner, createCbmEnvironment } = await jiti.import("../src/code-graph-manager.ts");
const { resolveWorkbenchPaths } = await jiti.import("../src/paths.ts");
const { resolveCodeGraphProject, createCodeGraphState } = await jiti.import("../src/code-graph-config.ts");
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
  return { command, cwd, args: [], env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: cwd }, expectedToolCount: 17, timeoutMs: 2000, killGraceMs: 100 };
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
  await mkdir(fx.project.directory, { recursive: true });
  await writeFile(fx.project.statePath, JSON.stringify(createCodeGraphState(fx.project, identity)));
  await writeFile(join(fx.project.directory, "_config.db"), "auto_index = true\n");
  return new CodeGraphManager({ paths: fx.paths, ensureInstalled: async () => ({ ...identity, path: executable, reused: true }), registerMcp: () => {} });
}

test("project discovery follows pagination and ignores misleading first project", () => fixture(async (fx) => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ name: `other-${i}`, root_path: `/other/${i}` }));
  rows.push({ name: "exact-project", root_path: fx.project.projectPath });
  const manager = await seeded(fx, { projectRows: rows });
  assert.equal(await manager.fetchIndexSummary(fx.project, join(fx.root, "cbm.cjs")), "exact-project");
  const env = manager.getMcpConfig(fx.project, join(fx.root, "cbm.cjs")).env;
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
