import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const config = await jiti.import("../src/code-graph-config.ts");
const { resolveMemoryStore } = await jiti.import("../src/memory-config.ts");
const { otherVersionMessage } = await jiti.import("../src/store-identity.ts");
const {
  assertWithinRoot,
  canonicalWorkspacePath,
  codeGraphIdentity,
  formatCodeGraphStatus,
  isWithinPath,
  resolveCodeGraphProject,
  validateCodeGraphState,
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

const ASSET = {
  version: "v0.8.1",
  resolvedUrl: "https://github.com/DeusData/codebase-memory-mcp/releases/download/v0.8.1/codebase-memory-mcp-linux-arm64.tar.gz",
  sha256: "d2f842d1365da5c35d9c5796f57a821c9745267350994346735e1e6e04d46091",
};
function validOptIn(project, overrides = {}) {
  return { schemaVersion: 1, enabled: true, projectPath: project.projectPath, identifier: project.identifier, ...overrides };
}
function validIdentity(overrides = {}) {
  return { ...codeGraphIdentity(ASSET), ...overrides };
}
async function writeJson(path, value) { await writeFile(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 }); }
/** A project directory in the state `on` leaves behind: both files, `_config.db` and one index. */
async function seedEnabled(project) {
  await mkdir(project.directory, { recursive: true });
  await writeFile(join(project.directory, "_config.db"), "x");
  await writeFile(join(project.directory, "some-project.db"), "index-bytes");
  await writeJson(project.identityPath, validIdentity());
  await writeJson(project.optInPath, validOptIn(project));
}

async function seedProject(temp, name) {
  const projectDir = join(temp, name);
  await mkdir(projectDir, { recursive: true });
  const paths = tempPaths(temp);
  const project = resolveCodeGraphProject(projectDir, paths);
  return { temp, paths, project, projectDir };
}

