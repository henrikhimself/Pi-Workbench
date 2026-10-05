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
