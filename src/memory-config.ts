import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { WORKBENCH_PATHS } from "./paths.js";

export const DEFAULT_MEMORY_ROOT = WORKBENCH_PATHS.headroomMemory;
const PROJECTS_DIRECTORY = "projects";

export interface MemoryStore {
  root: string;
  projectPath: string;
  /** True only when caller explicitly configured headroom.json memoryRoot/options.root. */
  rootConfigured: boolean;
  /** Root resolves physically inside current project. Allowed, but caller must warn user. */
  rootInsideProject: boolean;
  directory: string;
  databasePath: string;
  identifier: string;
  userId: string;
}

/**
 * Resolve a project-scoped Headroom Memory store.
 * Database presence is persistent project opt-in. A configured root may live
 * inside project tree; callers must clearly warn before using that mode.
 */
export function resolveMemoryStore(options?: {
  cwd?: string;
  root?: string | undefined;
  userId?: string | undefined;
}): MemoryStore {
  const projectPath = canonicalPath(options?.cwd ?? process.cwd());
  const configuredRoot = options?.root;
  const rootConfigured = configuredRoot !== undefined && configuredRoot !== "";
  const root = resolveMemoryRoot(configuredRoot);
  const rootInsideProject = isWithin(canonicalPath(root), projectPath);
  const userId = parseMemoryUser(options?.userId);

  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
  const projectName = sanitizeProjectName(basename(projectPath));
  const identifier = `${projectName}-${hash}`;
  const directory = join(root, PROJECTS_DIRECTORY, identifier);

  return {
    root,
    projectPath,
    rootConfigured,
    rootInsideProject,
    directory,
    databasePath: join(directory, "memory.db"),
    identifier,
    userId,
  };
}

export function hasMemoryStore(store: Pick<MemoryStore, "databasePath">): boolean {
  return existsSync(store.databasePath);
}

export function resolveMemoryRoot(value: string | undefined): string {
  if (value === undefined || value === "") return DEFAULT_MEMORY_ROOT;

  const expanded = value === "~" || value.startsWith(`~${sep}`)
    ? join(homedir(), value.slice(2))
    : value;

  if (!isAbsolute(expanded)) {
    throw new Error(`headroom.json memoryRoot must be an absolute path; received ${JSON.stringify(value)}`);
  }

  return resolve(expanded);
}

export function parseMemoryUser(value: string | undefined): string {
  const user = value ?? process.env.USER ?? process.env.USERNAME ?? "default";
  if (user.length === 0 || /[\r\n\0]/.test(user)) {
    throw new Error("headroom.json memoryUser must be a non-empty single-line value");
  }
  return user;
}

function canonicalPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function sanitizeProjectName(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "project";
}

function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
