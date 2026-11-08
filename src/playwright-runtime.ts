import { createHash, randomUUID } from "node:crypto";
import { requireSchemaVersion } from "./schema-version.js";
import { access, lstat, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireManagedLock, assertNoSymlink, assertWithin, ensurePrivateDirectory, identityLive, publishJson, syncDirectory, type ProcessIdentity } from "./managed-lifecycle.js";
import { PLAYWRIGHT_ENGINE_VERSION, PLAYWRIGHT_POLICY, PLAYWRIGHT_REQUIRED_TOOLS, PLAYWRIGHT_VERSION, assertPlaywrightId, resolvePlaywrightProject, resolvePlaywrightSession, inspectPlaywrightPath, parsePlaywrightRecovery, parsePlaywrightRuntime, parsePlaywrightSelection, playwrightPolicyConfiguration, playwrightPrivateEnvironment, preparePlaywrightRoot, readPlaywrightJson, type PlaywrightHostExecutable, type PlaywrightRuntimeRecord } from "./playwright-config.js";
import { PlaywrightStdioClient, playwrightGroupMembers, runPlaywrightCommand, type PlaywrightCommand, type PlaywrightCommandRunner } from "./playwright-process.js";
import { WORKBENCH_PATHS, type WorkbenchPaths } from "./paths.js";
import { PlaywrightOwnedTree } from "./playwright-tree.js";
import { readPlaywrightOwnership } from "./playwright-ownership.js";
const MCP_BOOTSTRAP = fileURLToPath(new URL("./playwright-mcp-bootstrap.mjs", import.meta.url));

export type PlaywrightProgress = (message: string) => void;
export interface PlaywrightAssets { manifest: string; lock: string; sha256: string }
export interface PlaywrightHost { node: PlaywrightHostExecutable; npm: PlaywrightHostExecutable }
export interface PlaywrightReadiness { browserVersion: string; tools: string[] }
export interface PlaywrightProbeOptions { paths: WorkbenchPaths; slot: string; host: PlaywrightHost; browser: string; signal?: AbortSignal;
  connect?: (spec: PlaywrightCommand) => Promise<Pick<PlaywrightStdioClient, "request" | "call" | "close">>;
}
export interface PlaywrightRuntimeDependencies {
  paths?: WorkbenchPaths; run?: PlaywrightCommandRunner;
  host?: (setup: { home: string; cache: string; tmp: string }, signal?: AbortSignal) => Promise<PlaywrightHost>;
  probe?: (options: PlaywrightProbeOptions) => Promise<PlaywrightReadiness>;
  publish?: typeof publishJson; assets?: () => Promise<PlaywrightAssets>;
  platform?: () => Promise<void>;
}
const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const assetRoot = fileURLToPath(new URL("../assets/playwright/", import.meta.url));

export async function playwrightAssets(): Promise<PlaywrightAssets> {
  const manifest = await readFile(join(assetRoot, "package.json"), "utf8"), lock = await readFile(join(assetRoot, "package-lock.json"), "utf8");
  const pkg = JSON.parse(manifest), graph = JSON.parse(lock);
  if (pkg.name !== "pi-workbench-playwright-runtime" || pkg.private !== true || pkg.version !== PLAYWRIGHT_VERSION || pkg.dependencies?.["@playwright/mcp"] !== PLAYWRIGHT_VERSION || Object.keys(pkg.dependencies).length !== 1 || graph.lockfileVersion !== 3 || graph.name !== pkg.name || graph.version !== pkg.version || graph.packages?.[""]?.name !== pkg.name || graph.packages?.[""]?.version !== pkg.version || graph.packages?.[""]?.dependencies?.["@playwright/mcp"] !== PLAYWRIGHT_VERSION || Object.keys(graph.packages).sort().join("|") !== "|node_modules/@playwright/mcp|node_modules/playwright|node_modules/playwright-core") throw new Error("Invalid packaged Playwright manifest/lockfile");
  for (const [path, entry] of Object.entries(graph.packages) as [string, any][]) {
    if (!path) continue;
    if (!entry.resolved?.startsWith("https://registry.npmjs.org/") || !/^sha512-[A-Za-z0-9+/]+=*$/.test(entry.integrity ?? "")) throw new Error("Playwright lockfile lacks trusted registry/integrity identity");
  }
  if (graph.packages["node_modules/@playwright/mcp"]?.version !== PLAYWRIGHT_VERSION || graph.packages["node_modules/playwright"]?.version !== PLAYWRIGHT_ENGINE_VERSION || graph.packages["node_modules/playwright-core"]?.version !== PLAYWRIGHT_ENGINE_VERSION) throw new Error("Playwright dependency pin mismatch");
  return { manifest, lock, sha256: digest(manifest + "\0" + lock) };
}

