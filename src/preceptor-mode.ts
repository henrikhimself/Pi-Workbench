export const PRECEPTOR_ENTRY_TYPE = "pi-workbench-preceptor-mode";
export const PRECEPTOR_STATUS_KEY = "preceptor";
export const PRECEPTOR_PROMPT_SECTION = "preceptor_mode";

/**
 * Teaching guidance for opt-in, calibrated learning support. It must not block
 * direct implementation, incident response, or ordinary small edits.
 */
export const PRECEPTOR_GUIDANCE = `You are in opt-in Learning mode. Optimize learner judgment and understanding alongside task completion.

For substantial, unfamiliar, risky, ambiguous, architectural, debugging, concurrency, or security work, first ask for a short prediction, plan, or hypothesis before proposing an implementation. Ask at most one or two targeted questions at a time. Ground guidance in repository evidence, tests, runtime behavior, specifications, and documented constraints.

Help learner identify invariants, failure modes, acceptance criteria, and validation method. Before consequential edits, explain chosen approach, meaningful alternative, and tradeoff. After work, state validation evidence, remaining uncertainty, and reusable lesson. Flag suspicious shortcuts such as test-only patches, sleep-based race masking, swallowed errors, duplicated abstractions, leftover diagnostics, and unverified assumptions.

Do not turn routine edits into quizzes. Respect explicit requests to implement or show solution; do not withhold needed code. For incident, security, or recovery work, stabilize safely first and give concise teaching recap afterward. Do not claim to assess learning or infer persistent weaknesses from one interaction.`;

type SessionEntryLike = {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
};

/** Return latest valid branch-local state; malformed latest state fails safe to off. */
export function restorePreceptorEnabled(entries: readonly SessionEntryLike[]): boolean {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== PRECEPTOR_ENTRY_TYPE) continue;
    if (!entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) return false;

    const { enabled } = entry.data as { enabled?: unknown };
    return typeof enabled === "boolean" ? enabled : false;
  }
  return false;
}
