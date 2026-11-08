import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { WORKBENCH_PATHS, type WorkbenchPaths } from "./paths.js";
import { formatStatus } from "./command-messages.js";
import { TOOL_NAMES } from "./tool-names.js";
import { parseAssetVersion } from "./code-graph-assets.js";
import { checkOptIn, readOptInFile } from "./project-opt-in.js";
import { requireSchemaVersion } from "./schema-version.js";
import { readStoreIdentity, STORE_MARKER, type CodeGraphStoreIdentity } from "./store-identity.js";

/**
 * Standalone codebase-memory-mcp (CBM) configuration, workspace identity,
 * and per-workspace enablement. A workspace is on when its directory holds `opt-in.json` (written last)
 * and a matching `workbench-identity.json` (written first, never updated).
 *
 * The data root is `~/.pi/pi-workbench/codebase-memory-mcp` and is separate
 * from Headroom Memory data. Workspace identity reuses the Headroom Memory
 * hashing semantics (sanitized canonical basename + 16 hex chars of SHA-256
 * canonical path) without importing or sharing any Memory store.
 */

export const CODE_GRAPH_OPT_IN_FILE = "opt-in.json";
export const CBM_CONFIG_FILE = "_config.db";

export interface CodeGraphProject {
  /** Canonical (symlink-resolved) absolute workspace path. */
  projectPath: string;
  /** `<sanitized-basename>-<sha256-16>` workspace identifier. */
  identifier: string;
  /** `projects/<identifier>` directory holding all CBM data for this workspace. */
  directory: string;
  /** Present means on. Written last, when activation has succeeded. */
  optInPath: string;
  /** Names the exact backend that wrote the data. Written first, never updated. */
  identityPath: string;
}

export type CodeGraphStateProblem =
  | "missing"
  | "not_a_directory"
  | "wrong_workspace"
  | "wrong_identifier"
  | "missing_identity"
  | "invalid_asset_identity"
  | "missing_config_db"
  | "missing_index_db"
  | "read_error";

export type CodeGraphStateValidation =
  | { ok: true; identity: CodeGraphStoreIdentity; indexDbs: string[] }
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
    optInPath: join(directory, CODE_GRAPH_OPT_IN_FILE),
    identityPath: join(directory, STORE_MARKER),
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

const IDENTITY_KEYS = ["schemaVersion", "layout", "kind", "codeGraphVersion", "resolvedUrl", "sha256"];

/** The identity this release would write for an installed backend. */
export function codeGraphIdentity(asset: { version: string; resolvedUrl: string; sha256: string }): CodeGraphStoreIdentity {
  return { schemaVersion: 1, layout: 1, kind: "code-graph", codeGraphVersion: asset.version, resolvedUrl: asset.resolvedUrl, sha256: asset.sha256 };
}

/**
 * Decide whether the current workspace is on. That needs `opt-in.json` for this workspace, a
 * well-formed `workbench-identity.json`, `_config.db`, and at least one CBM index database.
 * Files with another `schemaVersion` or unexpected keys are refused as `read_error`; nothing is
 * read leniently, converted or repaired.
 */
