import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const GITHUB_SOURCE = "git:github.com/henrikhimself/Pi-Workbench";

test("GitHub publishing docs: advertise canonical GitHub installation only", async () => {
  const [readme, install] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../INSTALL.md", import.meta.url), "utf8"),
  ]);

  for (const document of [readme, install]) {
    assert.match(document, new RegExp(GITHUB_SOURCE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(document, /pi install npm:/);
    assert.doesNotMatch(document, /npm publish/);
  }
  assert.doesNotMatch(install, /npm install/);
});

test("public README and agent guidance stay concise", async () => {
  const [readme, agents] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../AGENTS.md", import.meta.url), "utf8"),
  ]);

  assert.match(readme, /^## Requirements$/m);
  assert.match(readme, /^## Install from GitHub$/m);
  assert.match(readme, /^## Configuration$/m);
  assert.match(readme, /^## Commands$/m);
  assert.doesNotMatch(readme, /^## (How It Works|Behavior|Architecture)$/m);

  assert.deepEqual([...agents.matchAll(/^## (.+)$/gm)].map((match) => match[1]), [
    "Common commands",
    "Development rules",
  ]);
});
