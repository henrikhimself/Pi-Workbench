import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createJiti } from "jiti";
const { resolveWorkbenchPaths } = await createJiti(import.meta.url).import("../src/paths.ts");
test("managed Headroom layout is fresh, versioned and below canonical Workbench root", () => {
  const paths = resolveWorkbenchPaths("/tmp/workbench-home");
  const root = join("/tmp/workbench-home", ".pi", "pi-workbench");
  assert.equal(paths.root, root);
  assert.equal(paths.headroomRoot, join(root, "headroom", "v1"));
  assert.equal(paths.headroomMemory, join(root, "headroom", "v1", "memory"));
  assert.equal(paths.headroomConfig, join(root, "headroom.json"));
  assert.equal(Object.keys(paths).some(key => /legacy|headroomVenv/.test(key)), false);
});
test("Code Graph keeps distinct managed artifacts, projects and runtime namespaces", () => {
  const paths = resolveWorkbenchPaths("/tmp/workbench-home");
  const root = join(paths.root, "codebase-memory-mcp");
  assert.equal(paths.codeGraphRoot, root);
  assert.equal(paths.codeGraphIpc, join(paths.root, "g"));
  for (const [field, suffix] of [["codeGraphBin","bin"],["codeGraphDownloads","downloads"],["codeGraphProjects","projects"],["codeGraphRuntime","runtime"],["codeGraphInstallLock","coordination/install.lock"],["codeGraphCurlShim","deny-shims/curl"]]) {
    assert.equal(paths[field], join(root, suffix));
  }
  for (const value of Object.values(paths)) assert.ok(value.startsWith(paths.root));
});
