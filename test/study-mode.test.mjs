import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
const study = await jiti.import("../src/study-mode.ts");

test("Study guidance strongly prefers learning without claiming an execution boundary", () => {
  assert.match(study.STUDY_GUIDANCE, /Prefer study before action/);
  assert.match(study.STUDY_GUIDANCE, /Strongly avoid edits/);
  assert.match(study.STUDY_GUIDANCE, /unless user explicitly asks/);
  assert.match(study.STUDY_GUIDANCE, /guidance only, not an execution boundary/);
  assert.doesNotMatch(study.STUDY_GUIDANCE, /hard-block|read-only boundary|only permitted/i);
});

test("restoreStudyModeState accepts legacy state and ignores saved tool names", () => {
  const legacyEnabled = {
    type: "custom",
    customType: study.STUDY_ENTRY_TYPE,
    data: { enabled: true, savedToolNames: ["bash", "read"] },
  };
  assert.deepEqual(study.restoreStudyModeState([legacyEnabled]), { enabled: true });
  assert.deepEqual(
    study.restoreStudyModeState([legacyEnabled, { type: "custom", customType: study.STUDY_ENTRY_TYPE, data: { enabled: false } }]),
    { enabled: false },
  );
  assert.deepEqual(
    study.restoreStudyModeState([{ type: "custom", customType: study.STUDY_ENTRY_TYPE, data: { enabled: "yes" } }]),
    { enabled: false },
  );
});
