import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { resolveWorkbenchPaths } = await jiti.import("../src/paths.ts");

test("resolveWorkbenchPaths: keeps all managed data below dedicated Workbench root", () => {
  const home = "/tmp/pi-workbench-home";
  const paths = resolveWorkbenchPaths(home);
  const root = join(home, ".pi", "pi-workbench");

  assert.equal(paths.root, root);
  assert.equal(paths.headroomVenv, join(root, "headroom-venv"));
  assert.equal(paths.headroomVenvLock, join(root, "headroom-venv.lock"));
  assert.equal(paths.headroomMemory, join(root, "headroom-memory"));
  assert.equal(paths.headroomConfig, join(root, "headroom.json"));
});

test("resolveWorkbenchPaths: keeps all code graph data below the codebase-memory-mcp root", () => {
  const home = "/tmp/pi-workbench-home";
  const paths = resolveWorkbenchPaths(home);
  const root = join(home, ".pi", "pi-workbench", "codebase-memory-mcp");

  assert.equal(paths.codeGraphRoot, root);
  assert.equal(paths.codeGraphBin, join(root, "bin"));
  assert.equal(paths.codeGraphDownloads, join(root, "downloads"));
  assert.equal(paths.codeGraphProjects, join(root, "projects"));
  assert.equal(paths.codeGraphInstallLock, join(root, "install.lock"));
  assert.equal(paths.codeGraphCurlShim, join(root, "deny-shims", "curl"));
  for (const [key, value] of Object.entries(paths)) {
    if (key.startsWith("legacy")) continue;
    assert.ok(!value.startsWith(join(home, ".pi", "headroom-")), `managed path must not reuse legacy prefix: ${key}=${value}`);
  }
});

test("resolveWorkbenchPaths: exposes legacy locations only outside active managed paths", () => {
  const home = "/tmp/pi-workbench-home";
  const paths = resolveWorkbenchPaths(home);

  assert.equal(paths.legacyHeadroomVenv, join(home, ".pi", "headroom-venv"));
  assert.equal(paths.legacyHeadroomVenvLock, join(home, ".pi", "headroom-venv.lock"));
  assert.equal(paths.legacyHeadroomMemory, join(home, ".pi", "headroom-memory"));
  assert.notEqual(paths.headroomVenv, paths.legacyHeadroomVenv);
  assert.notEqual(paths.headroomVenvLock, paths.legacyHeadroomVenvLock);
  assert.notEqual(paths.headroomMemory, paths.legacyHeadroomMemory);
});
