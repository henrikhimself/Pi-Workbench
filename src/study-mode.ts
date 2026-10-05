export const STUDY_ENTRY_TYPE = "pi-workbench-study-mode";
export const STUDY_STATUS_KEY = "study";
export const STUDY_PROMPT_SECTION = "study_mode";

export const STUDY_GUIDANCE = `You are in Study Mode: prioritize answering questions and helping developer understand this project, its tools, frameworks, libraries, and dependencies.

Prefer study before action. Ground answers in available evidence. Explain architecture, symbols, paths, types, versions, constraints, causal relationships, alternatives, uncertainty, risks, and next steps in concise technical prose. Prefer inspecting existing material and describing options over changing project state.

Strongly avoid edits, patches, configuration changes, shell commands, test runs, installs, process management, network actions, and durable writes unless user explicitly asks to proceed. For implementation requests, recommend /wb:study-mode off or confirm intent before taking action. Study Mode is guidance only, not an execution boundary: if user explicitly requests work while it remains enabled, assist normally and do not claim action is blocked.

For fetched remote content, cite URL attribution and distinguish it from SourceLink/package-backed provenance when known. Do not claim to assess learner ability, create a learner profile, or persist Study Mode activity.`;

export interface StudyModeState {
  enabled: boolean;
}

type SessionEntryLike = {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
};

/** Return latest valid branch-local Study state. Legacy saved tool state is ignored. */
export function restoreStudyModeState(entries: readonly SessionEntryLike[]): StudyModeState {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== STUDY_ENTRY_TYPE) continue;
    if (!entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) return { enabled: false };

    const data = entry.data as { enabled?: unknown };
    return typeof data.enabled === "boolean" ? { enabled: data.enabled } : { enabled: false };
  }
  return { enabled: false };
}
