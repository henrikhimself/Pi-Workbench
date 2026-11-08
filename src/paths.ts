import { homedir } from "node:os";
import { join } from "node:path";

/** Canonical extension-owned state. */
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
  playwrightRoot: string;
  playwrightConfig: string;
  playwrightRuntimes: string;
  playwrightNpmCache: string;
  playwrightCoordination: string;
  playwrightConsumers: string;
  playwrightProjects: string;
  playwrightSelected: string;
}
export function resolveWorkbenchPaths(home: string = homedir()): WorkbenchPaths {
  const root = join(home, ".pi", "pi-workbench");
  const headroomRoot = join(root, "headroom");
  const graph = join(root, "codebase-memory-mcp");
  const playwright = join(root, "playwright");
  return {
    root, headroomRoot, headroomMemory: join(headroomRoot, "memory"), headroomConfig: join(root, "headroom.json"),
    codeGraphRoot: graph, codeGraphBin: join(graph, "bin"), codeGraphDownloads: join(graph, "downloads"),
    codeGraphProjects: join(graph, "projects"), codeGraphRuntime: join(graph, "runtime"), codeGraphIpc: join(root, "run"),
    codeGraphInstallLock: join(graph, "coordination", "install.lock"), codeGraphCurlShim: join(graph, "deny-shims", "curl"),
    playwrightRoot: playwright, playwrightConfig: join(root, "playwright.json"), playwrightRuntimes: join(playwright, "runtimes"), playwrightNpmCache: join(playwright, "cache", "npm"),
    playwrightCoordination: join(playwright, "coordination"), playwrightConsumers: join(playwright, "consumers"),
    playwrightProjects: join(playwright, "projects"), playwrightSelected: join(playwright, "selected.json"),
  };
}
export const WORKBENCH_PATHS = resolveWorkbenchPaths();
