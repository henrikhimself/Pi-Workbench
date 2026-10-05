export const MEMORY_PROMPT_SECTION = "headroom_memory";

export const MEMORY_GUIDANCE = `Headroom Memory provides project-scoped durable context through \`mcp__headroom-memory__memory_search\` and \`mcp__headroom-memory__memory_save\`.

Search only when prior project decisions, conventions, preferences, incidents, or unresolved history may materially help and are absent from current context. Do not search for routine work whose needed context is already present.

Save only when user explicitly asks to remember a fact or directly confirms it in this turn. Save atomic, accurate, project-relevant facts. Never save secrets, credentials, tokens, private keys, personal data, learner data, sensitive business data, raw transcripts, speculation, or transient task state.`;

export const STUDY_MEMORY_GUIDANCE = `Headroom Memory search is available for project-scoped durable context. Search only when prior project decisions, conventions, preferences, incidents, or unresolved history may materially help and are absent from current context. Do not search for routine work whose needed context is already present. Study Mode never permits saving Memory.`;

export type MemoryGuidanceMode = "normal" | "study" | "off";

export function applyMemoryGuidance(
  sections: Record<string, string>,
  mode: MemoryGuidanceMode,
): void {
  const guidance = mode === "normal" ? MEMORY_GUIDANCE : mode === "study" ? STUDY_MEMORY_GUIDANCE : undefined;
  if (guidance) sections[MEMORY_PROMPT_SECTION] = guidance;
  else delete sections[MEMORY_PROMPT_SECTION];
}

export function resolveMemoryGuidanceMode(options: {
  memoryRegistered: boolean;
  studyEnabled: boolean;
  studyMemoryAllowed: boolean;
  activeToolNames: readonly string[];
}): MemoryGuidanceMode {
  if (!options.memoryRegistered) return "off";

  const activeTools = new Set(options.activeToolNames);
  const searchAvailable = activeTools.has("mcp__headroom-memory__memory_search");
  if (!searchAvailable) return "off";

  if (options.studyEnabled) {
    return options.studyMemoryAllowed ? "study" : "off";
  }

  return activeTools.has("mcp__headroom-memory__memory_save") ? "normal" : "off";
}
