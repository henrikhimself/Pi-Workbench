import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  /** Configured project-contained directory for canonical Memory bundle, when enabled. */
  exportDirectory?: string;
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
  exportPath?: string | undefined;
}): MemoryStore {
  const projectPath = canonicalPath(options?.cwd ?? process.cwd());
  const configuredRoot = options?.root;
  const rootConfigured = configuredRoot !== undefined && configuredRoot !== "";
  const root = resolveMemoryRoot(configuredRoot);
  const rootInsideProject = isWithin(canonicalPath(root), projectPath);
  const userId = parseMemoryNamespace(options?.userId);
  const exportDirectory = options?.exportPath === undefined
    ? undefined
    : resolveMemoryExportDirectory(projectPath, options.exportPath);

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
    exportDirectory,
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

/** Resolve a configured bundle directory while forbidding project escapes through symlinks. */
export function resolveMemoryExportDirectory(projectPath: string, value: string): string {
  if (isAbsolute(value)) {
    throw new Error("headroom.json memory.export must be a project-relative path");
  }

  const project = canonicalPath(projectPath);
  const lexical = resolve(project, value);
  if (!isWithin(lexical, project) || lexical === project) {
    throw new Error("headroom.json memory.export must resolve below project root");
  }

  const physical = resolveFromExistingParent(lexical);
  if (!isWithin(physical, project) || physical === project) {
    throw new Error("headroom.json memory.export must not escape project root through symlinks");
  }
  return physical;
}

export function parseMemoryNamespace(value: string | undefined): string {
  const namespace = value ?? "project";
  if (namespace.length === 0 || /[\r\n\0]/.test(namespace)) {
    throw new Error("headroom.json memoryNamespace must be a non-empty single-line value");
  }
  return namespace;
}

function resolveFromExistingParent(path: string): string {
  const remainder: string[] = [];
  let existing = path;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    remainder.unshift(basename(existing));
    existing = parent;
  }
  return resolve(canonicalPath(existing), ...remainder);
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
