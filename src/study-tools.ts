import { realpath } from "node:fs/promises";
import { lookup as lookupDns } from "node:dns/promises";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { Type } from "typebox";

export const STUDY_OUTPUT_LIMIT = 64 * 1024;
export const STUDY_TIMEOUT_MS = 10_000;
export const STUDY_FETCH_REDIRECT_LIMIT = 3;

export const StudyDecompileParameters = Type.Object({
  assemblyPath: Type.String({ description: "Absolute path to approved local .NET DLL." }),
  operation: Type.Union([Type.Literal("list-types"), Type.Literal("decompile-type")]),
  typeName: Type.Optional(Type.String({ description: "Fully qualified type name; required for decompile-type." })),
});

export const StudyFetchParameters = Type.Object({
  url: Type.String({ description: "Absolute public HTTPS URL for one source or documentation document." }),
});

export type StudyDecompileParams = {
  assemblyPath: string;
  operation: "list-types" | "decompile-type";
  typeName?: string;
};

export type StudyFetchParams = { url: string };

export type StudyTextResult = {
  text: string;
  truncated: boolean;
};

export type StudyDecompileResult = StudyTextResult & {
  assemblyPath: string;
  operation: StudyDecompileParams["operation"];
  typeName?: string;
};

export type StudyFetchResult = StudyTextResult & {
  requestedUrl: string;
  finalUrl: string;
  redirectChain: string[];
  contentType?: string;
  retrievedAt: string;
};

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

/** Resolve a DLL only inside project build outputs or NuGet package cache. */
export async function resolveStudyAssembly(assemblyPath: string, cwd: string): Promise<string> {
  if (extname(assemblyPath).toLowerCase() !== ".dll") {
    throw new Error("Study decompilation only accepts .dll assemblies.");
  }

  let target: string;
  try {
    target = await realpath(assemblyPath);
  } catch {
    throw new Error("Study decompilation assembly path is unavailable.");
  }

  const roots = [join(resolve(cwd), "bin"), join(resolve(cwd), "obj"), join(homedir(), ".nuget", "packages")];
  for (const root of roots) {
    try {
      const declaredRoot = resolve(root);
      const resolvedRoot = await realpath(declaredRoot);
      // A symlinked approved root would turn an in-root check into an escape.
      if (resolvedRoot !== declaredRoot) continue;
      if (isWithin(resolvedRoot, target)) return target;
    } catch {
      // Optional build/cache root does not exist.
    }
  }
  throw new Error("Study decompilation assembly must be under project bin/obj or ~/.nuget/packages.");
}

