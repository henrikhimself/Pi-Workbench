import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
function modules(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? modules(join(directory, entry.name)) : entry.name.endsWith(".mjs") ? [join(directory, entry.name)] : []);
}
test("all checked-in JS harnesses and launchers parse, including opt-in adapters", () => {
  const files = [...modules(fileURLToPath(new URL("./", import.meta.url))), ...modules(fileURLToPath(new URL("../src/", import.meta.url)))];
  assert.ok(files.length > 10);
  for (const file of files) execFileSync(process.execPath, ["--check", file], { timeout: 5000 });
});
