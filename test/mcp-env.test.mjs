import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { escapeMcpEnvValue, escapeMcpEnv } = await jiti.import("../src/mcp-env.ts");

const values = ["/home/u/my$app", "!echo hi", "$!x", "a${B}c", "http://u:pa$s@host:3128", "$$", "$", "plain", "", "!", "a!b", "$HOME", "${HOME}"];

test("escaping doubles every dollar sign and protects a leading bang", () => {
  assert.equal(escapeMcpEnvValue("/home/u/my$app"), "/home/u/my$$app");
  assert.equal(escapeMcpEnvValue("!echo hi"), "$!echo hi");
  assert.equal(escapeMcpEnvValue("$!x"), "$$!x");
  assert.equal(escapeMcpEnvValue("a${B}c"), "a$${B}c");
  assert.equal(escapeMcpEnvValue("plain"), "plain");
  assert.equal(escapeMcpEnvValue(""), "");
  assert.equal(escapeMcpEnvValue("a!b"), "a!b", "only a leading bang runs a command");
  assert.deepEqual(escapeMcpEnv({ A: "$x", B: "!y" }), { A: "$$x", B: "$!y" });
});

test("escaped values resolve back to the original through Pi's own resolver", async (t) => {
  let resolveConfigValue;
  try {
    ({ resolveConfigValue } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js", import.meta.url).href));
  } catch { return t.skip("Pi's internal resolver is not importable in this install"); }
  for (const value of values) {
    assert.equal(resolveConfigValue(escapeMcpEnvValue(value), {}), value, JSON.stringify(value));
  }
});
