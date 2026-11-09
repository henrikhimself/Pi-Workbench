import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { requireSchemaVersion } from "./schema-version.js";
import { TOOL_NAMES } from "./tool-names.js";
import { assertNoSymlink, ensurePrivateDirectory, publishJson } from "./managed-lifecycle.js";

interface StoreIdentityBase { schemaVersion: 1; layout: 1 }
/** Headroom proxy and Memory stores. */
export interface HeadroomStoreIdentity extends StoreIdentityBase {
  headroomVersion: string;
  kind: "proxy" | "memory";
  model?: string;
  dimensions?: number;
  modelRevision?: string;
  modelSha256?: string;
  tokenizerSha256?: string;
}
/** A Code Graph project directory, bound to the exact pinned backend that wrote it. */
export interface CodeGraphStoreIdentity extends StoreIdentityBase {
  kind: "code-graph";
  codeGraphVersion: string;
  resolvedUrl: string;
  sha256: string;
}
export type StoreIdentity = HeadroomStoreIdentity | CodeGraphStoreIdentity;
export const STORE_MARKER = "workbench-identity.json";

const KIND_NAMES: Record<StoreIdentity["kind"], string> = {
  proxy: TOOL_NAMES.compression, memory: TOOL_NAMES.memory, "code-graph": TOOL_NAMES.codeGraph,
};
/** One refusal for every tool. It names no command: `off` clears the opt-in and does not remove this data. */
export function otherVersionMessage(toolName: string): string {
  return `${toolName} data was written by another version, which this release does not read. It was left unchanged.`;
}

/** Thrown when a data directory was written by another version. It is left unchanged. */
export class OtherVersionError extends Error {}

/** Parsed identity file, or `null` when absent. Never creates or repairs anything. */
export async function readStoreIdentity(directory: string): Promise<Record<string, unknown> | null> {
  const path = join(directory, STORE_MARKER);
  await assertNoSymlink(path);
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const actual = JSON.parse(text);
  requireSchemaVersion(actual, "Store identity file");
  return actual;
}

/** True when `actual` has exactly the keys and values of `expected`. */
export function identityMatches(actual: Record<string, unknown>, expected: StoreIdentity): boolean {
  return Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => actual[key] === value);
}

/** A new, empty directory is marked with `expected`. An existing one must carry exactly the same
 * identity; anything else, including a non-empty directory without an identity file, is refused and
 * left unchanged. Nothing is converted and nothing is deleted. */
export async function prepareDataStore(directory: string, expected: StoreIdentity): Promise<void> {
  await ensurePrivateDirectory(directory);
  const refusal = new OtherVersionError(otherVersionMessage(KIND_NAMES[expected.kind]));
  const actual = await readStoreIdentity(directory);
  if (actual === null) {
    if ((await readdir(directory)).length !== 0) throw refusal;
    await publishJson(directory, join(directory, STORE_MARKER), expected);
  } else if (!identityMatches(actual, expected)) throw refusal;
}
