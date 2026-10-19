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
  headroomConfig: string;
  /** Standalone codebase-memory-mcp data root; independent of Headroom. */
  codeGraphRoot: string;
  codeGraphBin: string;
  codeGraphDownloads: string;
  codeGraphProjects: string;
  codeGraphInstallLock: string;
  codeGraphCurlShim: string;
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
    headroomConfig: join(root, "headroom.json"),
    codeGraphRoot: join(root, "codebase-memory-mcp"),
    codeGraphBin: join(root, "codebase-memory-mcp", "bin"),
    codeGraphDownloads: join(root, "codebase-memory-mcp", "downloads"),
    codeGraphProjects: join(root, "codebase-memory-mcp", "projects"),
    codeGraphInstallLock: join(root, "codebase-memory-mcp", "install.lock"),
    codeGraphCurlShim: join(root, "codebase-memory-mcp", "deny-shims", "curl"),
    // Expose only for diagnostics/tests. Callers must not migrate or use them.
    legacyHeadroomVenv: join(piRoot, "headroom-venv"),
    legacyHeadroomVenvLock: join(piRoot, "headroom-venv.lock"),
    legacyHeadroomMemory: join(piRoot, "headroom-memory"),
  };
}

export const WORKBENCH_PATHS = resolveWorkbenchPaths();
