import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, open, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { hasMemoryStore, parseMemoryNamespace, resolveMemoryExportDirectory, resolveMemoryRoot, resolveMemoryStore } = await jiti.import("../src/memory-config.ts");

test("resolveMemoryStore: projects receive stable isolated paths", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-headroom-memory-config-"));
  const root = join(tempDir, "memory-root");
  const projectOne = join(tempDir, "project one");
  const projectTwo = join(tempDir, "project-two");
  await Promise.all([mkdir(projectOne), mkdir(projectTwo)]);

  try {
    const first = resolveMemoryStore({ cwd: projectOne, root, userId: "tester" });
    const again = resolveMemoryStore({ cwd: projectOne, root, userId: "tester" });
    const second = resolveMemoryStore({ cwd: projectTwo, root, userId: "tester" });

    assert.equal(first.databasePath, again.databasePath);
    assert.notEqual(first.databasePath, second.databasePath);
    assert.match(first.identifier, /^project-one-[a-f0-9]{16}$/);
    assert.equal(hasMemoryStore(first), false);

    await mkdir(first.directory, { recursive: true });
    const handle = await open(first.databasePath, "a");
    await handle.close();
    assert.equal(hasMemoryStore(first), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveMemoryStore: permits and identifies configured root inside project", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-headroom-memory-root-"));
  const project = join(tempDir, "project");
  const rootInsideProject = join(project, "memory");
  await mkdir(project);

  try {
    const store = resolveMemoryStore({ cwd: project, root: rootInsideProject, userId: "tester" });
    assert.equal(store.rootConfigured, true);
    assert.equal(store.rootInsideProject, true);
    assert.equal(store.directory, join(rootInsideProject, "projects", store.identifier));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Memory configuration: resolves project-contained export directory", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-headroom-memory-export-"));
  const project = join(tempDir, "project");
  const outside = join(tempDir, "outside");
  await Promise.all([mkdir(project), mkdir(outside)]);

  try {
    assert.equal(resolveMemoryExportDirectory(project, ".headroom-memory"), join(project, ".headroom-memory"));
    assert.throws(() => resolveMemoryExportDirectory(project, "../outside"), /must resolve below project root/);
    assert.throws(() => resolveMemoryExportDirectory(project, outside), /must be a project-relative path/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Memory configuration: validates root and namespace values", () => {
  assert.throws(() => resolveMemoryRoot("relative-memory"), /headroom\.json memoryRoot must be an absolute path/);
  assert.equal(parseMemoryNamespace(undefined), "project");
  assert.throws(() => parseMemoryNamespace(""), /headroom\.json memoryNamespace must be a non-empty single-line value/);
  assert.throws(() => parseMemoryNamespace("line\nbreak"), /headroom\.json memoryNamespace must be a non-empty single-line value/);
  assert.equal(parseMemoryNamespace("test-namespace"), "test-namespace");
  assert.equal(resolveMemoryRoot(), join(homedir(), ".pi", "pi-workbench", "headroom-memory"));
});
