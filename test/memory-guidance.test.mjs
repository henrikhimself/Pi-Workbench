import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const guidance = await jiti.import("../src/memory-guidance.ts");

const MEMORY_SEARCH = "mcp__headroom_memory__memory_search";
const MEMORY_SAVE = "mcp__headroom_memory__memory_save";

function mode(options) {
  return guidance.resolveMemoryGuidanceMode({
    memoryRegistered: true,
    activeToolNames: [MEMORY_SEARCH, MEMORY_SAVE],
    ...options,
  });
}

test("Memory guidance: normal policy requires registered search and save tools", () => {
  assert.equal(mode({}), "normal");
  assert.equal(mode({ memoryRegistered: false }), "off");
  assert.equal(mode({ activeToolNames: [MEMORY_SEARCH] }), "search-only");
  assert.equal(mode({ activeToolNames: [MEMORY_SAVE] }), "off");
});

test("X-4b: hyphenated tool names are not Pi's and are not recognised", () => {
  assert.equal(mode({ activeToolNames: ["mcp__headroom-memory__memory_search", "mcp__headroom-memory__memory_save"] }), "off");
});

test("Memory guidance names match actual Pi normalized MCP tools", () => {
  const actual = ["mcp__headroom_memory__memory_search", "mcp__headroom_memory__memory_save"];
  assert.equal(mode({ activeToolNames: actual }), "normal");
  assert.ok(actual.every(name => guidance.MEMORY_GUIDANCE.includes(name)));
  assert.doesNotMatch(guidance.MEMORY_GUIDANCE, /mcp__headroom-memory__/);
});

test("Memory guidance: search without save is search-only, with Study Mode on or off", () => {
  for (const studyEnabled of [true, false]) {
    assert.equal(mode({ studyEnabled, activeToolNames: [MEMORY_SEARCH] }), "search-only");
    assert.equal(mode({ studyEnabled, activeToolNames: [MEMORY_SEARCH, MEMORY_SAVE] }), "normal");
    assert.equal(mode({ studyEnabled, activeToolNames: [] }), "off");
  }
});

test("Memory guidance: policy preserves unrelated sections and removes unavailable Memory", () => {
  const sections = { unrelated: "keep" };

  guidance.applyMemoryGuidance(sections, "normal");
  assert.equal(sections.unrelated, "keep");
  assert.equal(sections[guidance.MEMORY_PROMPT_SECTION], guidance.MEMORY_GUIDANCE);
  assert.match(sections[guidance.MEMORY_PROMPT_SECTION], /explicitly asks to remember/);
  assert.match(sections[guidance.MEMORY_PROMPT_SECTION], /Never save secrets/);

  guidance.applyMemoryGuidance(sections, "search-only");
  assert.equal(sections[guidance.MEMORY_PROMPT_SECTION], guidance.SEARCH_ONLY_MEMORY_GUIDANCE);
  assert.match(sections[guidance.MEMORY_PROMPT_SECTION], /Saving Memory is not available/);

  guidance.applyMemoryGuidance(sections, "off");
  assert.equal(sections[guidance.MEMORY_PROMPT_SECTION], undefined);
  assert.equal(sections.unrelated, "keep");
});
