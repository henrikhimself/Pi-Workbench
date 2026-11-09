import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createJiti } from "jiti";

const execFile = promisify(execFileCallback);
const jiti = createJiti(import.meta.url);
const { configureMemoryGit, MEMORY_MERGE_DRIVER } = await jiti.import("../src/memory-git.ts");

async function git(cwd, ...args) {
  return execFile("git", args, { cwd });
}

test("Memory Git setup adds only managed attribute block and preserves existing driver", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workbench-memory-git-"));
  try {
    await git(root, "init");
    await writeFile(join(root, ".gitattributes"), "*.bin filter=lfs\n");
    await git(root, "config", "--local", "merge.theirs.driver", "user-owned-driver");

    assert.equal(await configureMemoryGit(root, join(root, ".headroom-memory")), null);
    assert.equal(await configureMemoryGit(root, join(root, ".headroom-memory")), null);

    const attributes = await readFile(join(root, ".gitattributes"), "utf8");
    assert.match(attributes, /^\*\.bin filter=lfs/m);
    assert.equal((attributes.match(/>>> pi-workbench Headroom Memory/g) ?? []).length, 1);
    for (const member of ["manifest.json", "memories/**", "entities/**", "relationships/**"]) {
      assert.ok(attributes.includes(`.headroom-memory/${member} merge=pi-workbench-theirs\n`), member);
    }
    assert.doesNotMatch(attributes, /\.headroom-memory\/\*\* /);
    assert.doesNotMatch(attributes, /merge=theirs/);
    const { stdout } = await git(root, "config", "--local", "--get", "merge.theirs.driver");
    assert.equal(stdout.trim(), "user-owned-driver", "a user's own `theirs` driver is neither reused nor overwritten");
    const own = await git(root, "config", "--local", "--get", "merge.pi-workbench-theirs.driver");
    assert.match(own.stdout, /memory-merge-theirs\.mjs" %A %B/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Memory Git setup warns when export is outside worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workbench-memory-git-outside-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-workbench-memory-outside-"));
  try {
    await git(root, "init");
    const warning = await configureMemoryGit(root, outside);
    assert.match(warning, /outside Git worktree/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

// ── L13: the driver command follows the current Node and extension paths; legacy blocks migrate ──
test("L13: a stale driver command is rewritten, an up-to-date one is left alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workbench-memory-git-stale-"));
  try {
    await git(root, "init");
    const exportDirectory = join(root, ".headroom-memory");
    const key = `merge.${MEMORY_MERGE_DRIVER}.driver`;
    await git(root, "config", "--local", key, '"/old/node/bin/node" "/old/ext/memory-merge-theirs.mjs" %A %B');
    assert.equal(await configureMemoryGit(root, exportDirectory), null);
    const fresh = (await git(root, "config", "--local", "--get", key)).stdout.trim();
    assert.ok(fresh.startsWith(`"${process.execPath}" `), fresh);
    assert.doesNotMatch(fresh, /\/old\//);
    assert.equal(await configureMemoryGit(root, exportDirectory), null);
    assert.equal((await git(root, "config", "--local", "--get-all", key)).stdout.trim(), fresh, "idempotent, one value");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("L13: an attribute block written by an earlier version (merge=theirs) is migrated to the Workbench driver", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workbench-memory-git-legacy-"));
  try {
    await git(root, "init");
    await writeFile(join(root, ".gitattributes"), "*.bin filter=lfs\n# >>> pi-workbench Headroom Memory >>>\n.headroom-memory/** merge=theirs\n# <<< pi-workbench Headroom Memory <<<\n");
    assert.equal(await configureMemoryGit(root, join(root, ".headroom-memory")), null);
    const attributes = await readFile(join(root, ".gitattributes"), "utf8");
    assert.match(attributes, /^\*\.bin filter=lfs/m);
    for (const member of ["manifest.json", "memories/**", "entities/**", "relationships/**"]) {
      assert.ok(attributes.includes(`.headroom-memory/${member} merge=pi-workbench-theirs`), member);
    }
    assert.doesNotMatch(attributes, /\.headroom-memory\/\*\* /);
    assert.doesNotMatch(attributes, /merge=theirs/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ── M8: a bundle merged by git must be usable by merge/import ──
const BUNDLE_SCRIPT = join(process.cwd(), "src", "memory-bundle.py");
const canonicalJson = value => `${JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1)))}\n`;
async function writeRecords(bundle, records, { manifest = true } = {}) {
  await mkdir(join(bundle, "memories"), { recursive: true });
  await mkdir(join(bundle, "entities"), { recursive: true });
  await mkdir(join(bundle, "relationships"), { recursive: true });
  const files = [];
  for (const [id, content] of Object.entries(records)) {
    const payload = canonicalJson({ id, user_id: "tester", content });
    await writeFile(join(bundle, "memories", `${id}.json`), payload);
    files.push({ path: `memories/${id}.json`, sha256: createHash("sha256").update(payload).digest("hex") });
  }
  if (manifest) await writeFile(join(bundle, "manifest.json"), canonicalJson({ version: 1, namespace: "tester", files: files.sort((a, b) => a.path < b.path ? -1 : 1) }));
}
const validate = (store, bundle, ...extra) => execFile("python3", [BUNDLE_SCRIPT, "validate", "--store", store, "--bundle", bundle, "--namespace", "tester", ...extra]);
async function gitMergeFixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "pi-workbench-memory-merge-"));
  const commit = (message) => git(root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qam", message);
  try {
    await git(root, "init", "-q", "-b", "main");
    const bundle = join(root, ".headroom-memory");
    assert.equal(await configureMemoryGit(root, bundle), null);
    await writeRecords(bundle, { a: "base" });
    await git(root, "add", "-A"); await commit("base");
    await fn({ root, bundle, git: (...args) => git(root, ...args), commit });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("M8: two branches that add different records merge into a bundle that merge/import accept", async () => {
  await gitMergeFixture(async ({ root, bundle, git, commit }) => {
    await git("checkout", "-q", "-b", "left");
    await writeRecords(bundle, { a: "base", x: "from left" }); await git("add", "-A"); await commit("left");
    await git("checkout", "-q", "main");
    await git("checkout", "-q", "-b", "right");
    await writeRecords(bundle, { a: "base", y: "from right" }); await git("add", "-A"); await commit("right");
    await git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "merge", "-q", "--no-edit", "left");
    await assert.rejects(validate(root, bundle), /unlisted or missing owned files/, "strict validation still rejects the stale manifest");
    const merged = JSON.parse((await validate(root, bundle, "--derive-manifest")).stdout);
    assert.deepEqual(merged, { entities: 0, memories: 3, relationships: 0 });
  });
});

test("M8: a record changed on one side and a record added on the other no longer fails with a checksum mismatch", async () => {
  await gitMergeFixture(async ({ root, bundle, git, commit }) => {
    await git("checkout", "-q", "-b", "left");
    await writeRecords(bundle, { a: "changed on left" }); await git("add", "-A"); await commit("left");
    await git("checkout", "-q", "main");
    await git("checkout", "-q", "-b", "right");
    await writeRecords(bundle, { a: "base", y: "from right" }); await git("add", "-A"); await commit("right");
    await git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "merge", "-q", "--no-edit", "left");
    assert.equal(JSON.parse(await readFile(join(bundle, "memories", "a.json"), "utf8")).content, "changed on left");
    await assert.rejects(validate(root, bundle), /checksum mismatch|unlisted or missing/);
    assert.equal(JSON.parse((await validate(root, bundle, "--derive-manifest")).stdout).memories, 2);
  });
});

test("M8: derived mode keeps every per-record check and rejects stray owned files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-workbench-memory-derive-"));
  const bundle = join(dir, "bundle");
  try {
    await writeRecords(bundle, { a: "ok" });
    await writeFile(join(bundle, "memories", "stray.txt"), "x");
    await assert.rejects(validate(dir, bundle, "--derive-manifest"), /unlisted or missing owned files/);
    await rm(join(bundle, "memories", "stray.txt"));
    await writeFile(join(bundle, "memories", "a.json"), JSON.stringify({ id: "a", user_id: "tester", content: "not canonical" }, null, 2));
    await assert.rejects(validate(dir, bundle, "--derive-manifest"), /not canonical JSON/);
    await writeFile(join(bundle, "memories", "a.json"), canonicalJson({ id: "a", user_id: "someone-else", content: "x" }));
    await assert.rejects(validate(dir, bundle, "--derive-manifest"), /identity mismatch/);
    await writeFile(join(bundle, "memories", "a.json"), canonicalJson({ id: "a", user_id: "tester", content: "ok" }));
    await writeFile(join(bundle, "manifest.json"), canonicalJson({ version: 1, namespace: "other", files: [] }));
    await assert.rejects(validate(dir, bundle, "--derive-manifest"), /version or namespace/, "version and namespace still come from the manifest");
    await assert.rejects(execFile("python3", [BUNDLE_SCRIPT, "export", "--store", dir, "--bundle", join(dir, "x"), "--namespace", "tester", "--derive-manifest"]), /only valid for/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("M-1: a cloned bundle without empty kind directories validates", async () => {
  await gitMergeFixture(async ({ root }) => {
    const cloneRoot = `${root}-clone`;
    try {
      // `git clone` is blocked by the offline guard; a worktree checks out the same tracked files only.
      await git(root, "worktree", "add", "-q", "--detach", cloneRoot);
      const cloned = join(cloneRoot, ".headroom-memory");
      assert.equal(existsSync(join(cloned, "entities")), false);
      const expected = { entities: 0, memories: 1, relationships: 0 };
      assert.deepEqual(JSON.parse((await validate(cloneRoot, cloned)).stdout), expected);
      assert.deepEqual(JSON.parse((await validate(cloneRoot, cloned, "--derive-manifest")).stdout), expected);
    } finally { await rm(cloneRoot, { recursive: true, force: true }); }
  });
});

test("M-1: a missing kind is empty, but a symlinked or non-directory kind is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-workbench-memory-kinds-"));
  const bundle = join(dir, "bundle");
  try {
    await writeRecords(bundle, { a: "x" });
    await rm(join(bundle, "entities"), { recursive: true });
    await writeFile(join(bundle, "entities"), "not a directory");
    await assert.rejects(validate(dir, bundle), /must be a directory: entities/);
    await rm(join(bundle, "entities"));
    await symlink(join(dir, "nowhere"), join(bundle, "entities"));
    await assert.rejects(validate(dir, bundle), /symbolic link/);
    await rm(join(bundle, "entities"));
    const payload = canonicalJson({ id: "e", user_id: "tester", content: "x" });
    const files = [{ path: "entities/e.json", sha256: createHash("sha256").update(payload).digest("hex") }];
    await writeFile(join(bundle, "manifest.json"), canonicalJson({ version: 1, namespace: "tester", files }));
    await assert.rejects(validate(dir, bundle), /bundle file is required/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function checkMerge(root, ...paths) {
  const { stdout } = await git(root, "check-attr", "merge", "--", ...paths);
  return stdout.trim().split("\n").map(line => line.slice(line.lastIndexOf(": ") + 2));
}

test("M-3: merge attributes cover only bundle members", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workbench-memory-git-members-"));
  try {
    await git(root, "init");
    assert.equal(await configureMemoryGit(root, join(root, "docs")), null);
    const result = await checkMerge(root, "docs/manifest.json", "docs/memories/a.json", "docs/entities/b.json", "docs/relationships/c.json", "docs/guide.md", "docs/memories.md");
    assert.deepEqual(result, [...Array(4).fill(MEMORY_MERGE_DRIVER), "unspecified", "unspecified"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("M-3: export paths with spaces and glob characters are quoted", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workbench-memory-git-quoted-"));
  try {
    await git(root, "init");
    assert.equal(await configureMemoryGit(root, join(root, "my mem [1]")), null);
    assert.deepEqual(await checkMerge(root, "my mem [1]/manifest.json", "my mem [1]/memories/a.json", "my mem 1/manifest.json"), [MEMORY_MERGE_DRIVER, MEMORY_MERGE_DRIVER, "unspecified"]);
    const attributes = await readFile(join(root, ".gitattributes"), "utf8");
    assert.ok(attributes.includes(String.raw`"my mem \\[1\\]/manifest.json" merge=${MEMORY_MERGE_DRIVER}`), attributes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("M-3: an export path with control characters is refused and .gitattributes is not written", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workbench-memory-git-control-"));
  try {
    await git(root, "init");
    assert.match(await configureMemoryGit(root, join(root, "bad\nname")), /control characters/);
    assert.equal(existsSync(join(root, ".gitattributes")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("M-7: a symlinked .gitattributes is refused and its target is unchanged", async () => {
  const outer = await mkdtemp(join(tmpdir(), "pi-workbench-memory-git-symlink-"));
  const root = join(outer, "repo");
  try {
    await mkdir(root);
    await git(root, "init");
    const victim = join(outer, "victim.txt");
    await writeFile(victim, "keep\n");
    await symlink(victim, join(root, ".gitattributes"));
    assert.match(await configureMemoryGit(root, join(root, ".headroom-memory")), /not a regular file/);
    assert.equal(await readFile(victim, "utf8"), "keep\n");
    await assert.rejects(git(root, "config", "--local", "--get", `merge.${MEMORY_MERGE_DRIVER}.driver`));
  } finally { await rm(outer, { recursive: true, force: true }); }
});

test("M-7: an existing .gitattributes keeps its mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workbench-memory-git-mode-"));
  try {
    await git(root, "init");
    const attributes = join(root, ".gitattributes");
    await writeFile(attributes, "*.bin filter=lfs\n", { mode: 0o644 });
    await chmod(attributes, 0o644);
    assert.equal(await configureMemoryGit(root, join(root, ".headroom-memory")), null);
    assert.equal((await stat(attributes)).mode & 0o777, 0o644);
    assert.deepEqual((await readdir(root)).filter(name => name.endsWith(".tmp")), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
