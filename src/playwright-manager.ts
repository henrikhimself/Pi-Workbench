import { lstat, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import { acquireManagedLock, createConsumerLease, syncDirectory, type ConsumerLease } from "./managed-lifecycle.js";
import { WORKBENCH_PATHS, type WorkbenchPaths } from "./paths.js";
import { createPlaywrightVisionConfigReader, ensurePlaywrightUserConfig, formatPlaywrightVisionConfig, type PlaywrightVisionConfigState } from "./playwright-vision-config.js";
import { PLAYWRIGHT_ENGINE_VERSION, PLAYWRIGHT_SERVER_NAME, PLAYWRIGHT_VERSION, assertPlaywrightProject, inspectPlaywrightPath, playwrightChildEnvironment, playwrightOptedIn, playwrightPiEnvironment, playwrightWorkspaceLock, preparePlaywrightSession, readPlaywrightJson, resolvePlaywrightProject, resolvePlaywrightSession, setPlaywrightOptIn, type PlaywrightProject, type PlaywrightRuntimeRecord, type PlaywrightSession } from "./playwright-config.js";
import { PlaywrightRuntime, playwrightConsumers, type PlaywrightProgress } from "./playwright-runtime.js";
import { attestPlaywrightWitnesses, readPlaywrightOwnership, retirePlaywrightOwnership } from "./playwright-ownership.js";
import { PlaywrightOwnedTree } from "./playwright-tree.js";
import { PLAYWRIGHT_NORMAL_TOOLS, PLAYWRIGHT_TOOL_EXPOSURE } from "./playwright-policy.js";

const launcher = fileURLToPath(new URL("./playwright-launcher.mjs", import.meta.url));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Evidence = NonNullable<Awaited<ReturnType<typeof readPlaywrightOwnership>>>;
export interface PlaywrightManagerDependencies {
  paths?: WorkbenchPaths;
  runtime?: Pick<PlaywrightRuntime, "ensure" | "selected">;
  register: (name: string, config: McpServerConfig) => void;
  unregister: (name: string) => void;
  conflict?: () => Promise<string | null>;
  isCurrent?: (config: McpServerConfig) => boolean;
  tools?: () => string[];
  progress?: PlaywrightProgress;
  signal?: AbortSignal;
  // Narrow deterministic lifecycle seams; no user-configurable policy overrides.
  observe?: (session: PlaywrightSession) => Promise<boolean>;
  stop?: (session: PlaywrightSession) => Promise<void>;
  remove?: (path: string) => Promise<void>;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}
export interface PlaywrightStatus {
  intent: "on" | "off" | "invalid";
  vision?: PlaywrightVisionConfigState;
  registered: boolean;
  currentRegistration: boolean;
  ownedChild: boolean;
  tools: string[];
  selected: PlaywrightRuntimeRecord | null;
  workspace: string;
  directory: string;
  session: string | null;
  consumers: number;
  failures: string[];
}

/** Workspace-bound controller. Constructor/status/opted-out restore never prepare roots. */
export class PlaywrightManager {
  readonly paths: WorkbenchPaths;
  readonly project: PlaywrightProject;
  private runtime: Pick<PlaywrightRuntime, "ensure" | "selected">;
  private generation = 0;
  private stopEpoch = 0;
  private controller?: AbortController;
  private activation?: Promise<void>;
  private stopping?: Promise<void>;
  private deleting?: Promise<boolean>;
  private registered = false;
  private config?: McpServerConfig;
  private session?: PlaywrightSession;
  private evidence?: Evidence;
  private failure?: string;
  private readVision?: () => Promise<PlaywrightVisionConfigState>;
  constructor(cwd: string, private deps: PlaywrightManagerDependencies) {
    this.paths = deps.paths ?? WORKBENCH_PATHS;
    this.project = resolvePlaywrightProject(cwd, this.paths);
    this.runtime = deps.runtime ?? new PlaywrightRuntime({ paths: this.paths });
  }
  private progress(message: string): void { try { this.deps.progress?.(message); } catch { /* UI cannot change transaction outcome. */ } }
  get managedSession(): PlaywrightSession | undefined { return this.session; }
  get isManagedRegistration(): boolean { return this.current(); }
  /** Ownership proof survives a transport drop; not evidence of current connectivity.
   * Keep output/unsafe policy enforced when Pi reconnects this same owned route.
   */
  async ownsToolRoute(): Promise<boolean> {
    if (!this.current()) return false;
    if (this.evidence) return true;
    const observed = await this.observe();
    return this.current() && (observed || !!this.evidence);
  }
  private current(): boolean { return this.registered && !!this.config && (this.deps.isCurrent?.(this.config) ?? true); }
  private fence(epoch: number, signal: AbortSignal): void { signal.throwIfAborted(); if (epoch !== this.generation) throw new Error("Playwright activation superseded"); }
  async restore(): Promise<void> { const stopped = this.stopEpoch; if (await playwrightOptedIn(this.project)) await this.start(false, stopped); }
  async on(): Promise<void> { const stopped = this.stopEpoch; if (this.deleting) await this.deleting.catch(() => {}); await this.start(true, stopped); }
  private async start(explicit: boolean, stopped: number): Promise<void> {
    if (this.stopping) await this.stopping;
    if (stopped !== this.stopEpoch) throw new Error("Playwright activation superseded by shutdown/off");
    if (this.activation) return this.activation;
    const operation = this.activate(explicit); this.activation = operation;
    try { await operation; } finally { if (this.activation === operation) this.activation = undefined; }
  }
  private async observe(): Promise<boolean> {
    if (!this.session) return false;
    if (this.deps.observe) return this.deps.observe(this.session);
    const evidence = await readPlaywrightOwnership(this.session);
    if (!evidence) return false;
    this.evidence = evidence;
    return evidence.roots.some(owner => owner.pid === evidence.record.child.pid && owner.start === evidence.record.child.start);
  }
  private async activate(explicit: boolean): Promise<void> {
    const epoch = ++this.generation, controller = new AbortController(); this.controller = controller;
    const signal = this.deps.signal ? AbortSignal.any([controller.signal, this.deps.signal]) : controller.signal;
    let workspaceLease: ConsumerLease | undefined, runtimeLease: ConsumerLease | undefined;
    try {
      this.fence(epoch, signal);
      if (this.current() && await this.observe()) { this.fence(epoch, signal); return; }
      this.fence(epoch, signal);
      if (this.registered) { this.unregister(); await this.stopOwned(); this.fence(epoch, signal); }
      if (explicit) await setPlaywrightOptIn(this.project, true, signal);
      if (explicit) { try { await ensurePlaywrightUserConfig(this.paths.playwrightConfig); } catch { this.progress("playwright.json template could not be created; vision bridge stays off"); } }
      if (!await playwrightOptedIn(this.project)) return;
      this.fence(epoch, signal);
      const conflict = await this.deps.conflict?.();
      if (conflict) throw new Error(`Managed Playwright unavailable: ${conflict}. Existing server left untouched.`);
      const workspaceUnlock = await playwrightWorkspaceLock(this.project, signal);
      try {
        this.fence(epoch, signal);
        if (!await playwrightOptedIn(this.project)) throw new Error("Playwright workspace disabled during activation");
        workspaceLease = await createConsumerLease(this.paths.playwrightConsumers, `workspace:${this.project.identifier}`);
      } finally { await workspaceUnlock(); }
      const ready = await this.runtime.ensure(message => { if (epoch === this.generation && !signal.aborted) this.progress(message); }, signal);
      this.fence(epoch, signal);
      const runtimeUnlock = await acquireManagedLock(this.paths.playwrightCoordination, "install", { signal, timeoutMs: 120000 });
      try {
        const selected = await this.runtime.selected();
        if (!selected || selected.id !== ready.id) throw new Error("Playwright runtime selection changed before registration");
        runtimeLease = await createConsumerLease(this.paths.playwrightConsumers, `runtime:${ready.id}`);
      } finally { await runtimeUnlock(); }
      const unlock = await playwrightWorkspaceLock(this.project, signal);
      try {
        this.fence(epoch, signal);
        if (!await playwrightOptedIn(this.project)) throw new Error("Playwright workspace disabled before registration");
        const session = resolvePlaywrightSession(this.project);
        await preparePlaywrightSession(session, ready);
        this.fence(epoch, signal);
        this.session = session; this.evidence = undefined;
        this.config = this.serverConfig(session, ready);
        const latestConflict = await this.deps.conflict?.();
        this.fence(epoch, signal);
        if (latestConflict) throw new Error(`Managed Playwright registration conflict: ${latestConflict}`);
        this.deps.register(PLAYWRIGHT_SERVER_NAME, this.config); this.registered = true;
      } finally { await unlock(); }
      this.progress("Waiting for owned Playwright MCP startup");
      const deadline = Date.now() + (this.deps.startupTimeoutMs ?? 30000);
      while (!await this.observe()) {
        this.fence(epoch, signal);
        if (!this.current()) throw new Error("Managed Playwright registration unavailable or overridden");
        if (Date.now() >= deadline) throw new Error("Owned Playwright MCP did not start; check built-in MCP integration and session diagnostics");
        await pause(25);
      }
      this.fence(epoch, signal);
      if (!this.current()) throw new Error("Managed Playwright registration was overridden during startup");
      this.failure = undefined;
      this.progress("Playwright registered; browser opens lazily on tool use");
    } catch (error) {
      let cleanup: unknown;
      try { this.unregister(); await this.stopOwned(); } catch (failure) { cleanup = failure; }
      this.failure = cleanup ? "Playwright activation failed and owned cleanup remains incomplete" : error instanceof Error ? error.message : "Playwright activation failed";
      if (!signal.aborted) this.progress(this.failure);
      throw cleanup ?? error;
    } finally { await runtimeLease?.release(); await workspaceLease?.release(); }
  }
  private serverConfig(session: PlaywrightSession, runtime: PlaywrightRuntimeRecord): McpServerConfig {
    const spec = { schema: 1, home: dirname(dirname(this.paths.root)), workspace: this.project.projectPath, sessionId: session.id, runtimeId: runtime.id, command: runtime.node.path, args: [runtime.entrypoint, "--config", session.configPath] };
    const env = playwrightPiEnvironment(playwrightChildEnvironment(session, runtime, this.paths.playwrightNpmCache));
    if ([runtime.node.path, launcher, JSON.stringify(spec), this.project.projectPath, ...Object.values(env)].some(value => value.includes("${") || value.startsWith("!"))) throw new Error("Unsafe MCP interpolation in Playwright managed paths/environment");
    return { type: "stdio", command: runtime.node.path, args: [launcher, JSON.stringify(spec)], cwd: this.project.projectPath, env,
      exposure: "direct", toolExposure: { ...PLAYWRIGHT_TOOL_EXPOSURE }, timeout: 120,
      description: "Managed isolated headless Chromium; standard Playwright tools plus vision, sandbox required." };
  }
  private unregister(): void {
    if (!this.registered) return;
    if (this.current()) this.deps.unregister(PLAYWRIGHT_SERVER_NAME);
    this.registered = false;
  }
  private async stopOwned(): Promise<void> {
    if (!this.session) return;
    if (this.deps.stop) return this.deps.stop(this.session);
    const deadline = Date.now() + (this.deps.shutdownTimeoutMs ?? 6000);
    for (;;) {
      let evidence = await readPlaywrightOwnership(this.session);
      if (!evidence && this.evidence) {
        evidence = { ...this.evidence, roots: await attestPlaywrightWitnesses(this.evidence.scope, [this.evidence.record.supervisor, this.evidence.record.child, ...(this.evidence.record.processes ?? [])]) };
      }
      if (!evidence) return;
      const tree = new PlaywrightOwnedTree(evidence.scope, evidence.roots), snapshot = await tree.capture();
      if (!snapshot.processes.length && !snapshot.uncertain) { await retirePlaywrightOwnership(this.session, evidence); return; }
      if (Date.now() >= deadline) {
        await tree.stop();
        await retirePlaywrightOwnership(this.session, evidence);
        return;
      }
      await pause(25);
    }
  }
  /** Stop only this controller's session; retain opt-in, artifacts, and diagnostics. */
  shutdown(): Promise<void> {
    ++this.stopEpoch; ++this.generation; this.controller?.abort();
    if (this.stopping) return this.stopping;
    let unregisterFailure: unknown;
    try { this.unregister(); } catch (error) { unregisterFailure = error; }
    const operation = (async () => {
      await this.activation?.catch(() => {});
      await this.stopOwned();
      if (unregisterFailure) throw unregisterFailure;
    })();
    this.stopping = operation;
    void operation.finally(() => { if (this.stopping === operation) this.stopping = undefined; }).catch(() => {});
    return operation;
  }
  /** Caller obtains interactive or explicit noninteractive confirmation first. */
  off(confirmed: boolean): Promise<boolean> {
    if (confirmed !== true) return Promise.resolve(false);
    ++this.stopEpoch;
    if (this.deleting) return this.deleting;
    const operation = this.removeWorkspace(); this.deleting = operation;
    void operation.finally(() => { if (this.deleting === operation) this.deleting = undefined; }).catch(() => {});
    return operation;
  }
  private async removeWorkspace(): Promise<boolean> {
    try {
      await this.shutdown();
      try { await lstat(this.project.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
      const unlock = await playwrightWorkspaceLock(this.project);
      try {
        assertPlaywrightProject(this.project);
        await inspectPlaywrightPath(this.project.root, this.project.directory);
        const consumers = await playwrightConsumers(this.paths, `workspace:${this.project.identifier}`);
        if (consumers.some(consumer => consumer.active)) throw new Error("Playwright off incomplete: same-workspace peers remain active; intent and data retained. No peer was stopped.");
        for (const consumer of consumers) {
          const raw = await readPlaywrightJson(this.project.root, consumer.path) as any;
          if (!raw?.sessionId) throw new Error("Playwright completed consumer lacks session recovery evidence");
          const session = resolvePlaywrightSession(this.project, raw.sessionId), evidence = await readPlaywrightOwnership(session);
          if (!evidence) throw new Error("Playwright completed consumer ownership unavailable");
          await retirePlaywrightOwnership(session, evidence);
        }
        await inspectPlaywrightPath(this.project.root, this.project.directory);
        await (this.deps.remove ?? (path => rm(path, { recursive: true })))(this.project.directory);
        try { await lstat(this.project.directory); throw new Error("Playwright workspace deletion unconfirmed"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await syncDirectory(this.paths.playwrightProjects);
        this.session = undefined; this.evidence = undefined; this.config = undefined;
        this.failure = undefined; this.progress("Playwright off; workspace data deleted, shared installation retained");
        return true;
      } finally { await unlock(); }
    } catch (error) { this.failure = error instanceof Error ? error.message : "Playwright off incomplete"; throw error; }
  }
  /** Passive read of the user-wide vision config; never creates or edits it. */
  async visionConfig(): Promise<PlaywrightVisionConfigState> { this.readVision ??= createPlaywrightVisionConfigReader(this.paths.playwrightConfig); return this.readVision(); }
  async status(): Promise<PlaywrightStatus> {
    const failures: string[] = this.failure ? [this.failure] : [];
    let intent: PlaywrightStatus["intent"] = "off", selected: PlaywrightRuntimeRecord | null = null, ownedChild = false, consumers = 0;
    try { intent = await playwrightOptedIn(this.project) ? "on" : "off"; } catch { intent = "invalid"; failures.push("Workspace opt-in invalid or unsafe"); }
    try { selected = await this.runtime.selected(); } catch { failures.push("Selected runtime metadata invalid or unsafe"); }
    try { consumers = (await playwrightConsumers(this.paths, `workspace:${this.project.identifier}`)).filter(consumer => consumer.active).length; } catch { failures.push("Consumer ownership requires diagnosed recovery"); }
    try {
      if (this.session) {
        const evidence = await readPlaywrightOwnership(this.session);
        ownedChild = !!evidence?.roots.some(owner => owner.pid === evidence.record.child.pid && owner.start === evidence.record.child.start);
      }
    } catch { failures.push("Owned session evidence invalid or unsafe"); }
    const vision = await this.visionConfig();
    return { intent, vision, registered: this.registered, currentRegistration: this.current(), ownedChild,
      tools: this.current() ? (this.deps.tools?.() ?? []).filter(name => PLAYWRIGHT_NORMAL_TOOLS.some(tool => name === `mcp__playwright__${tool}`)) : [],
      selected, workspace: this.project.projectPath, directory: this.project.directory, session: this.session?.directory ?? null, consumers, failures };
  }
}

export function formatPlaywrightStatus(status: PlaywrightStatus): string {
  return [
    `Playwright saved intent: ${status.intent}`, `Workspace: ${status.workspace}`,
    `Target: @playwright/mcp ${PLAYWRIGHT_VERSION}; playwright/core ${PLAYWRIGHT_ENGINE_VERSION}`,
    `Selected runtime: ${status.selected ? `${status.selected.version} / ${status.selected.id}` : "none"}`,
    `Managed registration: ${status.currentRegistration ? "current" : status.registered ? "overridden/unavailable" : "not registered"}`,
    `Owned MCP child: ${status.ownedChild ? "observed running" : "not observed running"}; active workspace consumers: ${status.consumers}`,
    `Observed non-hidden tool registrations: ${status.tools.length ? status.tools.join(", ") : "none"}`,
    `Last readiness: ${status.selected ? `${status.selected.validatedAt}; Chromium ${status.selected.browserVersion}` : "none"}`,
    "Policy: headless isolated Chromium; sandbox required; vision on; WebMCP off; unsafe server code hidden; idle timeout 0; unrestricted HTTP(S)",
    ...(status.vision ? [formatPlaywrightVisionConfig(status.vision)] : []),
    "Browser state: lazy; status does not launch a browser or prove one is open",
    `Workspace data: ${status.directory}`, `Session: ${status.session ?? "none"}`,
    "Artifacts/diagnostics retained until confirmed workspace off; no quota, TTL, or automatic artifact/runtime GC",
    ...status.failures.map(failure => `Failure/blocker: ${failure}`),
  ].join("\n");
}
