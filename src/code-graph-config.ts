import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { open, rename as renamePath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { WORKBENCH_PATHS, type WorkbenchPaths } from "./paths.js";
import { parseAssetVersion } from "./code-graph-assets.js";

/**
 * Standalone codebase-memory-mcp (CBM) configuration, workspace identity,
 * and per-workspace enablement state.
 *
 * The data root is `~/.pi/pi-workbench/codebase-memory-mcp` and is separate
 * from Headroom Memory data. Workspace identity reuses the Headroom Memory
 * hashing semantics (sanitized canonical basename + 16 hex chars of SHA-256
 * canonical path) without importing or sharing any Memory store.
 */

export const CODE_GRAPH_STATE_SCHEMA = 1;
export const CODE_GRAPH_STATE_FILE = "state.json";
export const CBM_CONFIG_FILE = "_config.db";

export interface CodeGraphProject {
  /** Canonical (symlink-resolved) absolute workspace path. */
  projectPath: string;
  /** `<sanitized-basename>-<sha256-16>` workspace identifier. */
  identifier: string;
  /** `projects/<identifier>` directory holding all CBM data for this workspace. */
  directory: string;
  statePath: string;
}

export interface CodeGraphState {
  schema: number;
  workspacePath: string;
  identifier: string;
  /** Asset version installed when the workspace was activated, e.g. `v0.8.1`. */
  version: string;
  /** Resolved (token-substituted) archive URL used at activation. */
  resolvedUrl: string;
  sha256: string;
  createdAt: string;
  updatedAt: string;
}

export type CodeGraphStateProblem =
  | "missing"
  | "not_a_directory"
  | "malformed_json"
  | "unknown_schema"
  | "wrong_workspace"
  | "wrong_identifier"
  | "invalid_asset_identity"
  | "invalid_timestamps"
  | "missing_config_db"
  | "missing_index_db"
  | "read_error";

export type CodeGraphStateValidation =
  | { ok: true; state: CodeGraphState; indexDbs: string[] }
  | { ok: false; problem: CodeGraphStateProblem; detail: string };

/** Mirrors `canonicalPath` in `src/memory-config.ts`; keep the two in sync. */
export function canonicalWorkspacePath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/** Mirrors `sanitizeProjectName` in `src/memory-config.ts`; keep in sync. */
function sanitizeProjectName(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "project";
}

export function isWithinPath(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Resolve the code graph project directory for a workspace (default cwd). */
export function resolveCodeGraphProject(
  cwd: string = process.cwd(),
  paths: Pick<WorkbenchPaths, "codeGraphRoot" | "codeGraphProjects"> = WORKBENCH_PATHS,
): CodeGraphProject {
  const projectPath = canonicalWorkspacePath(cwd);
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
  const identifier = `${sanitizeProjectName(basename(projectPath))}-${hash}`;
  const root = resolve(paths.codeGraphProjects);
  const directory = assertWithinRoot(join(root, identifier), root);
  return {
    projectPath,
    identifier,
    directory,
    statePath: join(directory, CODE_GRAPH_STATE_FILE),
  };
}

/** Defensive lexical containment check. Physical containment needs the guard below. */
export function assertWithinRoot(child: string, parent: string): string {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  if (!isWithinPath(resolvedChild, resolvedParent)) {
    throw new Error(`Refusing to operate outside managed root: ${resolvedChild} is not within ${resolvedParent}`);
  }
  return resolvedChild;
}

export type ManagedProjectPathValidation =
  | { ok: true }
  | { ok: false; detail: string };

/**
 * Reject symlink traversal in extension-owned storage before any project
 * operation. Lexical containment alone is unsafe when an existing managed
 * path component is replaced with a symlink.
 */
export function validateManagedProjectPath(
  project: CodeGraphProject,
  paths: Pick<WorkbenchPaths, "codeGraphRoot" | "codeGraphProjects"> = WORKBENCH_PATHS,
): ManagedProjectPathValidation {
  const graphRoot = resolve(paths.codeGraphRoot);
  const projectsRoot = resolve(paths.codeGraphProjects);
  const expectedProject = resolve(projectsRoot, project.identifier);
  if (project.directory !== expectedProject || !isWithinPath(expectedProject, projectsRoot)) {
    return { ok: false, detail: `Managed project path is not the expected direct child of projects root: ${project.directory}` };
  }

  for (const candidate of [graphRoot, projectsRoot, expectedProject]) {
    try {
      const info = lstatSync(candidate);
      if (info.isSymbolicLink()) {
        return { ok: false, detail: `Refusing symlinked managed Code Graph path: ${candidate}` };
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        return { ok: false, detail: `Cannot inspect managed Code Graph path ${candidate}: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
  }

  if (!existsSync(projectsRoot)) return { ok: true };
  try {
    const canonicalProjectsRoot = realpathSync.native(projectsRoot);
    if (existsSync(expectedProject) && !isWithinPath(realpathSync.native(expectedProject), canonicalProjectsRoot)) {
      return { ok: false, detail: `Managed Code Graph project resolves outside projects root: ${expectedProject}` };
    }
  } catch (error) {
    return { ok: false, detail: `Cannot verify managed Code Graph containment: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true };
}

/** Parse and structurally validate state.json contents. */
export function parseCodeGraphState(raw: string): CodeGraphState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("state.json is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("state.json must contain a JSON object");
  }
  const state = parsed as Partial<CodeGraphState>;
  if (typeof state.schema !== "number" || !Number.isInteger(state.schema)) {
    throw new Error("state.json schema must be an integer");
  }
  for (const field of ["workspacePath", "identifier", "version", "resolvedUrl", "sha256", "createdAt", "updatedAt"] as const) {
    if (typeof state[field] !== "string" || state[field] === "") {
      throw new Error(`state.json ${field} must be a non-empty string`);
    }
  }
  return state as CodeGraphState;
}

function isValidTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value) && !Number.isNaN(Date.parse(value));
}

function listIndexDbs(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".db") && entry.name !== CBM_CONFIG_FILE)
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Decide whether the current workspace has a valid enablement state.
 * A valid state requires: a parseable schema-1 `state.json` whose
 * workspace path and identifier match this workspace, an installed asset
 * version, `_config.db`, and at least one CBM index database.
 */
export function validateCodeGraphState(
  project: CodeGraphProject,
  options: { readStateFile?: (path: string) => string | null } = {},
): CodeGraphStateValidation {
  const readStateFile = options.readStateFile ?? ((path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  });

  let directoryExists = false;
  let directoryIsDirectory = false;
  try {
    directoryExists = existsSync(project.directory);
    if (directoryExists) directoryIsDirectory = statSync(project.directory).isDirectory();
  } catch {
    directoryExists = false;
  }
  if (directoryExists && !directoryIsDirectory) {
    return { ok: false, problem: "not_a_directory", detail: `Expected a project directory at ${project.directory}` };
  }
  const raw = readStateFile(project.statePath);
  if (raw === null) {
    return {
      ok: false,
      problem: "missing",
      detail: directoryExists
        ? `Missing ${project.statePath}; project directory exists without a valid marker`
        : `No code graph data at ${project.directory}`,
    };
  }
  let state: CodeGraphState;
  try {
    state = parseCodeGraphState(raw);
  } catch (error) {
    return { ok: false, problem: "malformed_json", detail: error instanceof Error ? error.message : String(error) };
  }
  if (state.schema !== CODE_GRAPH_STATE_SCHEMA) {
    return { ok: false, problem: "unknown_schema", detail: `Unsupported state schema ${String(state.schema)}; supported: ${CODE_GRAPH_STATE_SCHEMA}` };
  }
  if (state.workspacePath !== project.projectPath) {
    return { ok: false, problem: "wrong_workspace", detail: `State belongs to ${state.workspacePath}, not ${project.projectPath}` };
  }
  if (state.identifier !== project.identifier) {
    return { ok: false, problem: "wrong_identifier", detail: `State identifier ${state.identifier} does not match ${project.identifier}` };
  }
  if (!parseAssetVersion(state.version)) {
    return { ok: false, problem: "invalid_asset_identity", detail: `State version ${state.version} is not vMAJOR.MINOR.PATCH` };
  }
  if (!/^[0-9a-f]{64}$/.test(state.sha256) || !state.resolvedUrl.startsWith("https://")) {
    return { ok: false, problem: "invalid_asset_identity", detail: "State asset URL/SHA-256 fields are invalid" };
  }
  if (!isValidTimestamp(state.createdAt) || !isValidTimestamp(state.updatedAt)) {
    return { ok: false, problem: "invalid_timestamps", detail: "State timestamps are not valid ISO-8601 strings" };
  }
  if (!existsSync(join(project.directory, CBM_CONFIG_FILE))) {
    return { ok: false, problem: "missing_config_db", detail: `Missing ${CBM_CONFIG_FILE}; CBM was not configured for this workspace` };
  }
  const indexDbs = listIndexDbs(project.directory);
  if (indexDbs.length === 0) {
    return {
      ok: false,
      problem: "missing_index_db",
      detail: "No CBM index database found; the index may be corrupted. Check the data directory or run /wb:code-graph off.",
    };
  }
  return { ok: true, state, indexDbs };
}

export interface WriteStateOptions {
  rename?: (oldPath: string, newPath: string) => Promise<void>;
}

/**
 * Atomically publish state.json: write a sibling temp file, fsync it,
 * rename over state.json, then fsync the directory (best effort). Readers
 * can never observe a partial marker.
 */
export async function writeCodeGraphStateAtomic(
  project: CodeGraphProject,
  state: CodeGraphState,
  options: WriteStateOptions = {},
): Promise<void> {
  const rename = options.rename ?? renamePath;
  const tempPath = `${project.statePath}.${process.pid}-${Date.now().toString(36)}.tmp`;
  const handle = await open(tempPath, "w");
  try {
    await handle.writeFile(JSON.stringify(state, null, 2) + "\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tempPath, project.statePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  try {
    const dirHandle = await open(dirname(project.statePath), "r");
    try {
      await dirHandle.sync();
    } catch {
      // Directory fsync is unsupported on some platforms; the rename
      // already committed the marker.
    } finally {
      await dirHandle.close();
    }
  } catch {
    // Directory open failure is non-fatal for the committed rename.
  }
}

/** Build state for a freshly activated workspace. */
export function createCodeGraphState(
  project: CodeGraphProject,
  asset: { version: string; resolvedUrl: string; sha256: string },
  now: () => Date = () => new Date(),
): CodeGraphState {
  const timestamp = now().toISOString();
  return {
    schema: CODE_GRAPH_STATE_SCHEMA,
    workspacePath: project.projectPath,
    identifier: project.identifier,
    version: asset.version,
    resolvedUrl: asset.resolvedUrl,
    sha256: asset.sha256,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

// ─── Status and diagnostics ───────────────────────────────────────────

export type CodeGraphStateKind =
  | "off"
  | "enabled"
  | "corrupt"
  | "unsupported_platform"
  | "binary_missing"
  | "binary_incompatible"
  | "index_missing"
  | "mcp_failed"
  | "upgrade_pending"
  | "deletion_failed";

export interface CodeGraphStatusReport {
  kind: CodeGraphStateKind;
  workspacePath: string;
  identifier: string;
  projectDirectory: string;
  /** Platform key such as `linux-arm64`, or a diagnostic when unsupported. */
  platform: string;
  /** Packaged manifest version for this platform, when one exists. */
  manifestVersion?: string;
  /** Installed asset version, when a verified install record exists. */
  installedVersion?: string;
  mcpRegistered?: boolean;
  indexSummary?: string;
  watcher?: "git" | "disabled_non_git" | "unknown";
  lastError?: string;
  recovery?: string;
}

/** Human-readable status block for /wb:code-graph status. */
export function formatCodeGraphStatus(report: CodeGraphStatusReport): string[] {
  const label: Record<CodeGraphStateKind, string> = {
    off: "off",
    enabled: "enabled",
    corrupt: "corrupt (disabled)",
    unsupported_platform: "off (unsupported platform)",
    binary_missing: "off (binary missing)",
    binary_incompatible: "off (binary incompatible)",
    index_missing: "off (index missing)",
    mcp_failed: "off (MCP failed)",
    upgrade_pending: "off (migration/reindex required)",
    deletion_failed: "off (deletion failed)",
  };
  const lines = [
    "Code Graph (codebase-memory-mcp)",
    `  State:     ${label[report.kind]}`,
    `  Workspace: ${report.workspacePath}`,
    `  Project:   ${report.identifier}`,
    `  Data:      ${report.projectDirectory}`,
    `  Platform:  ${report.platform}`,
  ];
  if (report.manifestVersion) lines.push(`  Packaged:  ${report.manifestVersion}`);
  if (report.installedVersion) lines.push(`  Installed: ${report.installedVersion}`);
  if (typeof report.mcpRegistered === "boolean") {
    lines.push(`  MCP:       ${report.mcpRegistered ? "registered" : "not registered"}`);
  }
  if (report.indexSummary) lines.push(`  Index:     ${report.indexSummary}`);
  if (report.watcher) {
    lines.push(
      `  Watcher:   ${
        report.watcher === "git"
          ? "Git watcher enabled"
          : report.watcher === "disabled_non_git"
            ? "disabled (non-Git workspace)"
            : "unknown"
      }`,
    );
  }
  if (report.lastError) lines.push(`  Last error: ${report.lastError}`);
  if (report.recovery) lines.push(`  Recovery:  ${report.recovery}`);
  return lines;
}

export function isGitWorkspace(projectPath: string): boolean {
  return existsSync(join(projectPath, ".git"));
}
