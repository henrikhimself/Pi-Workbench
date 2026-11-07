import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { constants } from "node:fs";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveCodeGraphProject } from "./code-graph-config.js";
import { acquireManagedLock, assertNoSymlink, assertWithin, ensurePrivateDirectory, ownIdentity, publishJson, syncDirectory, type ProcessIdentity } from "./managed-lifecycle.js";
import { WORKBENCH_PATHS, type WorkbenchPaths } from "./paths.js";

export const PLAYWRIGHT_VERSION = "0.0.84";
export const PLAYWRIGHT_ENGINE_VERSION = "1.65.0-alpha-2026-10-30";
export const PLAYWRIGHT_SERVER_NAME = "playwright";
export const PLAYWRIGHT_POLICY = 1;
/** Reviewed against upstream MCP 0.0.84 README/tool schemas, not inferred aliases. */
export const PLAYWRIGHT_REQUIRED_TOOLS = ["browser_navigate", "browser_snapshot", "browser_evaluate", "browser_take_screenshot", "browser_mouse_click_xy"] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;

export interface PlaywrightProject { root: string; projectPath: string; identifier: string; directory: string; statePath: string }
export interface PlaywrightSession {
  project: PlaywrightProject; id: string; directory: string; configPath: string; markerPath: string;
  artifacts: string; home: string; cache: string; tmp: string; diagnostics: string;
}
export interface PlaywrightHostExecutable { path: string; version: string; sha256: string }
export interface PlaywrightRuntimeRecord {
  schema: 1; policy: number; id: string; version: string; engineVersion: string; manifestSha256: string;
  slot: string; node: PlaywrightHostExecutable; npm: PlaywrightHostExecutable;
  entrypoint: string; browser: string; browserVersion: string; tools: string[]; validatedAt: string;
}
export interface PlaywrightSessionRecord {
  schema: 1; sessionId: string; runtimeId: string; workspace: string; identifier: string;
  owner: ProcessIdentity; createdAt: string;
}
export interface PlaywrightRecoveryRecord { schema: 1; operation: "publication" | "cleanup"; runtimeId: string; detail: string; createdAt: string }

function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key))) {
    throw new Error("Invalid Playwright record fields");
  }
  return value as Record<string, unknown>;
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0 && !value.includes("\0"); }
function timestamp(value: unknown): boolean { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)); }
export function assertPlaywrightId(id: string): void { if (!uuid.test(id)) throw new Error("Invalid Playwright identity"); }

export function resolvePlaywrightProject(cwd: string, paths: WorkbenchPaths = WORKBENCH_PATHS): PlaywrightProject {
  // Reuse canonical workspace/basename-hash semantics, never the graph's store.
  const project = resolveCodeGraphProject(cwd, { codeGraphRoot: paths.playwrightRoot, codeGraphProjects: paths.playwrightProjects });
  return { root: resolve(paths.playwrightRoot), projectPath: project.projectPath, identifier: project.identifier,
    directory: project.directory, statePath: join(project.directory, "opt-in.json") };
}
export function assertPlaywrightProject(project: PlaywrightProject): void {
  const expected = resolvePlaywrightProject(project.projectPath, { ...WORKBENCH_PATHS, playwrightRoot: project.root, playwrightProjects: join(project.root, "projects") });
  for (const key of ["root", "projectPath", "identifier", "directory", "statePath"] as const) {
    if (expected[key] !== project[key]) throw new Error("Playwright workspace identity/path mismatch");
  }
  assertWithin(project.root, project.directory);
}

