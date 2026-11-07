import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { resolveWorkbenchPaths } from "./paths.js";
import { acquireManagedLock, assertNoSymlink, assertWithin, createConsumerLease, identityLive, ownIdentity, processBirth, publishJson, type ConsumerLease } from "./managed-lifecycle.js";
import { assertPlaywrightId, assertPlaywrightMcpConfiguration, assertPlaywrightSession, inspectPlaywrightPath, parsePlaywrightSession, playwrightChildEnvironment, playwrightOptedIn, playwrightWorkspaceLock, preparePlaywrightTransient, readPlaywrightJson, resolvePlaywrightProject, resolvePlaywrightSession } from "./playwright-config.js";
import { PlaywrightRuntime } from "./playwright-runtime.js";
import { playwrightGroupMembers } from "./playwright-process.js";
import { PlaywrightOwnedTree } from "./playwright-tree.js";
import { readPlaywrightOwnership, retirePlaywrightOwnership } from "./playwright-ownership.js";
const MCP_BOOTSTRAP = fileURLToPath(new URL("./playwright-mcp-bootstrap.mjs", import.meta.url));

export interface PlaywrightLauncherSpec { schema: 1; home: string; workspace: string; sessionId: string; runtimeId: string; command: string; args: string[] }
export function parsePlaywrightLauncherSpec(raw: unknown): PlaywrightLauncherSpec {
  const fields = ["schema", "home", "workspace", "sessionId", "runtimeId", "command", "args"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(raw, key))) throw new Error("Invalid Playwright launcher specification");
  const spec = raw as PlaywrightLauncherSpec;
  if (spec.schema !== 1 || ![spec.home, spec.workspace, spec.command].every(path => typeof path === "string" && isAbsolute(path) && resolve(path) === path && !path.includes("\0")) || !Array.isArray(spec.args) || !spec.args.every(arg => typeof arg === "string")) throw new Error("Invalid Playwright launcher paths/arguments");
  assertPlaywrightId(spec.sessionId); assertPlaywrightId(spec.runtimeId);
  return spec;
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Actual Pi stdio children get their own group. Never signal Pi's or a shell's group. */
export async function assertPlaywrightLauncherGroup(): Promise<void> {
  if (process.platform !== "linux") throw new Error("Playwright launcher requires Linux process ownership");
  const raw = await readFile(`/proc/${process.pid}/stat`, "utf8");
  if (Number(raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/)[2]) !== process.pid) throw new Error("Playwright launcher requires an isolated owned process group");
}
async function stopOtherGroupMembers(): Promise<void> {
  // The supervisor itself stays alive and anchors this group throughout cleanup.
  await assertPlaywrightLauncherGroup();
  const others = async () => (await playwrightGroupMembers(process.pid)).filter(owner => owner.pid !== process.pid);
  for (const [signal, budget] of [["SIGTERM", 1500], ["SIGKILL", 1500]] as const) {
    const deadline = Date.now() + budget;
    do {
      const members = await others();
      if (!members.length) return;
      for (const owner of members) {
        if (await identityLive(owner)) {
          try { process.kill(owner.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        }
      }
      await delay(20);
    } while (Date.now() < deadline);
  }
  if ((await others()).length) throw new Error("Playwright descendants did not quiesce; ownership evidence retained");
}

export async function launchPlaywrightMcp(raw: unknown): Promise<void> {
  const spec = parsePlaywrightLauncherSpec(raw);
  await assertPlaywrightLauncherGroup();
  const paths = resolveWorkbenchPaths(spec.home), project = resolvePlaywrightProject(spec.workspace, paths), session = resolvePlaywrightSession(project, spec.sessionId);
  assertPlaywrightSession(session);
  const startup = new AbortController();
  let requested = false, parentCancelled = false, failure: unknown, child: ChildProcessWithoutNullStreams | undefined;
  let runtimeLease: ConsumerLease | undefined, workspaceLease: ConsumerLease | undefined;
  let tree: PlaywrightOwnedTree | undefined;
  let code = 0, closed: Promise<void> | undefined, wake!: () => void;
  const request = new Promise<void>(resolve => { wake = resolve; });
  const buffered: Buffer[] = []; let bufferedBytes = 0;
  const close = () => { if (requested) return; requested = true; startup.abort(); child?.stdin.end(); wake(); };
  const buffer = (data: Buffer) => {
    bufferedBytes += data.length;
    if (bufferedBytes > 16 * 1024 * 1024) { close(); return; }
    buffered.push(data);
  };
  const parentClose = () => { parentCancelled = true; close(); };
  process.stdin.on("data", buffer); process.stdin.once("end", parentClose); process.stdin.resume();
  process.on("SIGTERM", parentClose); process.on("SIGINT", parentClose);
  process.stdout.once("error", close); process.stderr.once("error", close);
  const supervisor = await ownIdentity();
  try {
    await inspectPlaywrightPath(paths.playwrightRoot, session.markerPath);
    const releaseRuntime = await acquireManagedLock(paths.playwrightCoordination, "install", { signal: startup.signal, timeoutMs: 120000 });
    try {
      const runtime = new PlaywrightRuntime({ paths }), selected = await runtime.selected();
      if (!selected || selected.id !== spec.runtimeId) throw new Error("Playwright selection changed; child startup deferred");
      if (spec.command !== selected.node.path || !isDeepStrictEqual(spec.args, [selected.entrypoint, "--config", session.configPath])) throw new Error("Playwright child executable/entrypoint mismatch");
      await runtime.validate(selected);
      const releaseWorkspace = await playwrightWorkspaceLock(project, startup.signal);
      try {
        startup.signal.throwIfAborted();
        if (!await playwrightOptedIn(project)) throw new Error("Playwright workspace disabled before child startup");
        const marker = parsePlaywrightSession(await readPlaywrightJson(paths.playwrightRoot, session.markerPath));
        if (marker.sessionId !== session.id || marker.runtimeId !== selected.id || marker.workspace !== project.projectPath || marker.identifier !== project.identifier || !await identityLive(marker.owner)) throw new Error("Playwright session identity/owner changed before startup");
        assertPlaywrightMcpConfiguration(await readPlaywrightJson(paths.playwrightRoot, session.configPath), session, selected.browser);
        const prior = await readPlaywrightOwnership(session);
        if (prior) {
          await retirePlaywrightOwnership(session, prior); // Refuses a second active owner of this session.
          for (const path of [session.home, session.cache, session.tmp]) { assertWithin(session.directory, path); await assertNoSymlink(path); await rm(path, { recursive: true, force: true }); }
        }
        await preparePlaywrightTransient(session);
        const env = playwrightChildEnvironment(session, selected, paths.playwrightNpmCache);
        workspaceLease = await createConsumerLease(paths.playwrightConsumers, `workspace:${project.identifier}`);
        runtimeLease = await createConsumerLease(paths.playwrightConsumers, `runtime:${selected.id}`);
        startup.signal.throwIfAborted();
        child = spawn(selected.node.path, [MCP_BOOTSTRAP, JSON.stringify({ schema: 1, command: selected.node.path, args: spec.args, root: paths.playwrightRoot, browser: selected.browser, home: session.home, tmp: session.tmp })], { cwd: project.projectPath, env, detached: false, stdio: ["pipe", "pipe", "pipe"] });
        child.stdin.on("error", close);
        closed = new Promise<void>(resolve => child!.once("close", exitCode => { code = exitCode ?? 1; wake(); resolve(); }));
        await new Promise<void>((resolve, reject) => { child!.once("spawn", resolve); child!.once("error", reject); });
        const start = await processBirth(child.pid!);
        if (!start) throw new Error("Cannot establish Playwright MCP child birth identity");
        const owner = { pid: child.pid!, start, host: hostname() };
        for (const [lease, resource] of [[workspaceLease, `workspace:${project.identifier}`], [runtimeLease, `runtime:${selected.id}`]] as const) {
          await publishJson(paths.playwrightRoot, join(paths.playwrightConsumers, `${lease.token}.json`), { schema: 1, token: lease.token, resource, ...owner, supervisor, group: process.pid, sessionId: session.id, runtimeId: selected.id, runtimeVersion: selected.version, workspace: project.projectPath });
        }
        const ownership = { schema: 1, sessionId: session.id, runtimeId: selected.id, runtimeVersion: selected.version, supervisor, child: owner, group: process.pid, workspaceToken: workspaceLease.token, runtimeToken: runtimeLease.token };
        await publishJson(paths.playwrightRoot, join(session.directory, "ownership.json"), ownership);
        tree = new PlaywrightOwnedTree({ sessionId: session.id, runtimeId: selected.id, browserRoot: join(selected.slot, "browsers"), directory: session.directory }, [supervisor, owner], async snapshot => {
          await publishJson(paths.playwrightRoot, join(session.directory, "ownership.json"), { ...ownership, processes: snapshot.processes, uncertain: snapshot.uncertain });
        });
        await tree.capture(); tree.start(error => { failure = error; close(); });
        startup.signal.throwIfAborted();
        child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
        process.stdin.removeListener("data", buffer);
        for (const data of buffered) child.stdin.write(data);
        buffered.length = 0;
        process.stdin.pipe(child.stdin);
      } finally { await releaseWorkspace(); }
    } finally { await releaseRuntime(); }
    await request;
  } catch (error) { if (!parentCancelled) failure = error; }
  finally {
    process.stdin.removeListener("data", buffer); process.stdin.unpipe(); process.stdin.pause();
    child?.stdin.end();
    try {
      // EOF first; then bounded group cleanup, including descendants after MCP exit.
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline && (await playwrightGroupMembers(process.pid)).some(owner => owner.pid !== process.pid)) await delay(20);
      await tree?.stop(process.pid);
      await stopOtherGroupMembers();
      if (closed) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Playwright child close unconfirmed")), 1000);
        void closed!.then(() => { clearTimeout(timer); resolve(); }, reject);
      });
      await runtimeLease?.release(); await workspaceLease?.release();
      if (child) {
        await publishJson(paths.playwrightRoot, join(session.directory, "stopped.json"), { schema: 1, sessionId: session.id, runtimeId: spec.runtimeId, group: process.pid, clean: true, stoppedAt: new Date().toISOString() });
        for (const path of [session.home, session.cache, session.tmp]) { assertWithin(session.directory, path); await assertNoSymlink(path); await rm(path, { recursive: true, force: true }); }
      }
    } catch (error) {
      failure = error;
      child?.stdin.destroy(); child?.stdout.destroy(); child?.stderr.destroy(); child?.unref();
      try { await publishJson(paths.playwrightRoot, join(session.directory, "cleanup-pending.json"), { schema: 1, sessionId: session.id, runtimeId: spec.runtimeId, group: process.pid, detail: "Owned process cleanup uncertain; preserve leases and data", createdAt: new Date().toISOString() }); } catch { /* Never erase existing evidence to mask failed cleanup. */ }
    }
    process.stdin.destroy();
    if (failure) { process.stderr.write("Managed Playwright startup/cleanup failed; inspect owned session state before retrying.\n"); process.exitCode = 1; }
    else process.exitCode = parentCancelled ? 0 : code;
  }
}
