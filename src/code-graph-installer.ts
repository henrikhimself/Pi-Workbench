import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, open, readFile, readdir, rename as fsRename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import https from "node:https";
import type { WorkbenchPaths } from "./paths.js";
import {
  CODE_GRAPH_ASSETS,
  CODE_GRAPH_BINARY_MEMBER,
  compareAssetVersions,
  getAsset,
  parseAssetVersion,
  resolveAssetUrl,
  validateAsset,
  type CodeGraphAsset,
  type CodeGraphPlatform,
} from "./code-graph-assets.js";

/**
 * Secure lifecycle for the extension-managed codebase-memory-mcp binary:
 * platform detection, install lock, pinned HTTPS download, SHA-256
 * verification, hardened archive extraction, version verification, and
 * atomic installation.
 *
 * The installer never runs the upstream `install`/`update`/`uninstall`
 * commands, never writes to global PATH or agent configuration, and accepts
 * no user-provided URLs, checksums, or commands.
 */

// ─── Constants ────────────────────────────────────────────────────────

/** ~1.1x the approved v0.8.1 archive size (36,458,830 bytes). */
export const MAX_DOWNLOAD_BYTES = 40_000_000;
/** Hard cap for a single extracted archive member. */
export const MAX_MEMBER_BYTES = 300_000_000;
export const DEFAULT_MAX_REDIRECTS = 3;
export const SOCKET_TIMEOUT_MS = 30_000;
export const VERSION_TIMEOUT_MS = 15_000;
export const INSTALL_LOCK_TIMEOUT_MS = 10 * 60_000;
export const INSTALL_LOCK_RETRY_MS = 500;
export const INSTALL_LOCK_STALE_MS = 30 * 60_000;

const ASSET_RECORD_FILE = "asset.json";

// ─── Types ────────────────────────────────────────────────────────────

export interface InstalledAssetRecord {
  version: string;
  resolvedUrl: string;
  sha256: string;
}

export interface InstalledBinary {
  path: string;
  version: string;
  resolvedUrl: string;
  sha256: string;
  reused: boolean;
}

export type BinaryAction =
  | { action: "reuse"; reason: "verified" | "downgrade_refused" }
  | { action: "install"; reason: "missing" | "update" | "integrity" }
  | { action: "invalid_manifest"; detail: string };

export type StatusReporter = (message: string) => void;

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ProcessRunner = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number; cwd: string },
) => Promise<ProcessResult>;

export interface DownloadResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: NodeJS.ReadableStream & { resume?: () => void };
  location?: string;
}

export type ArchiveFetcher = (url: string) => Promise<DownloadResponse>;

export interface InstallerDeps {
  paths: Pick<WorkbenchPaths, "codeGraphRoot" | "codeGraphBin" | "codeGraphDownloads">;
  platform?: () => { os: string; arch: string };
  download?: (url: string, destination: string, onStatus: StatusReporter) => Promise<void>;
  extract?: (archivePath: string, stagingDir: string, tarPath: string) => Promise<{ binaryPath: string }>;
  runProcess?: ProcessRunner;
  fetchResponse?: ArchiveFetcher;
  sleep?: (ms: number) => Promise<void>;
}

// ─── Platform detection ───────────────────────────────────────────────

export function detectCodeGraphPlatform(env: { os: string; arch: string }): CodeGraphPlatform | null {
  if (env.os === "linux" && env.arch === "arm64") return "linux-arm64";
  return null;
}

export function unsupportedPlatformMessage(os: string, arch: string): string {
  return (
    `code graph is not supported on ${os}/${arch}. ` +
    `The only approved platform is linux/arm64 (codebase-memory-mcp ${CODE_GRAPH_ASSETS["linux-arm64"].version}). ` +
    `Other platforms require product approval and verified compatibility first.`
  );
}

// ─── Update decision ──────────────────────────────────────────────────

/**
 * Compare an installed asset record with the packaged manifest.
 *
 * - Same version, resolved URL, and SHA-256 → reuse.
 * - Packaged version greater → install the update.
 * - Packaged version lower → keep installed (no automatic downgrade).
 * - Same version but different resolved URL or SHA-256 → the package
 *   manifest is invalid; never silently replace a release identity.
 */
