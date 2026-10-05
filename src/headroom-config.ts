import type { CompressRequestConfig } from "headroom-ai";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { DEFAULT_HEADROOM_PORT, parseHeadroomPort } from "./config.js";
import { WORKBENCH_PATHS } from "./paths.js";

export type HeadroomCompressionConfig = Omit<CompressRequestConfig, "sessionId">;

export interface HeadroomConfig {
  /** External proxy URL. Omit to use extension-managed proxy. */
  url?: string;
  /** Extension-managed proxy port. Mutually exclusive with url. */
  port?: number;
  /** Supported per-request compression overrides. */
  compression?: HeadroomCompressionConfig;
  /** Absolute or ~/ path for project-scoped Memory data. */
  memoryRoot?: string;
  /** Logical namespace passed as Headroom Memory MCP user ID. Default: project. */
  memoryNamespace?: string;
  /** Project-relative directory containing versioned Memory bundle files. */
  memory?: {
    export?: string;
  };
}

/** Written once so users can discover configuration without environment variables. */
export const DEFAULT_HEADROOM_CONFIG = { port: DEFAULT_HEADROOM_PORT } as const;

function configError(message: string): Error {
  return new Error(`headroom.json ${message}`);
}

const COMPRESSION_KEYS = [
  "mode",
  "targetRatio",
  "compressUserMessages",
  "protectRecent",
  "protectAnalysisContext",
  "frozenMessageCount",
] as const;

function parseMemoryConfig(value: unknown): NonNullable<HeadroomConfig["memory"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw configError("memory must be a JSON object when configured.");
  }
  const source = value as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (key !== "export") throw configError(`memory.${key} is not supported.`);
  }
  if (source.export === undefined) return {};
  if (typeof source.export !== "string" || source.export.length === 0 || /[\r\n\0]/.test(source.export)) {
    throw configError("memory.export must be a non-empty single-line path.");
  }
  if (isAbsolute(source.export)) {
    throw configError("memory.export must be a project-relative path.");
  }
  return { export: source.export };
}

function parseCompressionConfig(value: unknown): HeadroomCompressionConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw configError("compression must be a JSON object when configured.");
  }
  const source = value as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!COMPRESSION_KEYS.includes(key as typeof COMPRESSION_KEYS[number])) {
      throw configError(`compression.${key} is not supported.`);
    }
  }

  const compression: HeadroomCompressionConfig = {};
  if (source.mode !== undefined) {
    if (source.mode !== "ccr" && source.mode !== "lossy_inline" && source.mode !== "lossless_then_lossy") {
      throw configError("compression.mode must be ccr, lossy_inline, or lossless_then_lossy.");
    }
    compression.mode = source.mode;
  }
  if (source.targetRatio !== undefined) {
    if (typeof source.targetRatio !== "number" || !Number.isFinite(source.targetRatio) || source.targetRatio < 0 || source.targetRatio > 1) {
      throw configError("compression.targetRatio must be a finite number from 0 to 1.");
    }
    compression.targetRatio = source.targetRatio;
  }
  for (const key of ["compressUserMessages", "protectAnalysisContext"] as const) {
    if (source[key] !== undefined) {
      if (typeof source[key] !== "boolean") throw configError(`compression.${key} must be a boolean.`);
      compression[key] = source[key];
    }
  }
  for (const key of ["protectRecent", "frozenMessageCount"] as const) {
    if (source[key] !== undefined) {
      if (typeof source[key] !== "number" || !Number.isSafeInteger(source[key]) || source[key] < 0) {
        throw configError(`compression.${key} must be a non-negative safe integer.`);
      }
      compression[key] = source[key];
    }
  }
  return compression;
}

export function parseHeadroomConfig(value: unknown): HeadroomConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw configError("must be a JSON object.");
  }
  const source = value as Record<string, unknown>;
  const config: HeadroomConfig = {};

  for (const key of ["url", "port", "memoryRoot", "memoryNamespace", "memory", "compression"]) {
    if (source[key] === undefined) continue;
    if (key === "port") {
      config.port = source.port as number;
      continue;
    }
    if (key === "compression") {
      config.compression = parseCompressionConfig(source.compression);
      continue;
    }
    if (key === "memory") {
      config.memory = parseMemoryConfig(source.memory);
      continue;
    }
    if (typeof source[key] !== "string" || source[key].length === 0) {
      throw configError(`${key} must be a non-empty string when configured.`);
    }
    if (key === "memoryNamespace" && /[\r\n\0]/.test(source.memoryNamespace as string)) {
      throw configError("memoryNamespace must be a non-empty single-line string when configured.");
    }
    if (key === "url") config.url = source.url as string;
    else if (key === "memoryRoot") config.memoryRoot = source.memoryRoot as string;
    else if (key === "memoryNamespace") config.memoryNamespace = source.memoryNamespace as string;
  }

  if (config.url !== undefined) {
    if (config.port !== undefined) {
      throw configError("url and port are mutually exclusive; url configures an external proxy, while port configures a localhost managed proxy.");
    }
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