test("project files: opt-in.json and workbench-identity.json inside the project directory; no state.json", async () => {
  const temp = await makeTemp("pi-cgm-files-");
  try {
    const { project } = await seedProject(temp, "workspace");
    assert.equal(project.optInPath, join(project.directory, "opt-in.json"));
    assert.equal(project.identityPath, join(project.directory, "workbench-identity.json"));
    assert.equal("statePath" in project, false);
    assert.deepEqual(validIdentity(), { schemaVersion: 1, layout: 1, kind: "code-graph", codeGraphVersion: "v0.8.1", resolvedUrl: ASSET.resolvedUrl, sha256: ASSET.sha256 });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("state validation: absent directory is plain off", async () => {
  const temp = await makeTemp("pi-cgm-off-");
  try {
    const { project } = await seedProject(temp, "workspace");
    const result = await validateCodeGraphState(project);
    assert.equal(result.ok, false);
    assert.equal(result.problem, "missing");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("state validation: both files, _config.db and an index make a workspace enabled", async () => {
  const temp = await makeTemp("pi-cgm-valid-");
  try {
    const { project } = await seedProject(temp, "workspace");
    await seedEnabled(project);
    const result = await validateCodeGraphState(project);
    assert.equal(result.ok, true);
    assert.deepEqual(result.identity, validIdentity());
    assert.deepEqual(result.indexDbs, ["some-project.db"]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("state validation: one failing case per problem code", async () => {
  const temp = await makeTemp("pi-cgm-corrupt-");
  try {
    const { project } = await seedProject(temp, "workspace");
    await seedEnabled(project);
    const optIns = [
      ["not valid json {", "read_error", /Cannot read project opt-in/],
      [validOptIn(project, { schemaVersion: 2 }), "read_error", /schemaVersion must be 1/],
      [validOptIn(project, { enabled: false }), "read_error", /Incompatible project opt-in/],
      [validOptIn(project, { extra: true }), "read_error", /Incompatible project opt-in/],
      [validOptIn(project, { projectPath: "/other" }), "wrong_workspace", /belongs to \/other/],
      [validOptIn(project, { identifier: "other-abc" }), "wrong_identifier", /other-abc/],
    ];
    for (const [value, problem, detail] of optIns) {
      await writeJson(project.optInPath, value);
      const result = await validateCodeGraphState(project);
      assert.equal(result.ok, false, JSON.stringify(value));
      assert.equal(result.problem, problem, JSON.stringify(value));
      assert.match(result.detail, detail);
    }
    await writeJson(project.optInPath, validOptIn(project));
    const identities = [
      [validIdentity({ schemaVersion: 2 }), "read_error", /schemaVersion must be 1/],
      [validIdentity({ kind: "memory" }), "read_error", /not a Code Graph identity/],
      [validIdentity({ layout: 2 }), "read_error", /not a Code Graph identity/],
      [{ ...validIdentity(), createdAt: "2026-01-01T00:00:00.000Z" }, "read_error", /not a Code Graph identity/],
      [validIdentity({ codeGraphVersion: "0.8.1" }), "invalid_asset_identity", /vMAJOR/],
      [validIdentity({ sha256: "zz" }), "invalid_asset_identity", /SHA-256/],
      [validIdentity({ resolvedUrl: "http://x" }), "invalid_asset_identity", /SHA-256/],
    ];
    for (const [value, problem, detail] of identities) {
      await writeJson(project.identityPath, value);
      const result = await validateCodeGraphState(project);
      assert.equal(result.problem, problem, JSON.stringify(value));
      assert.match(result.detail, detail);
    }
    await rm(project.identityPath);
    assert.equal((await validateCodeGraphState(project)).problem, "missing_identity");
    await writeJson(project.identityPath, validIdentity());
    await rm(join(project.directory, "_config.db"));
    assert.equal((await validateCodeGraphState(project)).problem, "missing_config_db");
    await writeFile(join(project.directory, "_config.db"), "x");
    await rm(join(project.directory, "some-project.db"));
    assert.equal((await validateCodeGraphState(project)).problem, "missing_index_db");
    await rm(project.optInPath);
    assert.equal((await validateCodeGraphState(project)).problem, "missing");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("state validation: an unsafe opt-in file is refused, not read", async () => {
  const temp = await makeTemp("pi-cgm-unsafe-");
  try {
    const { project } = await seedProject(temp, "workspace");
    await seedEnabled(project);
    await chmod(project.optInPath, 0o644);
    const result = await validateCodeGraphState(project);
    assert.equal(result.problem, "read_error");
    assert.match(result.detail, /Unsafe project opt-in file/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("state validation: a directory holding only a leftover state.json is off, not enabled", async () => {
  const temp = await makeTemp("pi-cgm-leftover-");
  try {
    const { project } = await seedProject(temp, "workspace");
    await mkdir(project.directory, { recursive: true });
    await writeJson(join(project.directory, "state.json"), { schema: 1 });
    assert.equal((await validateCodeGraphState(project)).problem, "missing");
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
    const result = await validateCodeGraphState(project);
    assert.equal(result.ok, false);
    assert.equal(result.problem, "not_a_directory");
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
  const kinds = ["off", "enabled", "corrupt", "upgrade_pending"];
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
    indexSummary: "ready (p)",
    watcher: "git",
  });
  assert.ok(enabled.join("\n").includes("Git watcher enabled"));
  const nonGit = formatCodeGraphStatus({ ...base, kind: "off", watcher: "disabled_non_git" });
  assert.ok(nonGit.join("\n").includes("disabled (non-Git workspace)"));
});

test("status uses the shared layout, and a refused identity shows the shared refusal reason", () => {
  const base = {
    workspacePath: "/work/acme",
    identifier: "acme-0123456789abcdef",
    projectDirectory: tmpdir(),
    platform: "linux-arm64",
    manifestVersion: "v0.8.1",
  };
  const on = formatCodeGraphStatus({ ...base, kind: "enabled", installedVersion: "v0.8.1", mcpRegistered: true }).join("\n");
  assert.match(on, /^Code Graph\n {2}State: {4}on\n {2}Project: {2}\/work\/acme {2}\(acme-0123456789abcdef\)\n {2}Data: {5}/);
  assert.match(on, /Version: {2}v0\.8\.1 \(expected v0\.8\.1\)/);
  assert.match(on, /Link: {5}registered/);
  assert.doesNotMatch(on, /Problem:/);
  const refused = formatCodeGraphStatus({ ...base, kind: "upgrade_pending", recovery: otherVersionMessage("Code Graph") }).join("\n");
  assert.match(refused, /State: {4}refused \(data written by another version\)/);
  assert.ok(refused.includes(`Problem:  ${otherVersionMessage("Code Graph")}`));
  const gone = formatCodeGraphStatus({ ...base, projectDirectory: join(tmpdir(), "no-such-code-graph-dir"), kind: "off" }).join("\n");
  assert.match(gone, /Data: {5}none/);
  assert.match(gone, /Version: {2}not installed/);
});

test("sameBackend compares version, URL and SHA-256", () => {
  const identity = { codeGraphVersion: "v1", resolvedUrl: "https://example.invalid/a.tar.gz", sha256: "a".repeat(64) };
  const binary = { version: "v1", resolvedUrl: identity.resolvedUrl, sha256: identity.sha256 };
  assert.equal(config.sameBackend(identity, binary), true);
  for (const changed of [{ version: "v2" }, { resolvedUrl: "https://example.invalid/b.tar.gz" }, { sha256: "b".repeat(64) }]) {
    assert.equal(config.sameBackend(identity, { ...binary, ...changed }), false, JSON.stringify(changed));
  }
});