export function decideBinaryAction(
  installed: InstalledAssetRecord | null,
  packaged: { version: string; resolvedUrl: string; sha256: string },
): BinaryAction {
  if (!installed) return { action: "install", reason: "missing" };
  if (installed.version === packaged.version) {
    if (installed.resolvedUrl === packaged.resolvedUrl && installed.sha256 === packaged.sha256) {
      return { action: "reuse", reason: "verified" };
    }
    return {
      action: "invalid_manifest",
      detail:
        `Installed ${installed.version} record differs from the packaged manifest for the same version ` +
        `(resolved URL or SHA-256 changed). The package manifest is invalid; the installed binary is retained and not replaced.`,
    };
  }
  if (compareAssetVersions(installed.version, packaged.version) < 0) {
    return { action: "install", reason: "update" };
  }
  return { action: "reuse", reason: "downgrade_refused" };
}

// ─── Install lock ─────────────────────────────────────────────────────
// Same atomic-mkdir algorithm as the Headroom startup lock (owner.json pid,
// abandoned/stale lock removal, deadline) with code-graph diagnostics.

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function removeAbandonedInstallLock(lockDir: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(join(lockDir, "owner.json"), "utf8")) as { pid?: unknown };
    if (typeof owner.pid === "number" && owner.pid > 0 && !isProcessRunning(owner.pid)) {
      await rm(lockDir, { recursive: true, force: true });
      return true;
    }
    return false;
  } catch {
    try {
      const lockStat = await stat(lockDir);
      if (Date.now() - lockStat.mtimeMs > INSTALL_LOCK_STALE_MS) {
        await rm(lockDir, { recursive: true, force: true });
        return true;
      }
    } catch {
      // Another process released the lock; retry acquisition.
    }
    return false;
  }
}

export async function acquireInstallLock(
  lockDir: string,
  onStatus: StatusReporter,
  sleep: (ms: number) => Promise<void>,
  timeoutMs: number = INSTALL_LOCK_TIMEOUT_MS,
): Promise<(() => Promise<void>) | null> {
  const deadline = Date.now() + timeoutMs;
  let waitingReported = false;

  while (Date.now() < deadline) {
    try {
      await mkdir(dirname(lockDir), { recursive: true });
      await mkdir(lockDir);
      await writeFile(
        join(lockDir, "owner.json"),
        JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }),
      );
      return async () => {
        await rm(lockDir, { recursive: true, force: true });
      };
    } catch (error) {
      if (!isAlreadyExists(error)) {
        const message = error instanceof Error ? error.message : String(error);
        onStatus(`Failed to acquire code graph install lock: ${message}`);
        return null;
      }
    }

    if (await removeAbandonedInstallLock(lockDir)) continue;

    if (!waitingReported) {
      waitingReported = true;
      onStatus("Waiting for another Pi session to install the code graph binary...");
    }
    await sleep(INSTALL_LOCK_RETRY_MS);
  }

  onStatus("Timed out waiting for another Pi session to install the code graph binary");
  return null;
}

// ─── Download ─────────────────────────────────────────────────────────

function defaultFetchResponse(url: string): Promise<DownloadResponse> {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { timeout: SOCKET_TIMEOUT_MS, headers: { "user-agent": "pi-workbench-code-graph-installer" } },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        resolve({
          statusCode,
          headers: response.headers as DownloadResponse["headers"],
          body: response,
          location: statusCode >= 300 && statusCode < 400 ? response.headers.location : undefined,
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error(`Timed out connecting to ${new URL(url).host}`)));
    request.on("error", (error) => reject(error));
  });
}

/**
 * HTTPS download of the pinned archive into a unique `.part` staging file.
 * Follows at most `maxRedirects` redirects (HTTPS-only), enforces the byte
 * cap, and commits the file with fsync + rename. Partial files are removed
 * on any failure. No credentials, cookies, or user headers are sent.
 */