export function validatePlaywrightPlatform(platform: string, arch: string, osRelease: string): void {
  const fields = Object.fromEntries(osRelease.split("\n").map(line => /^([A-Z_]+)=(.*)$/.exec(line)).filter(Boolean).map(match => [match![1], match![2].replace(/^"|"$/g, "")]));
  if (platform !== "linux" || !["x64", "arm64"].includes(arch) || !(fields.ID === "debian" && ["12", "13"].includes(fields.VERSION_ID) || fields.ID === "ubuntu" && ["22.04", "24.04"].includes(fields.VERSION_ID))) throw new Error("Unsupported Playwright host: requires Linux x64/ARM64 on Debian 12/13 or Ubuntu 22.04/24.04");
}
/** The recorded host `node` or `npm-cli.js` is missing or has different content (apt upgrade, nvm switch). The runtime is intact; only
 * its recorded host identity is stale, so `ensure()` may re-provision it. Any other validation failure still stops. */
export class PlaywrightHostChangedError extends Error {
  constructor(readonly path: string) { super(`Playwright host executable identity changed (${path}): the host Node or npm was updated or removed after the runtime was provisioned.`); this.name = "PlaywrightHostChangedError"; }
}
async function hostFile(path: string): Promise<string> {
  const canonical = await realpath(path);
  await assertNoSymlink(canonical);
  const info = await lstat(canonical);
  if (!info.isFile() || (info.mode & 0o022) !== 0) throw new Error("Unsafe Playwright host executable"); // Owner is not checked (product-owner decision); group/other-writable files, symlinks and writable ancestors are still refused.
  return canonical;
}
async function findHostCommand(name: string): Promise<string> {
  for (const dir of String(process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const path = resolve(dir, name);
    try { await access(path, constants.X_OK); return await hostFile(path); } catch { /* Continue discovery; no execution fallback. */ }
  }
  throw new Error(`Playwright requires an explicitly available host ${name}`);
}
export async function discoverPlaywrightHost(setup: { home: string; cache: string; tmp: string }, run: PlaywrightCommandRunner = runPlaywrightCommand, signal?: AbortSignal): Promise<PlaywrightHost> {
  const node = await findHostCommand("node"), npm = await findHostCommand("npm");
  if (!npm.endsWith("/npm-cli.js")) throw new Error("Playwright requires a validated npm-cli.js host installation");
  const env = playwrightPrivateEnvironment(setup, node, join(setup.home, "browsers"), setup.cache);
  const nodeResult = await run({ command: node, args: ["-p", "process.release.name + ':' + process.versions.node"], cwd: setup.home, env, signal, timeoutMs: 10000 });
  const nodeVersion = /^node:(\d+)\.(\d+)\.(\d+)\s*$/.exec(nodeResult.stdout);
  if (nodeResult.exitCode || !nodeVersion || Number(nodeVersion[1]) < 22 || Number(nodeVersion[1]) === 22 && Number(nodeVersion[2]) < 19) throw new Error("Playwright requires host Node >=22.19.0");
  const npmResult = await run({ command: node, args: [npm, "--prefix", setup.home, "--version"], cwd: setup.home, env, signal, timeoutMs: 10000 });
  const npmVersion = /^(\d+)\.\d+\.\d+\s*$/.exec(npmResult.stdout);
  if (npmResult.exitCode || !npmVersion || Number(npmVersion[1]) < 10) throw new Error("Playwright requires host npm >=10");
  return { node: { path: node, version: nodeVersion.slice(1).join("."), sha256: digest(await readFile(node)) }, npm: { path: npm, version: npmResult.stdout.trim(), sha256: digest(await readFile(npm)) } };
}

export interface PlaywrightConsumer { path: string; token: string; resource: string; owner: ProcessIdentity; group?: number; active: boolean }
/** Stale/unknown ownership is not quiescence. Read-only and absent-root safe. */
export async function playwrightConsumers(paths: WorkbenchPaths, prefix = ""): Promise<PlaywrightConsumer[]> {
  let names: string[];
  try { names = await readdir(paths.playwrightConsumers); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const result: PlaywrightConsumer[] = [];
  for (const name of names) {
    if (/^[0-9a-f-]+\.json\.[0-9a-f-]+\.tmp$/.test(name)) continue;
    if (!/^[0-9a-f-]+\.json$/.test(name)) throw new Error("Unknown Playwright consumer entry");
    const path = join(paths.playwrightConsumers, name), record = await readPlaywrightJson(paths.playwrightRoot, path) as any;
    requireSchemaVersion(record, "Playwright consumer record");
    if (name !== `${record.token}.json` || typeof record.resource !== "string") throw new Error("Invalid Playwright consumer record");
    if (!record.resource.startsWith(prefix)) continue;
    const owner = { pid: record.pid, start: record.start, host: record.host };
    let active = await identityLive(owner);
    if (record.group !== undefined) {
      if (!Number.isSafeInteger(record.group) || record.group <= 0) throw new Error("Invalid Playwright consumer process group");
      active ||= (await playwrightGroupMembers(record.group)).length > 0;
    } else if (!active) throw new Error("Stale Playwright consumer needs diagnosed recovery; quiescence not established");
    if (!active && record.sessionId !== undefined) {
      assertPlaywrightId(record.sessionId);
      if (typeof record.workspace !== "string") throw new Error("Invalid Playwright consumer workspace");
      const project = resolvePlaywrightProject(record.workspace, paths), session = resolvePlaywrightSession(project, record.sessionId);
      const evidence = await readPlaywrightOwnership(session);
      if (!evidence || evidence.record.runtimeId !== record.runtimeId || ![evidence.record.workspaceToken, evidence.record.runtimeToken].includes(record.token)) throw new Error("Playwright consumer ownership evidence mismatch");
      const snapshot = await new PlaywrightOwnedTree(evidence.scope, evidence.roots).capture();
      if (snapshot.uncertain) throw new Error("Playwright detached browser ownership uncertain; preserve consumer evidence");
      active = snapshot.processes.length > 0;
    }
    result.push({ path, token: record.token, resource: record.resource, owner, group: record.group, active });
  }
  return result;
}

export async function probePlaywrightRuntime(options: PlaywrightProbeOptions): Promise<PlaywrightReadiness> {
  const root = options.paths.playwrightRoot, directory = join(options.slot, "probe");
  const setup = { home: join(directory, "home"), cache: join(directory, "cache"), tmp: join(directory, "tmp") };
  for (const path of [...Object.values(setup), join(setup.tmp, "run"), join(directory, "artifacts")]) await ensurePrivateDirectory(root, path);
  const configPath = join(directory, "config.json");
  await publishJson(root, configPath, playwrightPolicyConfiguration(join(directory, "artifacts"), options.browser));
  const sessionId = randomUUID(), runtimeId = options.slot.split("/").at(-1)!;
  assertPlaywrightId(runtimeId);
  const scope = { sessionId, runtimeId, browserRoot: join(options.slot, "browsers"), directory };
  let client: Pick<PlaywrightStdioClient, "request" | "call" | "close"> | undefined;
  let tree = new PlaywrightOwnedTree(scope);
  try {
    client = await (options.connect ?? PlaywrightStdioClient.connect)({ command: options.host.node.path, args: [MCP_BOOTSTRAP, JSON.stringify({ schemaVersion: 1, command: options.host.node.path, args: [join(options.slot, "node_modules", "@playwright", "mcp", "cli.js"), "--config", configPath], root, browser: options.browser, home: setup.home, tmp: setup.tmp })], cwd: directory,
      env: { ...playwrightPrivateEnvironment(setup, options.host.node.path, join(options.slot, "browsers"), options.paths.playwrightNpmCache), WB_PLAYWRIGHT_SESSION_ID: sessionId, WB_PLAYWRIGHT_RUNTIME_ID: runtimeId }, signal: options.signal, timeoutMs: 90000 });
    tree = new PlaywrightOwnedTree(scope, client instanceof PlaywrightStdioClient ? [client.group.owner] : []);
    tree.start(() => {});
    const listing = await client.request("tools/list");
    const tools = listing?.tools?.map((tool: any) => tool.name);
    if (!Array.isArray(tools) || new Set(tools).size !== tools.length || tools.some(name => typeof name !== "string") || !PLAYWRIGHT_REQUIRED_TOOLS.every(name => tools.includes(name))) throw new Error("Invalid Playwright tool contract");
    await client.call("browser_navigate", { url: "data:text/html,<title>Workbench readiness</title><h1>Workbench readiness</h1>" });
    const snapshot = await client.call("browser_snapshot");
    if (!JSON.stringify(snapshot).includes("Workbench readiness")) throw new Error("Playwright DOM readiness failed");
    const evaluated = await client.call("browser_evaluate", { function: "() => navigator.userAgent" });
    const version = /(?:HeadlessChrome|Chrome)\/(\d+(?:\.\d+)+)/.exec(JSON.stringify(evaluated))?.[1];
    if (!version) throw new Error("Playwright browser identity unavailable");
    const screenshot = await client.call("browser_take_screenshot");
    if (!screenshot?.content?.some((part: any) => part.type === "image" && part.mimeType === "image/png" && typeof part.data === "string" && part.data.length > 0)) throw new Error("Playwright screenshot readiness failed");
    await client.call("browser_close");
    return { browserVersion: version, tools };
  } catch (error) {
    // Initial probe uses synthetic data only. Keep actionable host failures, not
    // raw protocol payloads, page content, environment values, or screenshots.
    const cause = error instanceof Error ? error.cause as any : null;
    const hints = (cause?.content ?? []).filter((part: any) => part.type === "text").flatMap((part: any) => String(part.text).split("\n"))
      .filter((line: string) => /Socket path too long|No usable sandbox|Failed to move to new namespace|Operation not permitted|error while loading shared libraries|Host system is missing dependencies|lib[\w.-]+\.so.*not found/i.test(line)).join("; ").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 1500);
    throw new Error(`Sandboxed Chromium readiness failed: ${error instanceof Error ? error.message : "protocol failure"}${hints ? ` (${hints})` : ""}. Check host browser libraries and Linux sandbox/user-namespace support; no unsandboxed fallback.`);
  } finally { try { await client?.close(); } finally { await tree.stop(); } }
}

export async function verifyPlaywrightPackages(slot: string, assets: PlaywrightAssets): Promise<void> {
  const manifest = await readFile(join(slot, "package.json"), "utf8"), lock = await readFile(join(slot, "package-lock.json"), "utf8");
  if (digest(manifest + "\0" + lock) !== assets.sha256) throw new Error("Playwright installed manifest identity changed");
  for (const [name, version] of [["@playwright/mcp", PLAYWRIGHT_VERSION], ["playwright", PLAYWRIGHT_ENGINE_VERSION], ["playwright-core", PLAYWRIGHT_ENGINE_VERSION]]) {
    const directory = join(slot, "node_modules", name), metadata = join(directory, "package.json"), cli = join(directory, "cli.js");
    await assertNoSymlink(metadata); await assertNoSymlink(cli);
    if (JSON.parse(await readFile(metadata, "utf8")).version !== version) throw new Error("Playwright installed dependency identity mismatch");
    for (const path of [metadata, cli]) {
      const info = await lstat(path);
      if (!info.isFile() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o022) !== 0) throw new Error("Unsafe Playwright package entrypoint");
    }
  }
}

