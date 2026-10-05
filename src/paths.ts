import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Extension-owned user data. Keep Workbench state separate from Pi's own files
 * and from legacy Headroom paths, which this extension deliberately never uses.
 */
export interface WorkbenchPaths {
  root: string;
  headroomVenv: string;
  headroomVenvLock: string;
  headroomMemory: string;
  studyModeConfig: string;
  headroomConfig: string;
  legacyHeadroomVenv: string;
  legacyHeadroomVenvLock: string;
  legacyHeadroomMemory: string;
}

export function resolveWorkbenchPaths(home: string = homedir()): WorkbenchPaths {
  const piRoot = join(home, ".pi");
  const root = join(piRoot, "pi-workbench");

  return {
    root,
    headroomVenv: join(root, "headroom-venv"),
    headroomVenvLock: join(root, "headroom-venv.lock"),
    headroomMemory: join(root, "headroom-memory"),
    studyModeConfig: join(root, "study-mode.json"),
    headroomConfig: join(root, "headroom.json"),
    // Expose only for diagnostics/tests. Callers must not migrate or use them.
    legacyHeadroomVenv: join(piRoot, "headroom-venv"),
    legacyHeadroomVenvLock: join(piRoot, "headroom-venv.lock"),
    legacyHeadroomMemory: join(piRoot, "headroom-memory"),
  };
}

export const WORKBENCH_PATHS = resolveWorkbenchPaths();