export async function downloadArchive(
  url: string,
  destination: string,
  onStatus: StatusReporter,
  options: {
    maxBytes?: number;
    maxRedirects?: number;
    fetchResponse?: ArchiveFetcher;
  } = {},
): Promise<void> {
  const maxBytes = options.maxBytes ?? MAX_DOWNLOAD_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const fetchResponse = options.fetchResponse ?? defaultFetchResponse;
  await mkdir(dirname(destination), { recursive: true });
  const partPath = `${destination}.${process.pid}-${Date.now().toString(36)}.part`;

  try {
    let current = url;
    let response: DownloadResponse;
    for (let hop = 0; ; hop++) {
      if (hop > maxRedirects) throw new Error(`Too many redirects (limit ${String(maxRedirects)}) while downloading ${url}`);
      const parsed = new URL(current);
      if (parsed.protocol !== "https:") throw new Error(`Refusing non-HTTPS download URL: ${current}`);
      response = await fetchResponse(current);
      if (response.statusCode >= 300 && response.statusCode < 400) {
        if (!response.location) throw new Error(`Redirect ${String(response.statusCode)} without Location from ${current}`);
        current = new URL(response.location, current).toString();
        continue;
      }
      if (response.statusCode !== 200) throw new Error(`Download failed with HTTP ${String(response.statusCode)} from ${current}`);
      break;
    }

    const declared = Number(response.headers["content-length"] ?? "");
    if (Number.isFinite(declared) && declared > 0 && declared > maxBytes) {
      response.body.resume?.();
      throw new Error(`Download size ${String(declared)} exceeds the ${String(maxBytes)} byte limit`);
    }

    const handle = await open(partPath, "w");
    let received = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Buffer>) {
        received += chunk.length;
        if (received > maxBytes) {
          response.body.resume?.();
          throw new Error(`Download exceeded the ${String(maxBytes)} byte limit`);
        }
        await handle.write(chunk);
      }
      await handle.sync();
    } finally {
      await handle.close();
      response.body.resume?.();
    }
    onStatus(`Downloaded ${(received / 1_000_000).toFixed(1)} MB`);
    await fsRename(partPath, destination);
  } catch (error) {
    await rm(partPath, { force: true }).catch(() => {});
    throw error instanceof Error ? error : new Error(String(error));
  }
}

// ─── SHA-256 ──────────────────────────────────────────────────────────

export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

// ─── Hardened tar.gz extraction ───────────────────────────────────────

export async function findGnuTar(
  runProcess: ProcessRunner = defaultProcessRunner(),
  pathValue: string | undefined = process.env.PATH,
): Promise<string> {
  for (const directory of (pathValue ?? "").split(delimiter).filter(Boolean)) {
    const candidate = resolve(directory, "tar");
    try {
      const info = await stat(candidate);
      if (!info.isFile() || (info.mode & 0o111) === 0) continue;
      const result = await runProcess(candidate, ["--version"], {
        env: { PATH: pathValue ?? "" }, timeoutMs: VERSION_TIMEOUT_MS, cwd: process.cwd(),
      });
      if (result.code === 0 && /^tar \(GNU tar\) \d/m.test(result.stdout)) return candidate;
    } catch {
      // Try next PATH entry. Missing/non-GNU tar is reported below.
    }
  }
  throw new Error("GNU tar is required to install Code Graph; no compatible GNU tar was found on PATH");
}

/** Extract only the approved member through GNU tar, never a TypeScript tar parser. */
export async function extractCodeGraphArchive(
  archivePath: string,
  stagingDir: string,
  tarPath: string,
): Promise<{ binaryPath: string }> {
  await mkdir(stagingDir, { recursive: true });
  const binaryPath = join(stagingDir, CODE_GRAPH_BINARY_MEMBER);
  const partPath = `${binaryPath}.${process.pid}-${Date.now().toString(36)}.part`;
  const handle = await open(partPath, "wx", 0o700);
  let bytes = 0;
  let stderr = "";
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(tarPath, ["--extract", "--gzip", "--to-stdout", "--file", archivePath, "--", CODE_GRAPH_BINARY_MEMBER], {
        stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" },
      });
      let writes = Promise.resolve();
      child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-4096); });
      child.on("error", reject);
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_MEMBER_BYTES) {
          child.kill("SIGKILL");
          reject(new Error(`GNU tar output exceeds ${String(MAX_MEMBER_BYTES)} byte limit`));
          return;
        }
        child.stdout.pause();
        writes = writes.then(() => handle.write(chunk)).then(() => { child.stdout.resume(); });
        void writes.catch(reject);
      });
      child.on("close", (code) => {
        void writes.then(
          () => code === 0
            ? resolvePromise()
            : reject(new Error(`GNU tar extraction failed${stderr ? `: ${stderr.trim()}` : ""}`)),
          reject,
        );
      });
    });
    if (bytes === 0) throw new Error(`GNU tar archive is missing the ${CODE_GRAPH_BINARY_MEMBER} member`);
    await handle.sync();
    await handle.close();
    await chmod(partPath, 0o755);
    await fsRename(partPath, binaryPath);
    return { binaryPath };
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(partPath, { force: true }).catch(() => {});
    throw error;
  }
}

