import type { CompressRequestConfig } from "headroom-ai";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { DEFAULT_HEADROOM_PORT, parseHeadroomPort } from "./config.js";
import { WORKBENCH_PATHS } from "./paths.js";

export type HeadroomCompressionConfig = Omit<CompressRequestConfig, "sessionId">;

export interface HeadroomConfig {
  /** Explicit fresh-layout configuration; pre-refactor files are never converted. */
  schemaVersion: 1;
  /** Extension-managed loopback proxy port. */
  port?: number;
  /** Supported per-request compression overrides. */
  compression?: HeadroomCompressionConfig;
  memory?: {
    /** Absolute or ~/ path for project-scoped Memory data. */
    root?: string;
    /** Logical namespace passed as Headroom Memory MCP user ID. Default: project. */
    namespace?: string;
    /** Project-relative directory containing versioned Memory bundle files. */
    export?: string;
  };
}

/** Written once so users can discover configuration without environment variables. */
export const DEFAULT_HEADROOM_CONFIG = { schemaVersion: 1, port: DEFAULT_HEADROOM_PORT } as const;

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
    if (key !== "root" && key !== "namespace" && key !== "export") throw configError(`memory.${key} is not supported.`);
  }
  const memory: NonNullable<HeadroomConfig["memory"]> = {};
  if (source.root !== undefined) {
    if (typeof source.root !== "string" || source.root.length === 0) {
      throw configError("memory.root must be a non-empty string when configured.");
    }
    memory.root = source.root;
  }
  if (source.namespace !== undefined) {
    if (typeof source.namespace !== "string" || source.namespace.length === 0 || /[\r\n\0]/.test(source.namespace)) {
      throw configError("memory.namespace must be a non-empty single-line string when configured.");
    }
    memory.namespace = source.namespace;
  }
  if (source.export === undefined) return memory;
  if (typeof source.export !== "string" || source.export.length === 0 || /[\r\n\0]/.test(source.export)) {
    throw configError("memory.export must be a non-empty single-line path.");
  }
  if (isAbsolute(source.export)) {
    throw configError("memory.export must be a project-relative path.");
  }
  return { ...memory, export: source.export };
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
  if ("url" in source) throw configError("url is unsupported; only extension-managed Headroom is allowed.");
  if (source.schemaVersion !== 1) throw configError("requires fresh schemaVersion: 1 configuration. Existing file was not changed; replace it manually using documented fresh setup.");
  const keys = ["schemaVersion", "port", "memory", "compression"];
  for (const key of Object.keys(source)) if (!keys.includes(key)) throw configError(`${key} is not supported.`);
  const config: HeadroomConfig = { schemaVersion: 1 };

  for (const key of ["port", "memory", "compression"]) {
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
  }

  config.port = parseHeadroomPort(config.port);

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

/** Factory-safe synchronous load. File creation is deferred until opted-in feature use. */
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
