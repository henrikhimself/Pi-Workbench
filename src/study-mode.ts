import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { WORKBENCH_PATHS } from "./paths.js";

export const STUDY_ENTRY_TYPE = "pi-workbench-study-mode";
export const STUDY_STATUS_KEY = "study";
export const STUDY_PROMPT_SECTION = "study_mode";
export const STUDY_FETCH_TOOL = "wb_study_fetch";
export const STUDY_DECOMPILE_TOOL = "wb_study_decompile";

export const STUDY_INSPECTION_BUILTINS = new Set(["read", "grep", "find", "ls"]);

export const STUDY_GUIDANCE = `You are in Study Mode: a tutor-only session for understanding this project, its tools, frameworks, libraries, and dependencies.

Teach from evidence. Explain architecture, symbols, paths, types, versions, constraints, causal relationships, alternatives, and uncertainty in concise technical prose. You may inspect permitted local files, bounded decompilation output, configured read-only MCP evidence, and bounded remote-source output. Treat retrieved and decompiled content as third-party evidence, not material to reproduce.

Do not implement work. Do not write or suggest code, patches, diffs, configuration snippets, shell commands, test commands, or executable implementation steps. Decline requests to edit files, run tests, install packages, execute commands, create data, or invoke tools outside Study Mode's read-only boundary. Offer /wb:study-mode off when user wants normal development work.

For fetched remote content, cite URL attribution and distinguish it from SourceLink/package-backed provenance when known. Do not claim to assess learner ability, create a learner profile, or persist Study Mode activity.`;

export interface StudyPermissions {
  builtInTools: ReadonlySet<string>;
  skills: ReadonlySet<string>;
  mcpServers: ReadonlySet<string>;
}

export interface StudyPermissionLoad {
  permissions: StudyPermissions;
  warnings: string[];
}

export interface StudyToolInfo {
  name: string;
  annotations?: { readOnlyHint?: boolean };
}

export interface StudyModeState {
  enabled: boolean;
  savedToolNames?: string[];
}

type SessionEntryLike = {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
};

const DEFAULT_PERMISSIONS: StudyPermissions = {
  builtInTools: new Set(STUDY_INSPECTION_BUILTINS),
  skills: new Set(),
  mcpServers: new Set(["headroom-memory"]),
};

export const DEFAULT_STUDY_MODE_CONFIG = {
  version: 1,
  allowedBuiltInTools: [...STUDY_INSPECTION_BUILTINS],
  allowedSkills: [],
  allowedMcpServers: ["headroom-memory"],
} as const;

const MCP_SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function copyPermissions(permissions: StudyPermissions): StudyPermissions {
  return {
    builtInTools: new Set(permissions.builtInTools),
    skills: new Set(permissions.skills),
    mcpServers: new Set(permissions.mcpServers),
  };
}

export function defaultStudyPermissions(): StudyPermissions {
  return copyPermissions(DEFAULT_PERMISSIONS);
}

