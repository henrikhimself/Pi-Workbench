import { homedir } from "node:os";
import { join } from "node:path";

/** Canonical extension-owned state. No legacy discovery or migration aliases. */
export interface WorkbenchPaths {
  root: string;
  headroomRoot: string;
  headroomMemory: string;
  headroomConfig: string;
  codeGraphRoot: string;
  codeGraphBin: string;
  codeGraphDownloads: string;
  codeGraphProjects: string;
  codeGraphRuntime: string;
  codeGraphIpc: string;
  codeGraphInstallLock: string;
  codeGraphCurlShim: string;
}
export function resolveWorkbenchPaths(home: string = homedir()): WorkbenchPaths {
  const root = join(home, ".pi", "pi-workbench");
  const headroomRoot = join(root, "headroom", "v1");
  const graph = join(root, "codebase-memory-mcp");
  return {
    root, headroomRoot, headroomMemory: join(headroomRoot, "memory"), headroomConfig: join(root, "headroom.json"),
    codeGraphRoot: graph, codeGraphBin: join(graph, "bin"), codeGraphDownloads: join(graph, "downloads"),
    codeGraphProjects: join(graph, "projects"), codeGraphRuntime: join(graph, "runtime"), codeGraphIpc: join(root, "run"),
    codeGraphInstallLock: join(graph, "coordination", "install.lock"), codeGraphCurlShim: join(graph, "deny-shims", "curl"),
  };
}
export const WORKBENCH_PATHS = resolveWorkbenchPaths();
