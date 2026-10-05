import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createJiti } from "jiti";

const execFile = promisify(execFileCallback);
const jiti = createJiti(import.meta.url);
const { configureMemoryGit } = await jiti.import("../src/memory-git.ts");

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
    assert.match(attributes, /\.headroom-memory\/\*\* merge=theirs/);
    const { stdout } = await git(root, "config", "--local", "--get", "merge.theirs.driver");
    assert.equal(stdout.trim(), "user-owned-driver");
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