/** Read-only validation: never mkdir, chmod, adopt, or repair an existing store. */
export async function inspectPlaywrightPath(root: string, path: string): Promise<void> {
  assertWithin(root, path);
  await assertNoSymlink(path);
  let current = path;
  for (;;) {
    const info = await lstat(current);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0) {
      throw new Error(`Unsafe Playwright managed path: ${current}`);
    }
    if (current === resolve(root)) break;
    current = dirname(current);
  }
}
export async function readPlaywrightJson(root: string, path: string): Promise<unknown | null> {
  assertWithin(root, path);
  try { await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  await inspectPlaywrightPath(root, path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0) throw new Error("Unsafe Playwright record");
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}
export async function playwrightOptedIn(project: PlaywrightProject): Promise<boolean> {
  assertPlaywrightProject(project);
  const raw = await readPlaywrightJson(project.root, project.statePath);
  if (raw === null) return false;
  const state = object(raw, ["schema", "enabled", "workspace", "identifier"]);
  if (state.schema !== 1 || state.enabled !== true || state.workspace !== project.projectPath || state.identifier !== project.identifier) {
    throw new Error("Invalid Playwright opt-in; existing data left unchanged");
  }
  return true;
}
export async function preparePlaywrightRoot(paths: WorkbenchPaths): Promise<void> {
  await ensurePrivateDirectory(paths.root, paths.playwrightRoot);
}
export async function playwrightWorkspaceLock(project: PlaywrightProject, signal?: AbortSignal): Promise<() => Promise<void>> {
  assertPlaywrightProject(project);
  return acquireManagedLock(join(project.root, "coordination"), `workspace-${project.identifier}`, { signal });
}
export async function setPlaywrightOptIn(project: PlaywrightProject, enabled: boolean, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  assertPlaywrightProject(project);
  if (!enabled && !await playwrightOptedIn(project)) return;
  await ensurePrivateDirectory(project.root);
  const unlock = await playwrightWorkspaceLock(project, signal);
  try {
    signal?.throwIfAborted();
    await playwrightOptedIn(project); // Refuse to overwrite incompatible/unsafe intent.
    if (enabled) await publishJson(project.root, project.statePath, { schema: 1, enabled: true, workspace: project.projectPath, identifier: project.identifier });
    else { await rm(project.statePath); await syncDirectory(project.directory); }
  } finally { await unlock(); }
}

export function parsePlaywrightRuntime(raw: unknown, paths: WorkbenchPaths): PlaywrightRuntimeRecord {
  const record = object(raw, ["schema", "policy", "id", "version", "engineVersion", "manifestSha256", "slot", "node", "npm", "entrypoint", "browser", "browserVersion", "tools", "validatedAt"]);
  if (record.schema !== 1 || record.policy !== PLAYWRIGHT_POLICY || typeof record.id !== "string") throw new Error("Unsupported Playwright runtime schema/policy");
  assertPlaywrightId(record.id);
  if (!nonempty(record.version) || !/^\d+\.\d+\.\d+$/.test(record.version) || !nonempty(record.engineVersion) || !nonempty(record.manifestSha256) || !hash.test(record.manifestSha256)) throw new Error("Invalid Playwright runtime package identity");
  if (record.slot !== join(paths.playwrightRuntimes, record.version, record.id)) throw new Error("Invalid Playwright runtime slot");
  if (record.entrypoint !== join(record.slot as string, "node_modules", "@playwright", "mcp", "cli.js")) throw new Error("Invalid Playwright MCP entrypoint");
  if (!nonempty(record.browser) || !isAbsolute(record.browser)) throw new Error("Invalid Playwright browser path");
  assertWithin(join(record.slot as string, "browsers"), record.browser);
  for (const key of ["node", "npm"] as const) {
    const executable = object(record[key], ["path", "version", "sha256"]);
    if (!nonempty(executable.path) || !isAbsolute(executable.path) || !nonempty(executable.version) || !nonempty(executable.sha256) || !hash.test(executable.sha256)) throw new Error("Invalid Playwright host executable identity");
  }
  if (!nonempty(record.browserVersion) || !timestamp(record.validatedAt) || !Array.isArray(record.tools) || !record.tools.length || record.tools.some(tool => !nonempty(tool)) || new Set(record.tools).size !== record.tools.length) throw new Error("Invalid Playwright readiness evidence");
  return record as unknown as PlaywrightRuntimeRecord;
}
export function parsePlaywrightSelection(raw: unknown, paths: WorkbenchPaths): { schema: 1; id: string; version: string; slot: string } {
  const record = object(raw, ["schema", "id", "version", "slot"]);
  if (record.schema !== 1 || typeof record.id !== "string" || typeof record.version !== "string" || !/^\d+\.\d+\.\d+$/.test(record.version)) throw new Error("Invalid Playwright selection");
  assertPlaywrightId(record.id);
  if (record.slot !== join(paths.playwrightRuntimes, record.version, record.id)) throw new Error("Invalid Playwright selection path");
  return record as unknown as { schema: 1; id: string; version: string; slot: string };
}
export function parsePlaywrightSession(raw: unknown): PlaywrightSessionRecord {
  const record = object(raw, ["schema", "sessionId", "runtimeId", "workspace", "identifier", "owner", "createdAt"]);
  if (record.schema !== 1 || !nonempty(record.sessionId) || !nonempty(record.runtimeId) || !nonempty(record.workspace) || !isAbsolute(record.workspace) || !nonempty(record.identifier) || !timestamp(record.createdAt)) throw new Error("Invalid Playwright session record");
  assertPlaywrightId(record.sessionId); assertPlaywrightId(record.runtimeId);
  const owner = object(record.owner, ["pid", "start", "host"]);
  if (!Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0 || !nonempty(owner.start) || !nonempty(owner.host)) throw new Error("Invalid Playwright session owner");
  return record as unknown as PlaywrightSessionRecord;
}
export function parsePlaywrightRecovery(raw: unknown): PlaywrightRecoveryRecord {
  const record = object(raw, ["schema", "operation", "runtimeId", "detail", "createdAt"]);
  if (record.schema !== 1 || !["publication", "cleanup"].includes(String(record.operation)) || !nonempty(record.runtimeId) || !nonempty(record.detail) || !timestamp(record.createdAt)) throw new Error("Invalid Playwright recovery record");
  assertPlaywrightId(record.runtimeId);
  return record as unknown as PlaywrightRecoveryRecord;
}

export function resolvePlaywrightSession(project: PlaywrightProject, id: string = randomUUID()): PlaywrightSession {
  assertPlaywrightProject(project); assertPlaywrightId(id);
  const directory = join(project.directory, "sessions", id);
  return { project, id, directory, configPath: join(directory, "config.json"), markerPath: join(directory, "session.json"),
    artifacts: join(directory, "artifacts"), home: join(directory, "home"), cache: join(directory, "cache"), tmp: join(directory, "tmp"), diagnostics: join(directory, "diagnostics") };
}
export function assertPlaywrightSession(session: PlaywrightSession): void {
  const expected = resolvePlaywrightSession(session.project, session.id);
  for (const key of ["directory", "configPath", "markerPath", "artifacts", "home", "cache", "tmp", "diagnostics"] as const) {
    if (session[key] !== expected[key]) throw new Error("Playwright session identity/path mismatch");
  }
}

/** Fixed upstream configuration; no caller or inherited-environment overrides. */
export function playwrightMcpConfiguration(session: PlaywrightSession, browser: string) {
  assertPlaywrightSession(session);
  assertWithin(join(session.project.root, "runtimes"), browser);
  return playwrightPolicyConfiguration(session.artifacts, browser);
}
export function playwrightPolicyConfiguration(outputDir: string, browser: string) {
  if (!isAbsolute(outputDir) || !isAbsolute(browser)) throw new Error("Playwright policy requires absolute private paths");
  return {
    browser: { browserName: "chromium", isolated: true,
      launchOptions: { channel: "chromium", executablePath: browser, headless: true, chromiumSandbox: true }, contextOptions: {} },
    capabilities: ["vision"], webmcp: false, extension: false, sharedBrowserContext: false, saveSession: false,
    allowUnrestrictedFileAccess: false, ignoreRoots: true, outputDir, outputMaxSize: 0,
    timeouts: { action: 5000, navigation: 60000, idle: 0 }, imageResponses: "allow", filePaths: "absolute",
  };
}

export function assertPlaywrightMcpConfiguration(raw: unknown, session: PlaywrightSession, browser: string): void {
  if (!isDeepStrictEqual(raw, playwrightMcpConfiguration(session, browser))) throw new Error("Playwright fixed configuration mismatch");
}

/** Caller holds workspace activation lock; a live session directory is never reused. */
export async function preparePlaywrightSession(session: PlaywrightSession, runtime: PlaywrightRuntimeRecord): Promise<void> {
  assertPlaywrightSession(session); assertPlaywrightId(runtime.id);
  if (!await playwrightOptedIn(session.project)) throw new Error("Playwright workspace is not opted in");
  assertWithin(join(runtime.slot, "browsers"), runtime.browser);
  await ensurePrivateDirectory(session.project.root, dirname(session.directory));
  await mkdir(session.directory, { mode: 0o700 }); // EEXIST is not permission to reuse prior login state.
  for (const path of [session.artifacts, session.diagnostics]) await ensurePrivateDirectory(session.project.root, path);
  await preparePlaywrightTransient(session);
  await publishJson(session.project.root, session.markerPath, { schema: 1, sessionId: session.id, runtimeId: runtime.id,
    workspace: session.project.projectPath, identifier: session.project.identifier, owner: await ownIdentity(), createdAt: new Date().toISOString() });
  await publishJson(session.project.root, session.configPath, playwrightMcpConfiguration(session, runtime.browser));
}

/** Reconnection may recreate transient directories only after prior runtime quiescence. */
export async function preparePlaywrightTransient(session: PlaywrightSession): Promise<void> {
  assertPlaywrightSession(session);
  for (const path of [session.home, session.cache, session.tmp, join(session.home, ".config"), join(session.home, ".local", "share"), join(session.home, ".local", "state"), join(session.tmp, "run")]) await ensurePrivateDirectory(session.project.root, path);
}

export function playwrightChildEnvironment(session: PlaywrightSession, runtime: PlaywrightRuntimeRecord, npmCache: string): Record<string, string> {
  assertPlaywrightSession(session);
  assertWithin(session.project.root, npmCache);
  assertWithin(join(session.project.root, "runtimes"), runtime.slot);
  return { ...playwrightPrivateEnvironment(session, runtime.node.path, join(runtime.slot, "browsers"), npmCache),
    WB_PLAYWRIGHT_SESSION_ID: session.id, WB_PLAYWRIGHT_RUNTIME_ID: runtime.id };
}
export function playwrightPrivateEnvironment(session: { home: string; cache: string; tmp: string }, node: string, browsers: string, npmCache: string): Record<string, string> {
  return { PATH: `${dirname(node)}:/usr/local/bin:/usr/bin:/bin`, LANG: "C.UTF-8", HOME: session.home, USERPROFILE: session.home,
    XDG_CACHE_HOME: session.cache, XDG_CONFIG_HOME: join(session.home, ".config"), XDG_DATA_HOME: join(session.home, ".local", "share"), XDG_STATE_HOME: join(session.home, ".local", "state"), XDG_RUNTIME_DIR: join(session.tmp, "run"),
    TMPDIR: session.tmp, TMP: session.tmp, TEMP: session.tmp, PLAYWRIGHT_BROWSERS_PATH: browsers,
    PLAYWRIGHT_SKIP_BROWSER_GC: "1", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1", NPM_CONFIG_CACHE: npmCache,
    NPM_CONFIG_USERCONFIG: join(session.home, "npmrc"), NPM_CONFIG_GLOBALCONFIG: join(session.home, "global-npmrc"), NPM_CONFIG_IGNORE_SCRIPTS: "true", NPM_CONFIG_UPDATE_NOTIFIER: "false" };
}

/** Pi's stdio transport merges env with its parent. Explicitly blank inherited
 * values before Node starts, including loader injection; the MCP child then gets
 * only playwrightChildEnvironment via spawn's replacement env semantics.
 */
export function playwrightPiEnvironment(privateEnv: Record<string, string>, inherited: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const cleared = Object.fromEntries(Object.keys(inherited).map(key => [key, ""]));
  return { ...cleared, NODE_OPTIONS: "", NODE_PATH: "", LD_PRELOAD: "", LD_LIBRARY_PATH: "", ...privateEnv };
}

/** Guardrail for all normal MCP output-filename arguments; uploads keep upstream workspace rules. */
export async function assertPlaywrightArtifact(session: PlaywrightSession, filename: unknown): Promise<string> {
  assertPlaywrightSession(session);
  if (!nonempty(filename)) throw new Error("Playwright output filename must be a non-empty path");
  // Explicit filenames follow upstream workspace-relative semantics, not outputDir.
  const path = resolve(session.project.projectPath, filename);
  assertWithin(session.artifacts, path);
  if (relative(session.artifacts, path) === "" || path.endsWith(sep)) throw new Error("Playwright output must name a file");
  await inspectPlaywrightPath(session.project.root, session.artifacts);
  await assertNoSymlink(path);
  return path;
}
