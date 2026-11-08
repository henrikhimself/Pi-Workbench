import { lstat, readFile, rm } from "node:fs/promises";
import { assertNoSymlink, publishJson, syncDirectory } from "./managed-lifecycle.js";
import { requireSchemaVersion } from "./schema-version.js";

/** The one on-disk opt-in record: `{ schemaVersion, enabled, projectPath, identifier }`. */
export interface OptInProject { projectPath: string; identifier: string; directory: string; optInPath: string }

const KEYS = ["schemaVersion", "enabled", "projectPath", "identifier"];

/** Passive read of a private regular file: absent is `null`, nothing is created or repaired. */
export async function readOptInFile(path: string): Promise<unknown | null> {
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  await assertNoSymlink(path);
  if (!info.isFile() || (process.getuid && info.uid !== process.getuid()) ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
    throw new Error("Unsafe project opt-in file");
  }
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error("Cannot read project opt-in; existing file unchanged"); }
}

/** Strict check of a parsed record against its project. `null` (absent) is opted out. */
export function checkOptIn(project: OptInProject, raw: unknown | null): boolean {
  if (raw === null) return false;
  requireSchemaVersion(raw, "Project opt-in");
  const state = raw as Record<string, unknown>;
  if (Array.isArray(raw) || state.enabled !== true || state.projectPath !== project.projectPath ||
      state.identifier !== project.identifier || Object.keys(state).some(key => !KEYS.includes(key))) {
    throw new Error("Incompatible project opt-in; existing file unchanged");
  }
  return true;
}

/** Read through the default safe reader, or a caller's reader that adds its own path checks. */
export async function readOptIn(project: OptInProject, read: (path: string) => Promise<unknown | null> = readOptInFile): Promise<boolean> {
  return checkOptIn(project, await read(project.optInPath));
}

/** The record is the commit point: callers write it last, under their own lock. */
export async function writeOptIn(project: OptInProject, root: string): Promise<void> {
  await publishJson(root, project.optInPath, { schemaVersion: 1, enabled: true, projectPath: project.projectPath, identifier: project.identifier });
}

export async function removeOptIn(project: OptInProject): Promise<void> {
  await rm(project.optInPath);
  await syncDirectory(project.directory);
}