export class PlaywrightRuntime {
  readonly paths: WorkbenchPaths;
  private run: PlaywrightCommandRunner;
  private publish: typeof publishJson;
  constructor(private dependencies: PlaywrightRuntimeDependencies = {}) {
    this.paths = dependencies.paths ?? WORKBENCH_PATHS;
    this.run = dependencies.run ?? runPlaywrightCommand;
    this.publish = dependencies.publish ?? publishJson;
  }
  async selected(): Promise<PlaywrightRuntimeRecord | null> {
    const raw = await readPlaywrightJson(this.paths.playwrightRoot, this.paths.playwrightSelected);
    if (raw === null) return null;
    const selection = parsePlaywrightSelection(raw, this.paths);
    const record = parsePlaywrightRuntime(await readPlaywrightJson(this.paths.playwrightRoot, join(selection.slot, "ready.json")), this.paths);
    if (record.id !== selection.id || record.version !== selection.version) throw new Error("Playwright selection/readiness identity mismatch");
    return record;
  }
  async validate(record: PlaywrightRuntimeRecord, assets?: PlaywrightAssets): Promise<void> {
    parsePlaywrightRuntime(record, this.paths);
    assets ??= await (this.dependencies.assets ?? playwrightAssets)();
    if (record.version !== PLAYWRIGHT_VERSION || record.engineVersion !== PLAYWRIGHT_ENGINE_VERSION || record.manifestSha256 !== assets.sha256) throw new Error("Playwright selected runtime does not match packaged pin");
    if (!PLAYWRIGHT_REQUIRED_TOOLS.every(name => record.tools.includes(name))) throw new Error("Incomplete Playwright ready-runtime tool contract");
    await inspectPlaywrightPath(this.paths.playwrightRoot, join(record.slot, "ready.json"));
    await verifyPlaywrightPackages(record.slot, assets);
    for (const file of [record.entrypoint, record.browser]) {
      assertWithin(record.slot, file); await assertNoSymlink(file);
      const info = await lstat(file);
      if (!info.isFile() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o022) !== 0) throw new Error("Unsafe Playwright runtime executable");
    }
    await access(record.browser, constants.X_OK);
    for (const host of [record.node, record.npm]) {
      let same = false;
      try { same = await hostFile(host.path) === host.path && digest(await readFile(host.path)) === host.sha256; }
      catch (error) { if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
      if (!same) throw new PlaywrightHostChangedError(host.path);
    }
  }
  async ensure(onProgress: PlaywrightProgress = () => {}, signal?: AbortSignal): Promise<PlaywrightRuntimeRecord> {
    const report = onProgress;
    onProgress = message => { try { report(message); } catch { /* UI teardown cannot invalidate runtime publication. */ } };
    signal?.throwIfAborted();
    await (this.dependencies.platform ?? (async () => validatePlaywrightPlatform(process.platform, process.arch, await readFile("/etc/os-release", "utf8"))))();
    const assets = await (this.dependencies.assets ?? playwrightAssets)();
    await preparePlaywrightRoot(this.paths);
    onProgress("Playwright waiting for installation lock...");
    const release = await acquireManagedLock(this.paths.playwrightCoordination, "install", { signal, timeoutMs: 120000 });
    let slot: string | undefined;
    try {
      const recovery = await readPlaywrightJson(this.paths.playwrightRoot, join(this.paths.playwrightRoot, "recovery.json"));
      if (recovery !== null) { parsePlaywrightRecovery(recovery); throw new Error("Playwright publication/cleanup recovery required; preserve existing data"); }
      const previous = await this.selected();
      let hostChanged: PlaywrightHostChangedError | undefined;
      if (previous?.version === PLAYWRIGHT_VERSION) {
        try { await this.validate(previous, assets); onProgress("Playwright installed runtime validated"); return previous; }
        catch (error) {
          // Only a changed host Node/npm is repaired here, by provisioning a new runtime below; the old slot is left in place.
          if (!(error instanceof PlaywrightHostChangedError)) throw error;
          hostChanged = error; onProgress("Playwright host Node/npm changed; provisioning a new runtime...");
        }
      }
      if ((await playwrightConsumers(this.paths, "runtime:")).some(consumer => consumer.active)) {
        throw new Error(hostChanged
          ? `${hostChanged.message} Another Pi session is still using the current Playwright runtime, so it was not replaced. Close the other Pi sessions that use managed Playwright (or run /wb:playwright off there), then run /wb:playwright on again.`
          : "Playwright runtime selection deferred: live consumers remain");
      }
      const id = randomUUID(); slot = join(this.paths.playwrightRuntimes, PLAYWRIGHT_VERSION, id);
      await ensurePrivateDirectory(this.paths.playwrightRoot, dirname(slot));
      await mkdir(slot, { mode: 0o700 });
      const setup = { home: join(slot, "setup", "home"), cache: join(slot, "setup", "cache"), tmp: join(slot, "setup", "tmp") };
      for (const path of [...Object.values(setup), this.paths.playwrightNpmCache]) await ensurePrivateDirectory(this.paths.playwrightRoot, path);
      const host = await (this.dependencies.host ?? ((setup, signal) => discoverPlaywrightHost(setup, this.run, signal)))(setup, signal);
      const env = playwrightPrivateEnvironment(setup, host.node.path, join(slot, "browsers"), this.paths.playwrightNpmCache);
      // Files remain at their permanent installed paths throughout publication.
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(slot, "package.json"), assets.manifest, { flag: "wx", mode: 0o600 });
      await writeFile(join(slot, "package-lock.json"), assets.lock, { flag: "wx", mode: 0o600 });
      const execute = async (args: string[], stage: string) => {
        signal?.throwIfAborted(); onProgress(stage);
        const result = await this.run({ command: host.node.path, args, cwd: slot!, env, signal, timeoutMs: 15 * 60 * 1000 });
        if (result.exitCode !== 0) throw new Error(`${stage} failed (exit ${result.exitCode}); no runtime published`);
        return result.stdout.trim();
      };
      await execute([host.npm.path, "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org"], "Playwright installing pinned npm packages...");
      await verifyPlaywrightPackages(slot, assets);
      // Explicit selected-browser provisioning; no install-deps or privileged host changes.
      await execute([join(slot, "node_modules", "playwright", "cli.js"), "install", "chromium", "--no-shell"], "Playwright downloading Chromium...");
      const browser = await execute(["-e", 'process.stdout.write(require("playwright").chromium.executablePath())'], "Playwright checking Chromium path...");
      assertWithin(join(slot, "browsers"), browser); await assertNoSymlink(browser);
      const browserInfo = await lstat(browser);
      if (!browserInfo.isFile() || (process.getuid && browserInfo.uid !== process.getuid()) || (browserInfo.mode & 0o022) !== 0) throw new Error("Unsafe Playwright browser executable");
      await access(browser, constants.X_OK);
      onProgress("Playwright checking sandboxed browser readiness...");
      const ready = await (this.dependencies.probe ?? probePlaywrightRuntime)({ paths: this.paths, slot, host, browser, signal });
      if (!ready || !ready.browserVersion || !Array.isArray(ready.tools) || !PLAYWRIGHT_REQUIRED_TOOLS.every(name => ready.tools.includes(name))) throw new Error("Incomplete Playwright browser readiness evidence");
      signal?.throwIfAborted();
      const record: PlaywrightRuntimeRecord = { schemaVersion: 1, policy: PLAYWRIGHT_POLICY, id, version: PLAYWRIGHT_VERSION, engineVersion: PLAYWRIGHT_ENGINE_VERSION, manifestSha256: assets.sha256, slot, ...host, browser,
        entrypoint: join(slot, "node_modules", "@playwright", "mcp", "cli.js"), browserVersion: ready.browserVersion, tools: ready.tools, validatedAt: new Date().toISOString() };
      parsePlaywrightRuntime(record, this.paths);
      await this.publish(this.paths.playwrightRoot, join(slot, "ready.json"), record);
      await this.validate(record, assets);
      signal?.throwIfAborted();
      if ((await playwrightConsumers(this.paths, "runtime:")).some(consumer => consumer.active)) throw new Error("Playwright selection deferred: consumers changed during preparation");
      try {
        await this.publish(this.paths.playwrightRoot, this.paths.playwrightSelected, { schemaVersion: 1, id, version: PLAYWRIGHT_VERSION, slot });
      } catch (error) {
        try {
          const observed = await readPlaywrightJson(this.paths.playwrightRoot, this.paths.playwrightSelected) as any;
          if (observed?.id === id) {
            if (previous) await this.publish(this.paths.playwrightRoot, this.paths.playwrightSelected, { schemaVersion: 1, id: previous.id, version: previous.version, slot: previous.slot });
            else { await rm(this.paths.playwrightSelected); await syncDirectory(this.paths.playwrightRoot); }
          } else if (observed && observed.id !== previous?.id) throw new Error("Selection changed unexpectedly");
        } catch {
          await publishJson(this.paths.playwrightRoot, join(this.paths.playwrightRoot, "recovery.json"), { schemaVersion: 1, operation: "publication", runtimeId: id, detail: "Selection publication/restoration uncertain; preserve candidate and prior selection", createdAt: new Date().toISOString() });
          throw new Error("Playwright selection publication/restoration failed; recovery required");
        }
        throw error;
      }
      onProgress("Playwright installation and sandboxed browser validation complete");
      return record;
    } catch (error) {
      if (slot) {
        await publishJson(this.paths.playwrightRoot, join(slot, "failed.json"), { schemaVersion: 1, stage: "preparation", detail: "Runtime preparation failed; candidate retained, never silently selected", createdAt: new Date().toISOString() });
        if (/ownership uncertain|did not quiesce/.test(error instanceof Error ? error.message : "")) {
          await publishJson(this.paths.playwrightRoot, join(this.paths.playwrightRoot, "recovery.json"), { schemaVersion: 1, operation: "cleanup", runtimeId: slot.split("/").at(-1), detail: "Owned preparation process cleanup uncertain; verify quiescence before recovery", createdAt: new Date().toISOString() });
        }
      }
      throw error;
    } finally { await release(); }
  }
}