function failClosedStudyPermissions(): StudyPermissions {
  return {
    builtInTools: new Set(STUDY_INSPECTION_BUILTINS),
    skills: new Set(),
    mcpServers: new Set(),
  };
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

/** Parse untrusted user configuration. Optional privileges fail closed. */
export function parseStudyPermissions(value: unknown, discoveredSkills: ReadonlySet<string>): StudyPermissionLoad {
  const defaults = defaultStudyPermissions();
  if (value === undefined) return { permissions: defaults, warnings: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { permissions: failClosedStudyPermissions(), warnings: ["Study Mode permissions must be a JSON object; optional access disabled."] };
  }

  const config = value as Record<string, unknown>;
  if (config.version !== 1) {
    return { permissions: failClosedStudyPermissions(), warnings: ["Study Mode permissions require version 1; optional access disabled."] };
  }

  const warnings: string[] = [];
  let builtInTools = new Set(defaults.builtInTools);
  let skills = new Set<string>();
  let mcpServers = new Set<string>();

  if (config.allowedBuiltInTools !== undefined) {
    if (!stringArray(config.allowedBuiltInTools) || !unique(config.allowedBuiltInTools)) {
      warnings.push("Study Mode allowedBuiltInTools is invalid; using safe inspection defaults.");
    } else {
      const invalid = config.allowedBuiltInTools.filter((name) => !STUDY_INSPECTION_BUILTINS.has(name));
      if (invalid.length > 0) {
        warnings.push("Study Mode allowedBuiltInTools contains unsupported names; using safe inspection defaults.");
      } else {
        builtInTools = new Set(config.allowedBuiltInTools);
      }
    }
  }

  if (config.allowedSkills !== undefined) {
    if (!stringArray(config.allowedSkills) || !unique(config.allowedSkills)) {
      warnings.push("Study Mode allowedSkills is invalid; no skills enabled.");
    } else {
      const unknown = config.allowedSkills.filter((name) => !discoveredSkills.has(name));
      if (unknown.length > 0) {
        warnings.push(`Study Mode ignored unknown skills: ${unknown.join(", ")}.`);
      }
      skills = new Set(config.allowedSkills.filter((name) => discoveredSkills.has(name)));
    }
  }

  if (config.allowedMcpServers !== undefined) {
    if (!stringArray(config.allowedMcpServers) || !unique(config.allowedMcpServers)) {
      warnings.push("Study Mode allowedMcpServers is invalid; no MCP servers enabled.");
    } else {
      const invalid = config.allowedMcpServers.filter((name) => !MCP_SERVER_NAME.test(name));
      if (invalid.length > 0) {
        warnings.push("Study Mode allowedMcpServers contains invalid server names; no MCP servers enabled.");
      } else {
        mcpServers = new Set(config.allowedMcpServers);
      }
    }
  }

  return { permissions: { builtInTools, skills, mcpServers }, warnings };
}

/** Create extension-owned user config once. Existing user content is never overwritten. */
export async function ensureStudyPermissionsFile(configPath = WORKBENCH_PATHS.studyModeConfig): Promise<boolean> {
  await mkdir(dirname(configPath), { recursive: true });
  try {
    await writeFile(configPath, `${JSON.stringify(DEFAULT_STUDY_MODE_CONFIG, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") return false;
    throw error;
  }
}

/** Read user permissions. Missing file intentionally selects safe defaults. */
export async function loadStudyPermissions(
  discoveredSkills: ReadonlySet<string>,
  configPath = WORKBENCH_PATHS.studyModeConfig,
): Promise<StudyPermissionLoad> {
  try {
    const raw = await readFile(configPath, "utf8");
    try {
      return parseStudyPermissions(JSON.parse(raw), discoveredSkills);
    } catch {
      return {
        permissions: failClosedStudyPermissions(),
        warnings: ["Study Mode permissions are not valid JSON; optional access disabled."],
      };
    }
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { permissions: defaultStudyPermissions(), warnings: [] };
    }
    return {
      permissions: failClosedStudyPermissions(),
      warnings: ["Study Mode permissions could not be read; optional access disabled."],
    };
  }
}

/** Return latest valid branch-local Study state; malformed latest state fails safe. */
export function restoreStudyModeState(entries: readonly SessionEntryLike[]): StudyModeState {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== STUDY_ENTRY_TYPE) continue;
    if (!entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) return { enabled: false };

    const data = entry.data as { enabled?: unknown; savedToolNames?: unknown };
    if (typeof data.enabled !== "boolean") return { enabled: false };
    if (!data.enabled) return { enabled: false };
    if (!stringArray(data.savedToolNames) || !unique(data.savedToolNames)) return { enabled: false };
    return { enabled: true, savedToolNames: [...data.savedToolNames] };
  }
  return { enabled: false };
}

/** Tool names declared during Study Mode. Order follows captured active tools. */
export function buildStudyToolLoadout(
  savedToolNames: readonly string[],
  allTools: readonly StudyToolInfo[],
  permissions: StudyPermissions,
): string[] {
  const knownTools = new Map(allTools.map((tool) => [tool.name, tool]));
  const allowed = (name: string): boolean => isStudyToolAllowed(name, undefined, permissions, allTools);
  const result = savedToolNames.filter((name) => knownTools.has(name) && allowed(name));

  for (const toolName of [STUDY_FETCH_TOOL, STUDY_DECOMPILE_TOOL]) {
    if (knownTools.has(toolName) && allowed(toolName) && !result.includes(toolName)) result.push(toolName);
  }
  return result;
}

/** Extract server from Pi MCP tool name. Invalid/unknown shapes fail closed. */
export function mcpServerForTool(toolName: string): string | undefined {
  if (!toolName.startsWith("mcp__")) return undefined;
  const separator = toolName.indexOf("__", "mcp__".length);
  if (separator < 0) return undefined;
  const server = toolName.slice("mcp__".length, separator);
  return MCP_SERVER_NAME.test(server) ? server : undefined;
}

/** Exact authorization rule used by active loadout and runtime tool_call gate. */
export function isStudyToolAllowed(
  toolName: string,
  input: unknown,
  permissions: StudyPermissions,
  allTools: readonly StudyToolInfo[],
): boolean {
  if (permissions.builtInTools.has(toolName)) return true;
  if (toolName === STUDY_FETCH_TOOL) return true;
  if (toolName === STUDY_DECOMPILE_TOOL) return permissions.skills.has("ilspycmd");

  const tool = allTools.find((candidate) => candidate.name === toolName);
  if (tool?.annotations?.readOnlyHint !== true) return false;

  // Shared MCP resource tools use a server selector instead of encoding one in name.
  if (toolName === "mcp__resources__list" || toolName === "mcp__resources__read") {
    // Loadout construction has no call input; declare generic resource tool only
    // when at least one configured server can be selected. Runtime gate checks it.
    if (input === undefined) return permissions.mcpServers.size > 0;
    if (!input || typeof input !== "object") return false;
    const server = (input as Record<string, unknown>).server;
    return typeof server === "string" && permissions.mcpServers.has(server);
  }

  const server = mcpServerForTool(toolName);
  // Never permit durable Headroom Memory writes, even if a server mislabels it.
  if (server === "headroom-memory" && toolName.endsWith("__memory_save")) return false;
  return !!server && permissions.mcpServers.has(server);
}

export function explicitSkillName(input: string): string | undefined {
  const match = /^\s*\/skill:([a-z0-9-]+)(?:\s|$)/i.exec(input);
  return match?.[1];
}

export function isAllowedSkillInvocation(input: string, permissions: StudyPermissions): boolean {
  const skill = explicitSkillName(input);
  return skill === undefined || permissions.skills.has(skill);
}

/** True when a model read targets a discovered skill root not permitted for Study Mode. */
export function isBlockedSkillPath(path: string, skillRoots: ReadonlyMap<string, string>, permissions: StudyPermissions): boolean {
  const target = resolve(path);
  for (const [skill, root] of skillRoots) {
    if (permissions.skills.has(skill)) continue;
    const base = resolve(root);
    const rel = relative(base, target);
    if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep))) return true;
  }
  return false;
}