export function buildIlspyArguments(params: StudyDecompileParams, assemblyPath: string): string[] {
  if (params.operation === "list-types") {
    if (params.typeName !== undefined) throw new Error("Study list-types does not accept typeName.");
    return ["--disable-updatecheck", "-l", "class,interface,struct,delegate,enum", assemblyPath];
  }
  if (!params.typeName || !/^[A-Za-z_][A-Za-z0-9_.+`]*$/.test(params.typeName)) {
    throw new Error("Study decompilation requires an exact fully qualified type name.");
  }
  return ["--disable-updatecheck", "-t", params.typeName, assemblyPath];
}

export type CommandRunner = (command: string, args: readonly string[], signal?: AbortSignal) => Promise<StudyTextResult>;

/** Run an executable without a shell and stop on timeout, abort, or output cap. */
export const runBoundedCommand: CommandRunner = (command, args, signal) => new Promise((resolveResult, reject) => {
  const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  let bytes = 0;
  let truncated = false;
  let settled = false;

  const finish = (callback: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    callback();
  };
  const abort = () => {
    child.kill();
    finish(() => reject(new Error("Study investigation was cancelled.")));
  };
  const timeout = setTimeout(() => {
    child.kill();
    finish(() => reject(new Error("Study investigation timed out.")));
  }, STUDY_TIMEOUT_MS);

  const append = (chunk: Buffer, target: "stdout" | "stderr") => {
    const remaining = STUDY_OUTPUT_LIMIT - bytes;
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    const accepted = chunk.subarray(0, remaining).toString("utf8");
    bytes += Buffer.byteLength(accepted);
    if (target === "stdout") stdout += accepted;
    else stderr += accepted;
    if (chunk.length > remaining) truncated = true;
  };

  signal?.addEventListener("abort", abort, { once: true });
  child.stdout.on("data", (chunk: Buffer) => append(chunk, "stdout"));
  child.stderr.on("data", (chunk: Buffer) => append(chunk, "stderr"));
  child.on("error", (error) => finish(() => reject(new Error(`Study executable unavailable: ${error.message}`))));
  child.on("close", (code) => finish(() => {
    if (code !== 0) {
      const suffix = stderr.trim() ? `: ${stderr.trim()}` : "";
      reject(new Error(`Study executable failed with exit code ${code ?? "unknown"}${suffix}`));
      return;
    }
    resolveResult({ text: stdout, truncated });
  }));
});

export async function runStudyDecompilation(
  params: StudyDecompileParams,
  cwd: string,
  signal?: AbortSignal,
  runner: CommandRunner = runBoundedCommand,
): Promise<StudyDecompileResult> {
  const assemblyPath = await resolveStudyAssembly(params.assemblyPath, cwd);
  const args = buildIlspyArguments(params, assemblyPath);
  const output = await runner("ilspycmd", args, signal);
  return { ...output, assemblyPath, operation: params.operation, typeName: params.typeName };
}

export function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b] = address.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 0 || b === 168)) return false;
    if (a === 192 && b === 0 && (address.startsWith("192.0.2.") || address.startsWith("192.0.0."))) return false;
    if (a === 192 && address.startsWith("192.88.99.")) return false;
    if (a === 198 && (b === 18 || b === 19 || address.startsWith("198.51.100."))) return false;
    if (a === 203 && address.startsWith("203.0.113.")) return false;
    return true;
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) return isPublicIp(normalized.slice("::ffff:".length));
    if (
      normalized === "::" || normalized === "::1" || normalized.startsWith("fe80:") ||
      normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8:") || normalized === "2001:db8::" || normalized.startsWith("2001:10:")
    ) return false;
    return true;
  }
  return false;
}

export function validateStudyFetchUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Study fetch requires one absolute HTTPS URL.");
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port || !hostname || isIP(hostname) || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("Study fetch URL is not an allowed public HTTPS destination.");
  }
  return url;
}

type ResolvedAddress = { address: string; family: number };
type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

async function resolvePublicHost(hostname: string, resolver: HostResolver): Promise<ResolvedAddress> {
  const addresses = await resolver(hostname);
  const publicAddress = addresses.find((entry) => isPublicIp(entry.address));
  if (!publicAddress || addresses.some((entry) => !isPublicIp(entry.address))) {
    throw new Error("Study fetch destination does not resolve exclusively to public network addresses.");
  }
  return publicAddress;
}

const systemResolver: HostResolver = async (hostname) => lookupDns(hostname, { all: true, verbatim: true });

function allowedContentType(contentType: string | undefined): boolean {
  if (!contentType) return true;
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  return mediaType.startsWith("text/") || ["application/json", "application/javascript", "application/xml", "application/x-sh", "application/yaml"].includes(mediaType);
}

export type HttpRequester = (
  url: URL,
  address: ResolvedAddress,
  signal?: AbortSignal,
) => Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: StudyTextResult }>;

const defaultRequester: HttpRequester = (url, address, signal) => new Promise((resolveResult, reject) => {
  const request = httpsRequest({
    protocol: url.protocol,
    hostname: url.hostname,
    path: `${url.pathname}${url.search}`,
    method: "GET",
    headers: { Accept: "text/plain, text/*, application/json, application/javascript, application/xml;q=0.9" },
    timeout: STUDY_TIMEOUT_MS,
    lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
    signal,
  }, (response) => {
    let text = "";
    let bytes = 0;
    let truncated = false;
    response.on("data", (chunk: Buffer) => {
      const remaining = STUDY_OUTPUT_LIMIT - bytes;
      if (remaining <= 0) {
        truncated = true;
        response.destroy();
        return;
      }
      const accepted = chunk.subarray(0, remaining).toString("utf8");
      text += accepted;
      bytes += Buffer.byteLength(accepted);
      if (chunk.length > remaining) {
        truncated = true;
        response.destroy();
      }
    });
    response.on("error", (error) => {
      if (truncated) return;
      reject(error);
    });
    response.on("end", () => resolveResult({
      statusCode: response.statusCode ?? 0,
      headers: response.headers,
      body: { text, truncated },
    }));
    response.on("close", () => {
      if (truncated) resolveResult({ statusCode: response.statusCode ?? 0, headers: response.headers, body: { text, truncated } });
    });
  });
  request.on("timeout", () => request.destroy(new Error("Study fetch timed out.")));
  request.on("error", reject);
  request.end();
});

export async function fetchStudySource(
  requestedUrl: string,
  signal?: AbortSignal,
  resolver: HostResolver = systemResolver,
  requester: HttpRequester = defaultRequester,
): Promise<StudyFetchResult> {
  let url = validateStudyFetchUrl(requestedUrl);
  const redirectChain: string[] = [];

  for (let redirects = 0; redirects <= STUDY_FETCH_REDIRECT_LIMIT; redirects++) {
    const address = await resolvePublicHost(url.hostname, resolver);
    const response = await requester(url, address, signal);
    const location = response.headers.location;
    if (response.statusCode >= 300 && response.statusCode < 400) {
      if (typeof location !== "string" || redirects === STUDY_FETCH_REDIRECT_LIMIT) {
        throw new Error("Study fetch rejected redirect response.");
      }
      redirectChain.push(url.toString());
      url = validateStudyFetchUrl(new URL(location, url).toString());
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Study fetch failed with HTTP status ${response.statusCode}.`);
    }
    const contentType = typeof response.headers["content-type"] === "string" ? response.headers["content-type"] : undefined;
    if (!allowedContentType(contentType)) throw new Error("Study fetch rejected non-text response.");
    return {
      ...response.body,
      requestedUrl,
      finalUrl: url.toString(),
      redirectChain,
      contentType,
      retrievedAt: new Date().toISOString(),
    };
  }
  throw new Error("Study fetch rejected redirect response.");
}
