import { lstat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { resolveCodeGraphProject } from "./code-graph-config.js";
import { acquireManagedLock, assertNoSymlink, publishJson, syncDirectory } from "./managed-lifecycle.js";
import { WORKBENCH_PATHS, type WorkbenchPaths } from "./paths.js";

export interface CompressionProject {
  projectPath: string;
  identifier: string;
  directory: string;
  statePath: string;
}

/** Share canonical workspace identity only, never Code Graph state or stores. */
export function resolveCompressionProject(cwd: string, paths: WorkbenchPaths = WORKBENCH_PATHS): CompressionProject {
  const { projectPath, identifier } = resolveCodeGraphProject(cwd, paths);
  const directory = join(paths.headroomRoot, "compression", "projects", identifier);
  return { projectPath, identifier, directory, statePath: join(directory, "opt-in.json") };
}

/** Passive absent-marker check: no directory creation, runtime setup, or root adoption. */
export async function compressionOptedIn(project: CompressionProject): Promise<boolean> {
  let info;
  try { info = await lstat(project.statePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  await assertNoSymlink(project.statePath);
  if (!info.isFile() || (process.getuid && info.uid !== process.getuid()) ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
    throw new Error("Unsafe project compression opt-in file");
  }
  let state;
  try { state = JSON.parse(await readFile(project.statePath, "utf8")); }
  catch { throw new Error("Cannot read project compression opt-in; existing file unchanged"); }
  if (!state || Array.isArray(state) || state.schemaVersion !== 1 || state.enabled !== true ||
      state.projectPath !== project.projectPath || state.identifier !== project.identifier ||
      Object.keys(state).some(key => !["schemaVersion", "enabled", "projectPath", "identifier"].includes(key))) {
    throw new Error("Incompatible project compression opt-in; existing file unchanged");
  }
  return true;
}

/** Persist explicit intent, not backend readiness. Missing marker is durable opt-out. */
export async function setCompressionOptIn(project: CompressionProject, enabled: boolean, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  // Off on an untouched project must not create managed directories either.
  if (!enabled && !await compressionOptedIn(project)) return;
  const release = await acquireManagedLock(project.directory, "opt-in", { signal });
  try {
    signal?.throwIfAborted();
    const present = await compressionOptedIn(project);
    if (enabled) {
      await publishJson(project.directory, project.statePath, {
        schemaVersion: 1, enabled: true, projectPath: project.projectPath, identifier: project.identifier,
      });
    } else if (present) {
      await rm(project.statePath);
      await syncDirectory(project.directory);
    }
  } finally { await release(); }
}
