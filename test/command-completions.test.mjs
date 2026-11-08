import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const c = await jiti.import("../src/command-completions.ts");
const values = (items) => items?.map((item) => item.value);

test("S3: first-token completion filters by prefix and returns null when nothing matches", () => {
  assert.deepEqual(values(c.completeArguments(c.MEMORY_COMPLETIONS, "")), ["on", "off", "status", "show", "export", "import", "merge"]);
  assert.deepEqual(values(c.completeArguments(c.MEMORY_COMPLETIONS, "s")), ["status", "show"]);
  assert.deepEqual(values(c.completeArguments(c.CODE_GRAPH_COMPLETIONS, "RE")), ["reindex"], "case-insensitive");
  assert.deepEqual(values(c.completeArguments(c.PROXY_COMPLETIONS, "")), ["on", "off", "status"]);
  assert.deepEqual(values(c.completeArguments(c.STUDY_COMPLETIONS, "")), ["on", "off"]);
  assert.equal(c.completeArguments(c.STUDY_COMPLETIONS, "x"), null);
});

test("S3: confirm flags complete only after the sub-command that accepts them and carry the sub-command in the value", () => {
  assert.deepEqual(values(c.completeArguments(c.MEMORY_COMPLETIONS, "import ")), ["import --confirm-replace"]);
  assert.deepEqual(values(c.completeArguments(c.MEMORY_COMPLETIONS, "import --c")), ["import --confirm-replace"]);
  assert.deepEqual(values(c.completeArguments(c.MEMORY_COMPLETIONS, "off --confirm-d")), ["off --confirm-delete"]);
  assert.deepEqual(values(c.completeArguments(c.CODE_GRAPH_COMPLETIONS, "off ")), ["off --confirm-delete"]);
  assert.equal(c.completeArguments(c.MEMORY_COMPLETIONS, "merge "), null, "no flags for merge");
  assert.equal(c.completeArguments(c.MEMORY_COMPLETIONS, "import --confirm-delete"), null, "a flag of another sub-command is not offered");
  assert.equal(c.completeArguments(c.MEMORY_COMPLETIONS, "off --confirm-delete extra"), null);
});
