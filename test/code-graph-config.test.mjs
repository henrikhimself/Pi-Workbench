import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, rename as fsRename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const config = await jiti.import("../src/code-graph-config.ts");
const { resolveMemoryStore } = await jiti.import("../src/memory-config.ts");
const {
  CODE_GRAPH_STATE_SCHEMA,
  assertWithinRoot,
  canonicalWorkspacePath,
  createCodeGraphState,
  formatCodeGraphStatus,
  isWithinPath,
  parseCodeGraphState,
  resolveCodeGraphProject,
  validateCodeGraphState,
  writeCodeGraphStateAtomic,
} = config;

async function makeTemp(name) {
  const dir = await mkdtemp(join(tmpdir(), name));
  return dir;
}

function tempPaths(root) {
  return {
    codeGraphRoot: join(root, "codebase-memory-mcp"),
    codeGraphProjects: join(root, "codebase-memory-mcp", "projects"),
  };
}

test("workspace identity: stable, canonical, and collision-safe", async () => {
  const temp = await makeTemp("pi-cgm-identity-");
  try {
    const projectA = await mkdir(join(temp, "acme api"), { recursive: true });
    const projectB = await mkdir(join(temp, "nested", "acme api"), { recursive: true });
    const alias = join(temp, "alias");
    await symlink(projectA, alias);

    const paths = tempPaths(temp);
    const a = resolveCodeGraphProject(projectA, paths);
    const aAgain = resolveCodeGraphProject(projectA, paths);
    const viaSymlink = resolveCodeGraphProject(alias, paths);
    const b = resolveCodeGraphProject(projectB, paths);

    assert.equal(a.identifier, aAgain.identifier);
    assert.equal(viaSymlink.identifier, a.identifier, "symlink alias must map to the same identity");
    assert.equal(viaSymlink.projectPath, a.projectPath);
    assert.notEqual(b.identifier, a.identifier, "same basename in another tree must not collide");
    assert.match(a.identifier, /^acme-api-[0-9a-f]{16}$/);
    assert.equal(a.statePath, join(a.directory, "state.json"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("workspace identifier matches Headroom Memory resolveMemoryStore semantics", () => {
  const store = resolveMemoryStore({ cwd: "/work/Acme API" });
  const project = resolveCodeGraphProject("/work/Acme API");
  assert.equal(project.identifier, store.identifier);
  assert.notEqual(project.directory, store.directory, "code graph must not share the Memory data root");
});

test("identity sanitizes hostile basenames and keeps hash suffix", () => {
  // Dots survive sanitization (mirrors memory-config), so a fully-invalid
  // basename falls back to `project`; the 16-hex path suffix always remains.
  const dots = resolveCodeGraphProject("/work/...");
  assert.match(dots.identifier, /^\.{3}-[0-9a-f]{16}$/);
  const invalid = resolveCodeGraphProject("/work/!!!");
  assert.match(invalid.identifier, /^project-[0-9a-f]{16}$/);
  const spaced = resolveCodeGraphProject("/work/A  B");
  assert.match(spaced.identifier, /^A--B-[0-9a-f]{16}$/);
});

test("canonicalWorkspacePath resolves symlinks and tolerates missing paths", async () => {
  const temp = await makeTemp("pi-cgm-canonical-");
  try {
    const real = await mkdir(join(temp, "real"), { recursive: true });
    const link = join(temp, "link");
    await symlink(real, link);
    assert.equal(canonicalWorkspacePath(link), canonicalWorkspacePath(real));
    assert.equal(canonicalWorkspacePath(join(temp, "does-not-exist")), join(temp, "does-not-exist"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("path containment helpers reject escapes", () => {
  const root = "/tmp/root";
  assert.ok(isWithinPath(join(root, "a", "b"), root));
  assert.ok(isWithinPath(root, root));
  assert.ok(!isWithinPath(join(root, "..", "x"), root));
  assert.ok(!isWithinPath("/etc/passwd", root));
  assert.ok(!isWithinPath("C:\\other", root));
  assert.equal(assertWithinRoot(join(root, "x"), root), join(root, "x"));
  assert.throws(() => assertWithinRoot(join(root, "..", "evil"), root), /outside managed root/);
});

function validState(project, overrides = {}) {
  return {
    schema: CODE_GRAPH_STATE_SCHEMA,
    workspacePath: project.projectPath,
    identifier: project.identifier,
    version: "v0.8.1",
    resolvedUrl: "https://github.com/DeusData/codebase-memory-mcp/releases/download/v0.8.1/codebase-memory-mcp-linux-arm64.tar.gz",
    sha256: "d2f842d1365da5c35d9c5796f57a821c9745267350994346735e1e6e04d46091",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

async function seedProject(temp, name) {
  const projectDir = join(temp, name);
  await mkdir(projectDir, { recursive: true });
  const paths = tempPaths(temp);
  const project = resolveCodeGraphProject(projectDir, paths);
  return { temp, paths, project, projectDir };
}

test("state validation: absent directory is plain off", async () => {
  const temp = await makeTemp("pi-cgm-off-");
  try {
    const { project } = await seedProject(temp, "workspace");
    const result = validateCodeGraphState(project);
    assert.equal(result.ok, false);
    assert.equal(result.problem, "missing");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("state validation: full valid state is enabled", async () => {
  const temp = await makeTemp("pi-cgm-valid-");
  try {
    const { project } = await seedProject(temp, "workspace");
    await mkdir(project.directory, { recursive: true });
    await writeFile(join(project.directory, "_config.db"), Buffer.from([0x53, 0x51, 0x4c]));
    await writeFile(join(project.directory, "some-project.db"), "index-bytes");
    await writeFile(project.statePath, JSON.stringify(validState(project)));

    const result = validateCodeGraphState(project);
    assert.equal(result.ok, true);
    assert.equal(result.state.identifier, project.identifier);
    assert.deepEqual(result.indexDbs, ["some-project.db"]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("state validation: corrupt and mismatched states stay off with reasons", async () => {
  const temp = await makeTemp("pi-cgm-corrupt-");
  try {
    const { project } = await seedProject(temp, "workspace");
    await mkdir(project.directory, { recursive: true });
    await writeFile(join(project.directory, "_config.db"), "x");
    await writeFile(join(project.directory, "idx.db"), "x");

    const cases = [
      ["not valid json {", "malformed_json"],
      [JSON.stringify(validState(project, { schema: 99 })), "unknown_schema"],
      [JSON.stringify(validState(project, { workspacePath: "/other" })), "wrong_workspace"],
      [JSON.stringify(validState(project, { identifier: "other-abc" })), "wrong_identifier"],
      [JSON.stringify(validState(project, { version: "0.8.1" })), "invalid_asset_identity"],
      [JSON.stringify(validState(project, { sha256: "zz" })), "invalid_asset_identity"],
      [JSON.stringify(validState(project, { createdAt: "yesterday" })), "invalid_timestamps"],
    ];
    for (const [raw, problem] of cases) {
      await writeFile(project.statePath, raw);
      const result = validateCodeGraphState(project);
      assert.equal(result.ok, false, raw);
      assert.equal(result.problem, problem, raw);
    }

    await writeFile(project.statePath, JSON.stringify(validState(project)));
    await rm(join(project.directory, "_config.db"));
    assert.equal(validateCodeGraphState(project).problem, "missing_config_db");
    await writeFile(join(project.directory, "_config.db"), "x");
    await rm(join(project.directory, "idx.db"));
    assert.equal(validateCodeGraphState(project).problem, "missing_index_db");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("state validation: a stray file instead of the project directory is not_a_directory", async () => {
  const temp = await makeTemp("pi-cgm-file-");
  try {
    const projectDir = join(temp, "workspace");
    await mkdir(projectDir, { recursive: true });
    const project = resolveCodeGraphProject(projectDir, tempPaths(temp));
    // projects/<id> path exists as a regular file, not a directory
    await mkdir(join(temp, "codebase-memory-mcp", "projects"), { recursive: true });
    await writeFile(project.directory, "nope");
    const result = validateCodeGraphState(project);
    assert.equal(result.ok, false);
    assert.equal(result.problem, "not_a_directory");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("state write: staged temp file is renamed into state.json and fsynced", async () => {
  const temp = await makeTemp("pi-cgm-atomic-");
  try {
    const { project } = await seedProject(temp, "workspace");
    await mkdir(project.directory, { recursive: true });
    const state = createCodeGraphState(project, {
      version: "v0.8.1",
      resolvedUrl: "https://github.com/DeusData/codebase-memory-mcp/releases/download/v0.8.1/codebase-memory-mcp-linux-arm64.tar.gz",
      sha256: "d2f842d1365da5c35d9c5796f57a821c9745267350994346735e1e6e04d46091",
    }, () => new Date("2026-02-03T04:05:06.000Z"));

    const writes = [];
    await writeCodeGraphStateAtomic(project, state, {
      rename: async (from, to) => {
        writes.push({ from, to });
        await fsRename(from, to);
      },
    });

    assert.equal(writes.length, 1);
    assert.equal(writes[0].to, project.statePath);
    assert.ok(writes[0].from.startsWith(project.statePath + "."), "temp file must live beside state.json");
    assert.equal(existsSync(writes[0].from), false, "temp file must be renamed away");
    const parsed = parseCodeGraphState(await readFile(project.statePath));
    assert.deepEqual(parsed, state);
    const listing = await readdir(project.directory);
    assert.equal(listing.filter((name) => name.includes(".tmp")).length, 0);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("state write: rename failure cleans up the temp file and leaves no marker", async () => {
  const temp = await makeTemp("pi-cgm-atomicfail-");
  try {
    const { project } = await seedProject(temp, "workspace");
    await mkdir(project.directory, { recursive: true });
    const state = createCodeGraphState(project, {
      version: "v0.8.1",
      resolvedUrl: "https://example.invalid/x",
      sha256: "d2f842d1365da5c35d9c5796f57a821c9745267350994346735e1e6e04d46091",
    });
    await assert.rejects(
      writeCodeGraphStateAtomic(project, state, {
        rename: async () => {
          throw new Error("disk full");
        },
      }),
      /disk full/,
    );
    assert.equal(existsSync(project.statePath), false);
    const listing = await readdir(project.directory);
    assert.equal(listing.length, 0);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("status formatting covers every state kind without leaking internals", () => {
  const base = {
    workspacePath: "/work/acme",
    identifier: "acme-0123456789abcdef",
    projectDirectory: "/root/projects/acme-0123456789abcdef",
    platform: "linux-arm64",
    manifestVersion: "v0.8.1",
  };
  const kinds = ["off", "enabled", "corrupt", "unsupported_platform", "binary_missing", "binary_incompatible", "index_missing", "mcp_failed", "deletion_failed"];
  for (const kind of kinds) {
    const lines = formatCodeGraphStatus({ ...base, kind });
    assert.ok(lines[0].includes("Code Graph"));
    assert.ok(lines.some((line) => line.includes("State:")));
  }
  const enabled = formatCodeGraphStatus({
    ...base,
    kind: "enabled",
    installedVersion: "v0.8.1",
    mcpRegistered: true,
    indexSummary: "12 nodes, 40 edges",
    watcher: "git",
  });
  assert.ok(enabled.join("\n").includes("Git watcher enabled"));
  const nonGit = formatCodeGraphStatus({ ...base, kind: "off", watcher: "disabled_non_git" });
  assert.ok(nonGit.join("\n").includes("disabled (non-Git workspace)"));
});
