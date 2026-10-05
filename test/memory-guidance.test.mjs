import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const guidance = await jiti.import("../src/memory-guidance.ts");

const MEMORY_SEARCH = "mcp__headroom-memory__memory_search";
const MEMORY_SAVE = "mcp__headroom-memory__memory_save";

function mode(options) {
  return guidance.resolveMemoryGuidanceMode({
    memoryRegistered: true,
    studyEnabled: false,
    studyMemoryAllowed: false,
    activeToolNames: [MEMORY_SEARCH, MEMORY_SAVE],
    ...options,
  });
}

test("Memory guidance: normal policy requires registered search and save tools", () => {
  assert.equal(mode({}), "normal");
  assert.equal(mode({ memoryRegistered: false }), "off");
  assert.equal(mode({ activeToolNames: [MEMORY_SEARCH] }), "off");
  assert.equal(mode({ activeToolNames: [MEMORY_SAVE] }), "off");
});

test("Memory guidance: Study Mode is search-only and permission-gated", () => {
  assert.equal(mode({ studyEnabled: true, studyMemoryAllowed: true, activeToolNames: [MEMORY_SEARCH] }), "study");
  assert.equal(mode({ studyEnabled: true, studyMemoryAllowed: false, activeToolNames: [MEMORY_SEARCH] }), "off");
  assert.equal(mode({ studyEnabled: true, studyMemoryAllowed: true, activeToolNames: [] }), "off");
});

test("Memory guidance: policy preserves unrelated sections and removes unavailable Memory", () => {
  const sections = { unrelated: "keep" };

  guidance.applyMemoryGuidance(sections, "normal");
  assert.equal(sections.unrelated, "keep");
  assert.equal(sections[guidance.MEMORY_PROMPT_SECTION], guidance.MEMORY_GUIDANCE);
  assert.match(sections[guidance.MEMORY_PROMPT_SECTION], /explicitly asks to remember/);
  assert.match(sections[guidance.MEMORY_PROMPT_SECTION], /Never save secrets/);

  guidance.applyMemoryGuidance(sections, "study");
  assert.equal(sections[guidance.MEMORY_PROMPT_SECTION], guidance.STUDY_MEMORY_GUIDANCE);
  assert.match(sections[guidance.MEMORY_PROMPT_SECTION], /never permits saving/i);

  guidance.applyMemoryGuidance(sections, "off");
  assert.equal(sections[guidance.MEMORY_PROMPT_SECTION], undefined);
  assert.equal(sections.unrelated, "keep");
});
