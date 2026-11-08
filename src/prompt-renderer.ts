import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

export type PromptRenderer = (options: BuildSystemPromptOptions) => string;
export type PromptRendererResult = { renderer: PromptRenderer } | { note: string };

/** Pieces the loader needs; replaced in tests. */
export interface PromptRendererDeps {
  resolve: (specifier: string) => string;
  load: (url: string) => Promise<unknown>;
  readVersion: (entryUrl: string) => string | undefined;
  runningVersion: string | undefined;
}

/** Version of the package that contains `entryUrl` (walks up to its package.json). */
export function readPackageVersion(entryUrl: string): string | undefined {
  let dir = dirname(fileURLToPath(entryUrl));
  for (let i = 0; i < 8; i++) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
      if (parsed.name === "@earendil-works/pi-coding-agent") return parsed.version;
    } catch { /* keep walking */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Best-effort access to Pi's internal system prompt renderer. It is not a public
 * API, so any failure (unresolvable package, moved file, different Pi version,
 * unexpected shape) yields a one-line note instead of an error.
 */
export async function loadPromptRenderer(deps: PromptRendererDeps): Promise<PromptRendererResult> {
  try {
    const entry = deps.resolve("@earendil-works/pi-coding-agent");
    const found = deps.readVersion(entry);
    if (deps.runningVersion && found && found !== deps.runningVersion) {
      return { note: `Pi renderer not used: resolved Pi ${found} differs from running Pi ${deps.runningVersion}.` };
    }
    const loaded = (await deps.load(new URL("./core/system-prompt.js", entry).href)) as { buildSystemPrompt?: unknown };
    if (typeof loaded?.buildSystemPrompt !== "function") return { note: "Pi renderer not used: this Pi version has no buildSystemPrompt export." };
    return { renderer: loaded.buildSystemPrompt as PromptRenderer };
  } catch (error) {
    return { note: `Pi renderer not used: ${error instanceof Error ? error.message : String(error)}` };
  }
}
