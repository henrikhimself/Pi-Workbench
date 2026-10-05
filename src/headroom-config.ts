import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_HEADROOM_PORT, parseHeadroomPort } from "./config.js";
import { WORKBENCH_PATHS } from "./paths.js";

export interface HeadroomConfig {
  /** External proxy URL. Omit to use extension-managed proxy. */
  url?: string;
  /** Extension-managed proxy port. Ignored when url is configured. */
  port?: number;
  /** Absolute or ~/ path for project-scoped Memory data. */
  memoryRoot?: string;
  /** Logical identity passed to Headroom Memory MCP server. */
  memoryUser?: string;
}

/** Written once so users can discover configuration without environment variables. */
export const DEFAULT_HEADROOM_CONFIG = { port: DEFAULT_HEADROOM_PORT } as const;

function configError(message: string): Error {
  return new Error(`headroom.json ${message}`);
}

export function parseHeadroomConfig(value: unknown): HeadroomConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw configError("must be a JSON object.");
  }
  const source = value as Record<string, unknown>;
  const config: HeadroomConfig = {};

  for (const key of ["url", "port", "memoryRoot", "memoryUser"]) {
    if (source[key] === undefined) continue;
    if (key === "port") {
      // Preserve external-proxy behavior: port is irrelevant when url is set.
      config.port = source.port as number;
      continue;
    }
    if (typeof source[key] !== "string" || source[key].length === 0) {
      throw configError(`${key} must be a non-empty string when configured.`);
    }
    if (key === "url") config.url = source.url as string;
    else if (key === "memoryRoot") config.memoryRoot = source.memoryRoot as string;
    else if (key === "memoryUser") config.memoryUser = source.memoryUser as string;
  }

  if (config.url !== undefined) {
    let url: URL;
    try {
      url = new URL(config.url);
    } catch {
      throw configError(`url must be an absolute http(s) URL; received ${JSON.stringify(config.url)}.`);
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      throw configError(`url must be an unauthenticated absolute http(s) URL; received ${JSON.stringify(config.url)}.`);
    }
    config.url = url.toString().replace(/\/$/, "");
    delete config.port;
  } else {
    config.port = parseHeadroomPort(config.port);
  }

  return config;
}

/** Create extension-owned config once. Existing user settings are never overwritten. */
export async function ensureHeadroomConfigFile(configPath = WORKBENCH_PATHS.headroomConfig): Promise<boolean> {
  await mkdir(dirname(configPath), { recursive: true });
  try {
    await writeFile(configPath, `${JSON.stringify(DEFAULT_HEADROOM_CONFIG, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") return false;
    throw error;
  }
}

function parseHeadroomConfigText(raw: string): HeadroomConfig {
  try {
    return parseHeadroomConfig(JSON.parse(raw));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("headroom.json")) throw error;
    throw configError("is not valid JSON.");
  }
}

export async function loadHeadroomConfig(configPath = WORKBENCH_PATHS.headroomConfig): Promise<HeadroomConfig> {
  try {
    return parseHeadroomConfigText(await readFile(configPath, "utf8"));
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { ...DEFAULT_HEADROOM_CONFIG };
    }
    throw error instanceof Error && error.message.startsWith("headroom.json")
      ? error
      : configError("could not be read.");
  }
}

/** Factory-safe synchronous load. File creation remains deferred to session_start. */
export function loadHeadroomConfigSync(configPath = WORKBENCH_PATHS.headroomConfig): HeadroomConfig {
  try {
    return parseHeadroomConfigText(readFileSync(configPath, "utf8"));
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { ...DEFAULT_HEADROOM_CONFIG };
    }
    throw error instanceof Error && error.message.startsWith("headroom.json")
      ? error
      : configError("could not be read.");
  }
}

/** Legacy environment variables are deliberately ignored by extension runtime. */
export function hasLegacyHeadroomEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["HEADROOM_URL", "HEADROOM_PORT", "HEADROOM_MEMORY_ROOT", "HEADROOM_MEMORY_USER"].some((key) => env[key] !== undefined);
}