export async function validateCodeGraphState(project: CodeGraphProject): Promise<CodeGraphStateValidation> {
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
  const failure = (problem: CodeGraphStateProblem, error: unknown): CodeGraphStateValidation =>
    ({ ok: false, problem, detail: error instanceof Error ? error.message : String(error) });
  let optIn: unknown;
  try { optIn = await readOptInFile(project.optInPath); } catch (error) { return failure("read_error", error); }
  if (optIn === null) {
    return {
      ok: false,
      problem: "missing",
      detail: directoryExists
        ? `No ${CODE_GRAPH_OPT_IN_FILE} in ${project.directory}; Code Graph is off for this workspace`
        : `No code graph data at ${project.directory}`,
    };
  }
  try {
    requireSchemaVersion(optIn, "Project opt-in");
    const record = optIn as Record<string, unknown>;
    if (record.projectPath !== project.projectPath) {
      return { ok: false, problem: "wrong_workspace", detail: `Opt-in belongs to ${String(record.projectPath)}, not ${project.projectPath}` };
    }
    if (record.identifier !== project.identifier) {
      return { ok: false, problem: "wrong_identifier", detail: `Opt-in identifier ${String(record.identifier)} does not match ${project.identifier}` };
    }
    checkOptIn(project, optIn);
  } catch (error) { return failure("read_error", error); }
  let raw: Record<string, unknown> | null;
  try { raw = await readStoreIdentity(project.directory); } catch (error) { return failure("read_error", error); }
  if (raw === null) {
    return { ok: false, problem: "missing_identity", detail: `Missing ${STORE_MARKER}; the project directory has an opt-in but no record of the backend that wrote it` };
  }
  if (raw.layout !== 1 || raw.kind !== "code-graph" || Object.keys(raw).some((key) => !IDENTITY_KEYS.includes(key))) {
    return { ok: false, problem: "read_error", detail: `${STORE_MARKER} is not a Code Graph identity` };
  }
  const identity = raw as unknown as CodeGraphStoreIdentity;
  if (typeof identity.codeGraphVersion !== "string" || !parseAssetVersion(identity.codeGraphVersion)) {
    return { ok: false, problem: "invalid_asset_identity", detail: `Identity version ${String(identity.codeGraphVersion)} is not vMAJOR.MINOR.PATCH` };
  }
  if (typeof identity.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(identity.sha256) ||
      typeof identity.resolvedUrl !== "string" || !identity.resolvedUrl.startsWith("https://")) {
    return { ok: false, problem: "invalid_asset_identity", detail: "Identity asset URL/SHA-256 fields are invalid" };
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
  return { ok: true, identity, indexDbs };
}

// ─── Status and diagnostics ───────────────────────────────────────────

export type CodeGraphStateKind =
  | "off"
  | "enabled"
  | "corrupt"
  | "binary_missing"
  | "mcp_failed"
  | "upgrade_pending"
  | "locked";

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

/** Human-readable status block for /wb:code-graph status, in the layout shared by all four tools. */
export function formatCodeGraphStatus(report: CodeGraphStatusReport): string[] {
  const state: Record<CodeGraphStateKind, string> = {
    off: "off",
    enabled: "on",
    corrupt: "off (corrupt data)",
    binary_missing: "off (binary missing)",
    mcp_failed: "off (MCP failed)",
    upgrade_pending: "refused (data written by another version)",
    locked: "off (project locked)",
  };
  // A refused project shows the shared refusal text as its problem; every other kind shows the last error.
  const refused = report.kind === "upgrade_pending";
  const problem = refused ? report.recovery : report.lastError;
  const details = [`Platform: ${report.platform}`];
  if (report.indexSummary) details.push(`Index: ${report.indexSummary}`);
  if (report.watcher) {
    details.push(`Watcher: ${
      report.watcher === "git" ? "Git watcher enabled" : report.watcher === "disabled_non_git" ? "disabled (non-Git workspace)" : "unknown"
    }`);
  }
  if (refused && report.lastError) details.push(`Last error: ${report.lastError}`);
  if (!refused && report.recovery) details.push(`Recovery: ${report.recovery}`);
  return formatStatus(TOOL_NAMES.codeGraph, {
    state: state[report.kind],
    projectPath: report.workspacePath,
    identifier: report.identifier,
    data: existsSync(report.projectDirectory) ? report.projectDirectory : null,
    ...(report.manifestVersion || report.installedVersion
      ? { version: { installed: report.installedVersion ?? null, ...(report.manifestVersion ? { expected: report.manifestVersion } : {}) } }
      : {}),
    ...(typeof report.mcpRegistered === "boolean" ? { link: report.mcpRegistered ? "registered" : "not registered" } : {}),
    ...(problem ? { problem } : {}),
    details,
  });
}

export function isGitWorkspace(projectPath: string): boolean {
  return existsSync(join(projectPath, ".git"));
}
