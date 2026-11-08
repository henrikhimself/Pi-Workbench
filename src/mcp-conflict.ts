import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Pi gives `mcp.json` precedence over servers an extension registers, and silently drops the
 * extension's registration when the names collide. Workbench therefore checks first, refuses to
 * register, and says which server and file are responsible.
 */

/** Pi's `mcpNamespace`: names that differ only in `-` and `_` share a tool namespace. */
export const mcpNamespaceKey = (name: string): string => name.replace(/-/g, "_");

export interface McpConflictOptions {
  serverName: string;
  /** Workspace directory; the project `mcp.json` lives in `<cwd>/<CONFIG_DIR_NAME>/mcp.json`. */
  cwd: string;
  agentDir?: () => string;
  /** Pi reads the project `mcp.json` only for trusted projects. Defaults to trusted (stricter). */
  projectTrusted?: () => boolean;
  /** True while the registration under this name is Workbench's own. */
  ownRegistration?: boolean;
  /** Playwright insists on the full public MCP API; Memory and Code Graph skip the checks that need it. */
  requireApis?: boolean;
}

const stripBom = (text: string): string => text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

/** Returns a short description of the conflict, or null when registering is safe. */
export async function detectMcpConflict(pi: ExtensionAPI, options: McpConflictOptions): Promise<string | null> {
  const { serverName } = options;
  const key = mcpNamespaceKey(serverName);
  const registryApi = typeof pi.registerMcpServer === "function" && typeof pi.unregisterMcpServer === "function" && typeof pi.getMcpServers === "function";
  if (options.requireApis && (!registryApi || typeof pi.getAllTools !== "function" || typeof pi.getActiveTools !== "function")) return "required public Pi MCP APIs unavailable";
  if (typeof pi.getMcpServers === "function") {
    const existing = pi.getMcpServers().find(server => mcpNamespaceKey(server.name) === key);
    if (existing && !options.ownRegistration) return `same-name extension MCP registration "${existing.name}"`;
  }
  const files = [join((options.agentDir ?? getAgentDir)(), "mcp.json")];
  if (options.projectTrusted?.() ?? true) files.push(join(options.cwd, CONFIG_DIR_NAME, "mcp.json"));
  for (const path of files) {
    let raw: string;
    try { raw = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; return "MCP configuration cannot be inspected safely"; }
    let config: any;
    try { config = JSON.parse(stripBom(raw)); } catch { return "MCP configuration is invalid; conflict cannot be ruled out"; }
    if (!config || typeof config !== "object" || Array.isArray(config) || config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers))) return "MCP configuration shape is invalid";
    const declared = Object.keys(config.mcpServers ?? {}).find(name => mcpNamespaceKey(name) === key);
    if (declared !== undefined) return `same-name MCP declaration "${declared}" in ${path}`;
  }
  return null;
}
