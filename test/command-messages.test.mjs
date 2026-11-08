import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { enabledMessage, offMessage, formatStatus } = await jiti.import("../src/command-messages.ts");
const { TOOL_NAMES } = await jiti.import("../src/tool-names.ts");

test("on and off messages: every row of the table, for every tool, with no identifier, path or the word fresh", () => {
  for (const tool of Object.values(TOOL_NAMES)) {
    assert.equal(enabledMessage(tool), `${tool} enabled for this project`);
    assert.equal(offMessage(tool, "disabled"), `${tool} disabled for this project`);
    assert.equal(offMessage(tool, "already-off"), `${tool} already off for this project`);
    assert.equal(offMessage(tool, "deleted"), `${tool} data deleted for this project`);
    for (const text of [enabledMessage(tool), offMessage(tool, "disabled"), offMessage(tool, "already-off"), offMessage(tool, "deleted")]) assert.doesNotMatch(text, /fresh|\/|-[0-9a-f]{16}/i);
  }
});

test("status layout: header labels in a fixed order, then Details", () => {
  assert.deepEqual(formatStatus("Code Graph", {
    state: "on", projectPath: "/work/acme", identifier: "acme-0123456789abcdef", data: "/root/projects/acme-0123456789abcdef",
    version: { installed: "v0.12.1", expected: "v0.12.1" }, link: "registered", details: ["Index: ready", "Watcher: Git watcher enabled"],
  }), [
    "Code Graph",
    "  State:    on",
    "  Project:  /work/acme  (acme-0123456789abcdef)",
    "  Data:     /root/projects/acme-0123456789abcdef",
    "  Version:  v0.12.1 (expected v0.12.1)",
    "  Link:     registered",
    "  Details:",
    "    Index: ready",
    "    Watcher: Git watcher enabled",
  ]);
});

test("status layout: absent optional fields are left out; no data reads none; a problem gets its own line", () => {
  assert.deepEqual(formatStatus("Playwright", { state: "off", projectPath: "/w", identifier: "w-1" }),
    ["Playwright", "  State:    off", "  Project:  /w  (w-1)", "  Data:     none"]);
  const withProblem = formatStatus("Headroom Memory", { state: "refused (data was written by another version)", projectPath: "/w", identifier: "w-1",
    data: null, version: { installed: null, expected: "0.5.0" }, link: "not registered", problem: "Headroom Memory data was written by another version, which this release does not read. It was left unchanged." });
  assert.ok(withProblem.includes("  Version:  not installed"));
  assert.equal(withProblem.at(-1), "  Problem:  Headroom Memory data was written by another version, which this release does not read. It was left unchanged.");
  assert.equal(withProblem.includes("  Details:"), false);
  assert.deepEqual(formatStatus("X", { state: "on", projectPath: "/w", identifier: "i", version: { installed: "1.0" } }).filter(line => /Version/.test(line)), ["  Version:  1.0"]);
});
