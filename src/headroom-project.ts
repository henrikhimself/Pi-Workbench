import { join } from "node:path";
import { resolveCodeGraphProject } from "./code-graph-config.js";
import { acquireManagedLock } from "./managed-lifecycle.js";
import { readOptIn, removeOptIn, writeOptIn } from "./project-opt-in.js";
import { WORKBENCH_PATHS, type WorkbenchPaths } from "./paths.js";

export interface CompressionProject {
  projectPath: string;
  identifier: string;
  directory: string;
  optInPath: string;
}

/** Share canonical workspace identity only, never Code Graph state or stores. */
export function resolveCompressionProject(cwd: string, paths: WorkbenchPaths = WORKBENCH_PATHS): CompressionProject {
  const { projectPath, identifier } = resolveCodeGraphProject(cwd, paths);
  const directory = join(paths.headroomRoot, "compression", "projects", identifier);
  return { projectPath, identifier, directory, optInPath: join(directory, "opt-in.json") };
}

/** Passive absent-marker check: no directory creation, runtime setup, or root adoption. */
export function compressionOptedIn(project: CompressionProject): Promise<boolean> { return readOptIn(project); }

/** Persist explicit intent, not backend readiness. Missing marker is durable opt-out. */
export async function setCompressionOptIn(project: CompressionProject, enabled: boolean, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  // Off on an untouched project must not create managed directories either.
  if (!enabled && !await compressionOptedIn(project)) return;
  const release = await acquireManagedLock(project.directory, "opt-in", { signal });
  try {
    signal?.throwIfAborted();
    const present = await compressionOptedIn(project);
    if (enabled) await writeOptIn(project, project.directory);
    else if (present) await removeOptIn(project);
  } finally { await release(); }
}
