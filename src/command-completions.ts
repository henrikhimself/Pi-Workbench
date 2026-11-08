import type { AutocompleteItem } from "@earendil-works/pi-tui";

/** Sub-commands for a `/wb:` command, each with the flags it accepts after it. */
export type CompletionSpec = Readonly<Record<string, readonly string[]>>;

/**
 * Argument completion for `/command <prefix>`. The prefix is the whole argument text typed so far;
 * a returned `value` replaces it, so second-token completions carry the sub-command too.
 */
export function completeArguments(spec: CompletionSpec, prefix: string): AutocompleteItem[] | null {
  const text = prefix.replace(/^\s+/, "").toLowerCase();
  const match = /^(\S*)(?:\s+(\S*))?$/.exec(text);
  if (!match) return null;
  const [, action, flag] = match;
  const items: AutocompleteItem[] = [];
  if (flag === undefined) {
    for (const name of Object.keys(spec)) if (name.startsWith(action)) items.push({ value: name, label: name });
  } else if (spec[action]) {
    for (const option of spec[action]) if (option.startsWith(flag)) items.push({ value: `${action} ${option}`, label: option });
  }
  return items.length > 0 ? items : null;
}

export const completions = (spec: CompletionSpec) => (prefix: string) => completeArguments(spec, prefix);

export const PROXY_COMPLETIONS: CompletionSpec = { on: [], off: [], status: [] };
export const STUDY_COMPLETIONS: CompletionSpec = { on: [], off: [] };
export const MEMORY_COMPLETIONS: CompletionSpec = {
  on: [], off: ["--confirm-delete"], status: [], show: [], export: [], import: ["--confirm-replace"], merge: [],
};
export const CODE_GRAPH_COMPLETIONS: CompletionSpec = { on: [], off: ["--confirm-delete"], reindex: [], status: [] };
