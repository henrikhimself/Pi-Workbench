import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { resolveWorkbenchPaths } = await jiti.import("../src/paths.ts");
const { compressionOptedIn, resolveCompressionProject, setCompressionOptIn } = await jiti.import("../src/headroom-project.ts");

async function fixture(action) {
  const home = await mkdtemp(join(tmpdir(), "wb-compression-intent-"));
  try { await action(home, resolveWorkbenchPaths(home)); }
  finally { await rm(home, { recursive: true, force: true }); }
}

test("compression absent opt-in and off are read-only; state is per canonical workspace", async () => fixture(async (home, paths) => {
  const a = resolveCompressionProject(join(home, "a"), paths), b = resolveCompressionProject(join(home, "b"), paths);
  assert.notEqual(a.statePath, b.statePath);
  assert.equal(await compressionOptedIn(a), false);
  await setCompressionOptIn(a, false);
  assert.equal(existsSync(paths.root), false, "off must not create managed storage");
  await mkdir(join(home, "a"));
  await symlink(join(home, "a"), join(home, "alias"), "dir");
  assert.equal(resolveCompressionProject(join(home, "alias"), paths).statePath, a.statePath);
  await setCompressionOptIn(a, true);
  assert.equal(await compressionOptedIn(a), true);
  assert.equal(await compressionOptedIn(b), false);
  await setCompressionOptIn(a, false);
  assert.equal(await compressionOptedIn(a), false);
}));

test("compression intent survives fresh resolution, serializes peers and never changes Memory", async () => fixture(async (home, paths) => {
  const project = resolveCompressionProject(home, paths);
  const memory = join(paths.headroomMemory, "projects", project.identifier, "memory.db");
  await mkdir(dirname(memory), { recursive: true, mode: 0o700 }); await writeFile(memory, "untouched fixture");
  await Promise.all([setCompressionOptIn(project, true), setCompressionOptIn(project, true)]);
  assert.equal(await compressionOptedIn(resolveCompressionProject(home, paths)), true);
  await setCompressionOptIn(project, false);
  assert.equal(await readFile(memory, "utf8"), "untouched fixture");
}));

test("compression missing opt-in under symlinked root stays quiet; explicit on rejects root", async () => fixture(async (home, paths) => {
  const target = join(home, "owned-target"); await mkdir(target);
  await mkdir(dirname(paths.root), { recursive: true }); await symlink(target, paths.root, "dir");
  const project = resolveCompressionProject(home, paths);
  assert.equal(await compressionOptedIn(project), false);
  await setCompressionOptIn(project, false);
  await assert.rejects(setCompressionOptIn(project, true), /Symlink in managed path/);
  assert.equal(existsSync(join(target, "headroom")), false);
}));

for (const fault of ["malformed", "wrong workspace", "unknown schema", "false marker", "unsafe permissions", "symlink"]) {
  test(`compression ${fault} state fails closed without rewriting`, async () => fixture(async (home, paths) => {
    const project = resolveCompressionProject(home, paths);
    await setCompressionOptIn(project, true);
    const original = JSON.parse(await readFile(project.statePath, "utf8"));
    if (fault === "malformed") await writeFile(project.statePath, "not-json");
    if (fault === "wrong workspace") await writeFile(project.statePath, JSON.stringify({ ...original, projectPath: home + "-other" }));
    if (fault === "unknown schema") await writeFile(project.statePath, JSON.stringify({ ...original, schemaVersion: 99 }));
    if (fault === "false marker") await writeFile(project.statePath, JSON.stringify({ ...original, enabled: false }));
    if (fault === "unsafe permissions") await chmod(project.statePath, 0o644);
    if (fault === "symlink") {
      await rm(project.statePath);
      const target = join(home, "unrelated.json"); await writeFile(target, JSON.stringify(original));
      await symlink(target, project.statePath);
    }
    const before = await readFile(project.statePath, "utf8");
    await assert.rejects(compressionOptedIn(project));
    await assert.rejects(setCompressionOptIn(project, true));
    await assert.rejects(setCompressionOptIn(project, false));
    assert.equal(await readFile(project.statePath, "utf8"), before);
  }));
}

test("compression cancelled intent creates nothing", async () => fixture(async (home, paths) => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(setCompressionOptIn(resolveCompressionProject(home, paths), true, controller.signal), /abort/i);
  assert.equal(existsSync(paths.root), false);
}));
