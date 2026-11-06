import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { assertNoSymlink, ensurePrivateDirectory, publishJson } from "./managed-lifecycle.js";

export interface HeadroomStoreIdentity {
  schema: 1;
  layout: 1;
  headroomVersion: string;
  kind: "proxy" | "memory";
  model?: string;
  dimensions?: number;
  namespace?: string;
  modelRevision?: string;
  modelSha256?: string;
  tokenizerSha256?: string;
}
export const HEADROOM_STORE_MARKER = "workbench-identity.json";

/** Only fresh stores or the exact current data contract may be opened.
 * Future version/layout changes must supply their reviewed staged-data adapter;
 * matching a top-level package version alone is not schema compatibility proof.
 */
export async function prepareHeadroomStore(directory: string, expected: HeadroomStoreIdentity): Promise<void> {
  await ensurePrivateDirectory(directory);
  const path = join(directory, HEADROOM_STORE_MARKER);
  await assertNoSymlink(path);
  try {
    const actual = JSON.parse(await readFile(path, "utf8"));
    if (Object.keys(actual).length !== Object.keys(expected).length ||
        Object.entries(expected).some(([key, value]) => actual[key] !== value)) {
      throw new Error("Headroom data identity differs; a verified staged migration is required before opening this store");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if ((await readdir(directory)).length !== 0) {
      throw new Error("Unmarked Headroom store is not adopted; select a fresh new-layout namespace");
    }
    await publishJson(directory, path, expected);
  }
}
