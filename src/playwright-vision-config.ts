import { lstat, open, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { assertNoSymlink } from "./managed-lifecycle.js";

/** User-wide, user-editable `~/.pi/pi-workbench/playwright.json`. Only the vision provider/model are configurable. */
export const PLAYWRIGHT_USER_CONFIG_TEMPLATE = { schemaVersion: 1, vision: { provider: "llama.cpp", model: null } } as const;
const MAX_CONFIG_BYTES = 64 * 1024, MAX_NAME = 200;

export interface PlaywrightVisionTarget { provider: string; model: string }
/** `absent`/`unset` mean no bridge and no side effects; `invalid` disables the bridge only (never Playwright). */
export type PlaywrightVisionConfigState =
  | { state: "absent" }
  | { state: "unset" }
  | { state: "invalid"; reason: string }
  | { state: "ready"; target: PlaywrightVisionTarget };

const invalid = (reason: string): PlaywrightVisionConfigState => ({ state: "invalid", reason: `playwright.json ${reason}` });
function name(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > MAX_NAME || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

/** Pure validation of parsed JSON. Strict: unknown fields, wrong types, empty strings and a bad schema version all invalidate. */
export function parsePlaywrightVisionConfig(raw: unknown): PlaywrightVisionConfigState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid("must be a JSON object.");
  const source = raw as Record<string, unknown>;
  for (const key of Object.keys(source)) if (key !== "schemaVersion" && key !== "vision") return invalid(`${key} is not supported.`);
  if (source.schemaVersion !== 1) return invalid("requires schemaVersion: 1.");
  if (source.vision === undefined) return { state: "unset" };
  if (!source.vision || typeof source.vision !== "object" || Array.isArray(source.vision)) return invalid("vision must be an object.");
  const vision = source.vision as Record<string, unknown>;
  for (const key of Object.keys(vision)) if (key !== "provider" && key !== "model") return invalid(`vision.${key} is not supported.`);
  const provider = vision.provider === undefined ? null : name(vision.provider), model = vision.model === undefined ? null : name(vision.model);
  if (provider === undefined) return invalid("vision.provider must be a non-empty string or null.");
  if (model === undefined) return invalid("vision.model must be a non-empty string or null.");
  if (provider === null || model === null) return { state: "unset" };
  return { state: "ready", target: { provider, model } };
}

/** Passive reader: never creates, repairs or rewrites the file. Cached by size and mtime so edits apply without a restart. */
export function createPlaywrightVisionConfigReader(path: string): () => Promise<PlaywrightVisionConfigState> {
  let cache: { key: string; state: PlaywrightVisionConfigState } | undefined;
  return async () => {
    let info;
    try { await assertNoSymlink(path); info = await lstat(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { cache = undefined; return { state: "absent" }; }
      return invalid("cannot be read safely.");
    }
    if (!info.isFile()) return invalid("is not a regular file.");
    if (info.size > MAX_CONFIG_BYTES) return invalid("is too large.");
    const key = `${info.size}:${info.mtimeMs}:${info.ino}`;
    if (cache?.key === key) return cache.state;
    let text: string;
    try {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { text = await handle.readFile("utf8"); } finally { await handle.close(); }
    } catch { return invalid("cannot be read safely."); }
    let state: PlaywrightVisionConfigState;
    try { state = parsePlaywrightVisionConfig(JSON.parse(text)); } catch { state = invalid("is not valid JSON."); }
    cache = { key, state };
    return state;
  };
}

/** Create the null template only when absent (never overwrite, repair or migrate). Called only from Playwright opt-in. */
export async function ensurePlaywrightUserConfig(path: string): Promise<boolean> {
  await assertNoSymlink(path);
  try {
    await writeFile(path, `${JSON.stringify(PLAYWRIGHT_USER_CONFIG_TEMPLATE, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export function formatPlaywrightVisionConfig(state: PlaywrightVisionConfigState): string {
  if (state.state === "ready") return `Vision bridge: configured ${state.target.provider}/${state.target.model}`;
  if (state.state === "invalid") return `Vision bridge: off (${state.reason})`;
  if (state.state === "absent") return "Vision bridge: off (no playwright.json; /wb:playwright on creates a template to edit)";
  return "Vision bridge: off (set vision.provider and vision.model in playwright.json)";
}