// ─── Version verification ─────────────────────────────────────────────

/** Normalize `codebase-memory-mcp 0.8.1` → `v0.8.1`; null when unparseable. */
export function parseBinaryVersionOutput(raw: string, binaryName = "codebase-memory-mcp"): string | null {
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(new RegExp(`^${binaryName}[ \\t]+(v?\\d+\\.\\d+\\.\\d+)$`));
    if (match) return match[1].startsWith("v") ? match[1] : `v${match[1]}`;
  }
  return null;
}

export function defaultProcessRunner(): ProcessRunner {
  return (command, args, options) =>
    new Promise<ProcessResult>((resolve) => {
      execFile(
        command,
        args,
        { env: options.env, timeout: options.timeoutMs, cwd: options.cwd, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          let code = 0;
          if (error) {
            const errno = (error as NodeJS.ErrnoException).code;
            code = typeof errno === "number" ? errno : 1;
          }
          resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        },
      );
    });
}

/** Minimal environment for verifying the managed binary: no CBM variables. */
export function createVerificationEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: typeof source.PATH === "string" ? source.PATH : "/usr/bin:/bin",
    HOME: typeof source.HOME === "string" ? source.HOME : "/tmp",
    LANG: "C.UTF-8",
  };
}

/** Run `<binary> --version` and verify it reports the expected version. */
export async function verifyBinaryVersion(
  binaryPath: string,
  expectedVersion: string,
  runProcess: ProcessRunner,
  options: { cwd: string },
): Promise<{ ok: true; version: string } | { ok: false; detail: string }> {
  if (!parseAssetVersion(expectedVersion)) {
    return { ok: false, detail: `Expected version ${expectedVersion} is not vMAJOR.MINOR.PATCH` };
  }
  let result: ProcessResult;
  try {
    result = await runProcess(binaryPath, ["--version"], {
      env: createVerificationEnvironment(),
      timeoutMs: VERSION_TIMEOUT_MS,
      cwd: options.cwd,
    });
  } catch (error) {
    return { ok: false, detail: `Failed to run ${binaryPath} --version: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (result.code !== 0) {
    return { ok: false, detail: `${binaryPath} --version exited ${String(result.code)}: ${result.stderr.trim() || "no output"}` };
  }
  const version = parseBinaryVersionOutput(result.stdout);
  if (!version) {
    return { ok: false, detail: `Unrecognized --version output: ${JSON.stringify(result.stdout.trim().slice(0, 200))}` };
  }
  if (version !== expectedVersion) {
    return { ok: false, detail: `Binary reports ${version}, expected ${expectedVersion}` };
  }
  return { ok: true, version };
}

// ─── Installation ─────────────────────────────────────────────────────

export function installedBinaryPath(binRoot: string, version: string, platform: CodeGraphPlatform): string {
  return join(binRoot, version, platform, CODE_GRAPH_BINARY_MEMBER);
}

export function assetRecordPath(binRoot: string, version: string, platform: CodeGraphPlatform): string {
  return join(binRoot, version, platform, ASSET_RECORD_FILE);
}

export async function readInstalledRecord(
  binRoot: string,
  version: string,
  platform: CodeGraphPlatform,
): Promise<InstalledAssetRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(assetRecordPath(binRoot, version, platform), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Partial<InstalledAssetRecord>;
    if (typeof record.version !== "string" || typeof record.resolvedUrl !== "string" || typeof record.sha256 !== "string") {
      return null;
    }
    if (!parseAssetVersion(record.version)) return null;
    if (record.version !== version) return null;
    return { version: record.version, resolvedUrl: record.resolvedUrl, sha256: record.sha256 };
  } catch {
    return null;
  }
}

/**
 * Discover the newest verified install for a platform by scanning
 * `bin/<version>/<platform>/asset.json`. The update policy compares the
 * packaged manifest against this installed version, so a packaged downgrade
 * is not mistaken for a missing install.
 */
export async function discoverInstalled(
  binRoot: string,
  platform: CodeGraphPlatform,
): Promise<InstalledAssetRecord | null> {
  let versions: string[];
  try {
    versions = (await readdir(binRoot))
      .filter((name) => parseAssetVersion(name) !== null)
      .sort((a, b) => compareAssetVersions(a, b));
  } catch {
    return null;
  }
  for (let i = versions.length - 1; i >= 0; i--) {
    const record = await readInstalledRecord(binRoot, versions[i], platform);
    if (record) return record;
  }
  return null;
}

export class CodeGraphInstaller {
  private readonly paths: InstallerDeps["paths"];
  private readonly platformSource: () => { os: string; arch: string };
  private readonly download: (url: string, destination: string, onStatus: StatusReporter) => Promise<void>;
  private readonly extract: (archivePath: string, stagingDir: string, tarPath: string) => Promise<{ binaryPath: string }>;
  private readonly runProcess: ProcessRunner;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: Partial<InstallerDeps> = {}) {
    this.paths =
      deps.paths ?? {
        codeGraphRoot: "",
        codeGraphBin: "",
        codeGraphDownloads: "",
      };
    this.platformSource = deps.platform ?? (() => ({ os: process.platform, arch: process.arch }));
    this.download = deps.download ?? ((url, destination, onStatus) => downloadArchive(url, destination, onStatus, { fetchResponse: deps.fetchResponse }));
    this.extract = deps.extract ?? extractCodeGraphArchive;
    this.runProcess = deps.runProcess ?? defaultProcessRunner();
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get binRoot(): string {
    return this.paths.codeGraphBin;
  }

  detectPlatform(): CodeGraphPlatform | null {
    return detectCodeGraphPlatform(this.platformSource());
  }

  /**
   * Ensure the packaged binary for the current platform is installed and
   * verified. Downloads only when the update policy requires it.
   *
   * `options.asset` is a test seam; production callers never pass it and
   * the packaged manifest remains the only accepted asset source.
   */
  async ensureInstalled(onStatus: StatusReporter, options: { asset?: CodeGraphAsset } = {}): Promise<InstalledBinary> {
    const env = this.platformSource();
    const platform = detectCodeGraphPlatform(env);
    if (!platform) throw new Error(unsupportedPlatformMessage(env.os, env.arch));
    const asset = options.asset ?? getAsset(platform).asset;
    const problems = validateAsset(platform, asset);
    if (problems.length > 0) throw new Error(problems.join("; "));
    const resolvedUrl = resolveAssetUrl(asset);

    const installed = await discoverInstalled(this.binRoot, platform);
    const action = decideBinaryAction(installed, { version: asset.version, resolvedUrl, sha256: asset.sha256 });
    if (action.action === "invalid_manifest") throw new Error(action.detail);

    if (action.action === "reuse" && installed) {
      const binaryPath = installedBinaryPath(this.binRoot, installed.version, platform);
      const verified = await verifyBinaryVersion(binaryPath, installed.version, this.runProcess, {
        cwd: this.paths.codeGraphRoot,
      });
      if (verified.ok) {
        return {
          path: binaryPath,
          version: installed.version,
          resolvedUrl: installed.resolvedUrl,
          sha256: installed.sha256,
          reused: true,
        };
      }
      onStatus(`Installed binary failed verification (${verified.detail}); reinstalling the packaged version.`);
    }

    const release = await acquireInstallLock(join(this.paths.codeGraphRoot, "install.lock"), onStatus, this.sleep);
    if (!release) throw new Error("Could not acquire the code graph install lock");
    try {
      // Re-check under the lock: another session may have finished while we waited.
      const underLock = await discoverInstalled(this.binRoot, platform);
      if (
        underLock &&
        underLock.version === asset.version &&
        underLock.resolvedUrl === resolvedUrl &&
        underLock.sha256 === asset.sha256
      ) {
        const binaryPath = installedBinaryPath(this.binRoot, asset.version, platform);
        const verified = await verifyBinaryVersion(binaryPath, asset.version, this.runProcess, {
          cwd: this.paths.codeGraphRoot,
        });
        if (verified.ok) {
          return { path: binaryPath, version: asset.version, resolvedUrl, sha256: asset.sha256, reused: true };
        }
      }
      return await this.installFresh(asset, resolvedUrl, platform, onStatus);
    } finally {
      await release();
    }
  }

  private async installFresh(
    asset: CodeGraphAsset,
    resolvedUrl: string,
    platform: CodeGraphPlatform,
    onStatus: StatusReporter,
  ): Promise<InstalledBinary> {
    const finalDir = join(this.binRoot, asset.version, platform);
    const binaryPath = join(finalDir, CODE_GRAPH_BINARY_MEMBER);
    const stagingRoot = join(this.paths.codeGraphDownloads, `.staging-${process.pid}-${Date.now().toString(36)}`);
    const stagedFinal = join(this.binRoot, `.${asset.version}-${platform}-staging-${process.pid}`);
    const archivePath = join(stagingRoot, `${CODE_GRAPH_BINARY_MEMBER}-${asset.version}.tar.gz`);

    try {
      await mkdir(stagingRoot, { recursive: true });
      const tarPath = await findGnuTar(this.runProcess);
      onStatus(`Downloading codebase-memory-mcp ${asset.version}...`);
      await this.download(resolvedUrl, archivePath, onStatus);

      onStatus("Verifying SHA-256...");
      const digest = await sha256OfFile(archivePath);
      if (digest !== asset.sha256) {
        throw new Error(`Archive SHA-256 mismatch: got ${digest}, expected ${asset.sha256}. The archive was not extracted.`);
      }

      onStatus("Extracting archive...");
      const { binaryPath: stagedBinary } = await this.extract(archivePath, join(stagingRoot, "extracted"), tarPath);

      onStatus("Verifying binary version...");
      const verified = await verifyBinaryVersion(stagedBinary, asset.version, this.runProcess, { cwd: this.paths.codeGraphRoot });
      if (!verified.ok) throw new Error(`Binary verification failed: ${verified.detail}`);

      // Stage the final directory beside its destination, then rename.
      await mkdir(stagedFinal, { recursive: true });
      await fsRename(stagedBinary, join(stagedFinal, CODE_GRAPH_BINARY_MEMBER));
      await writeFile(
        join(stagedFinal, ASSET_RECORD_FILE),
        JSON.stringify(
          { version: asset.version, resolvedUrl, sha256: asset.sha256, installedAt: new Date().toISOString() },
          null,
          2,
        ) + "\n",
      );
      await mkdir(dirname(finalDir), { recursive: true });
      await this.quarantineBrokenInstall(finalDir);
      await fsRename(stagedFinal, finalDir);
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
      onStatus(`Installed codebase-memory-mcp ${asset.version}`);
      return { path: binaryPath, version: asset.version, resolvedUrl, sha256: asset.sha256, reused: false };
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
      await rm(stagedFinal, { recursive: true, force: true }).catch(() => {});
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * A final directory present here has already failed identity or version
   * verification; move it aside so the verified install can land. The
   * quarantined copy is retained for diagnostics and never executed.
   */
  private async quarantineBrokenInstall(finalDir: string): Promise<void> {
    if (!(await existsSync(finalDir))) return;
    const quarantine = `${finalDir}.quarantine-${Date.now().toString(36)}`;
    try {
      await fsRename(finalDir, quarantine);
    } catch {
      // If the quarantine rename fails, the install rename below fails too
      // and the previous directory is left untouched.
    }
  }
}
