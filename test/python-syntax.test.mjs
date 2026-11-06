import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
test("all shipped Python adapters parse without executing/importing backend packages", () => {
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const files = readdirSync(root).filter(name => name.endsWith(".py")).map(name => root + name);
  assert.ok(files.length >= 2);
  assert.doesNotThrow(() => execFileSync("python3", ["-c", "import ast,pathlib,sys;[ast.parse(pathlib.Path(p).read_text(), filename=p) for p in sys.argv[1:]]", ...files], { timeout: 5000 }));
});
