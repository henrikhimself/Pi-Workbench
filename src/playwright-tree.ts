import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import { identityLive, type ProcessIdentity } from "./managed-lifecycle.js";

export interface PlaywrightTreeScope { sessionId: string; runtimeId: string; browserRoot: string; directory?: string }
interface Row extends ProcessIdentity { parent: number; group: number }
export interface PlaywrightTreeSnapshot { processes: Row[]; uncertain: boolean }
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function inside(root: string, path: string): boolean { const rel = relative(root, path); return isAbsolute(path) && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); }
async function rows(): Promise<Row[]> {
  const result: Row[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const directory = `/proc/${name}`, info = await lstat(directory);
      if (process.getuid && info.uid !== process.getuid()) continue;
      const raw = await readFile(`${directory}/stat`, "utf8"), fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
      if (fields[0] !== "Z" && fields[0] !== "X" && fields[19]) result.push({ pid: Number(name), start: `linux:${fields[19]}`, host: hostname(), parent: Number(fields[1]), group: Number(fields[2]) });
    } catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  }
  return result;
}

/** Birth identities + live ancestry + private session tags, including detached Chromium groups.
 * No raw command lines/environments are returned or persisted. Unknown candidates are never killed.
 */
export class PlaywrightOwnedTree {
  private known = new Map<number, ProcessIdentity>();
  private pulse?: ReturnType<typeof setInterval>;
  private scanning: Promise<PlaywrightTreeSnapshot> | null = null;
  private last = "";
  constructor(readonly scope: PlaywrightTreeScope, roots: ProcessIdentity[] = [], private changed?: (snapshot: PlaywrightTreeSnapshot) => Promise<void>) {
    if (!/^[0-9a-f-]{36}$/.test(scope.sessionId) || !/^[0-9a-f-]{36}$/.test(scope.runtimeId) || !isAbsolute(scope.browserRoot) || scope.directory !== undefined && !isAbsolute(scope.directory)) throw new Error("Invalid Playwright process-tree scope");
    for (const root of roots) {
      if (!Number.isSafeInteger(root.pid) || root.pid <= 0 || !root.start || root.host !== hostname()) throw new Error("Invalid/foreign Playwright process-tree witness");
      this.known.set(root.pid, root);
    }
  }
  capture(): Promise<PlaywrightTreeSnapshot> {
    return this.scanning ??= this.scan().finally(() => { this.scanning = null; });
  }
  private async scan(): Promise<PlaywrightTreeSnapshot> {
    const processes = await rows(), owned = new Set<number>(), ownedGroups = new Set<number>(), foreignGroups = new Set<number>(), unknown = new Set<number>();
    for (const row of processes) if (this.known.get(row.pid)?.start === row.start) owned.add(row.pid);
    const expand = () => {
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of processes) {
          if (owned.has(row.pid)) ownedGroups.add(row.group);
          else if (owned.has(row.parent) || ownedGroups.has(row.group)) { owned.add(row.pid); changed = true; }
        }
      }
    };
    expand();
    let unreadable = false;
    // Only browser executables under this immutable runtime are environment-tag candidates.
    for (const row of processes) {
      if (owned.has(row.pid)) continue;
      try {
        let executable: string;
        try { executable = (await readlink(`/proc/${row.pid}/exe`)).replace(/ \(deleted\)$/, ""); }
        catch (error) {
          if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
          if (!["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          try { executable = (await readFile(`/proc/${row.pid}/cmdline`, "utf8")).split("\0")[0]; }
          catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) unreadable = true; continue; }
        }
        if (!inside(this.scope.browserRoot, executable)) continue;
        if (this.scope.directory) {
          try {
            const args = (await readFile(`/proc/${row.pid}/cmdline`, "utf8")).split("\0");
            let witness = false;
            for (const arg of args) {
              const value = /^--(?:user-data-dir|database|crash-dumps-dir|logs_dir)=(.*)$/.exec(arg)?.[1];
              if (!value) continue;
              const canonical = /^\/proc\/\d+\/fd\/\d+(?:\/|$)/.test(value) ? await realpath(value).catch(() => value) : value;
              if (inside(this.scope.directory, canonical)) { witness = true; break; }
            }
            if (witness) { owned.add(row.pid); continue; }
          } catch (error) { if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) continue; }
        }
        let values: string[];
        try { values = (await readFile(`/proc/${row.pid}/environ`, "utf8")).split("\0"); }
        catch (error) { if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) continue; unknown.add(row.pid); continue; }
        const session = values.find(value => value.startsWith("WB_PLAYWRIGHT_SESSION_ID="))?.slice(25);
        const runtime = values.find(value => value.startsWith("WB_PLAYWRIGHT_RUNTIME_ID="))?.slice(25);
        if (session === this.scope.sessionId && runtime === this.scope.runtimeId) owned.add(row.pid);
        else if (session && runtime) foreignGroups.add(row.group);
        else unknown.add(row.pid);
      } catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    }
    // Each live witnessed member anchors its current group. Detached children also
    // enter through ancestry before parent exit, or through their browser's session tag.
    expand();
    const result = processes.filter(row => owned.has(row.pid));
    for (const row of result) this.known.set(row.pid, row);
    const snapshot = { processes: result, uncertain: unreadable || processes.some(row => unknown.has(row.pid) && !owned.has(row.pid) && !foreignGroups.has(row.group)) };
    const identity = result.map(row => `${row.pid}:${row.start}:${row.group}`).sort().join("|") + `:${snapshot.uncertain}`;
    if (identity !== this.last) { this.last = identity; await this.changed?.(snapshot); }
    return snapshot;
  }
  start(onFailure: (error: unknown) => void): void {
    if (this.pulse) return;
    this.pulse = setInterval(() => { void this.capture().catch(onFailure); }, 100);
  }
  async stop(protectedPid: number = process.pid): Promise<void> {
    try { await this.stopTargets(protectedPid); }
    catch { throw new Error("Playwright detached process ownership uncertain; preserve leases and data"); }
  }
  private async stopTargets(protectedPid: number): Promise<void> {
    clearInterval(this.pulse); this.pulse = undefined;
    if (this.scanning) await this.scanning;
    const self = await readFile(`/proc/${protectedPid}/stat`, "utf8");
    const protectedGroup = Number(self.slice(self.lastIndexOf(")") + 2).trim().split(/\s+/)[2]);
    for (const [signal, budget] of [["SIGTERM", 1500], ["SIGKILL", 1500]] as const) {
      const deadline = Date.now() + budget;
      do {
        const snapshot = await this.capture(), targets = snapshot.processes.filter(row => row.pid !== protectedPid);
        if (!targets.length && !snapshot.uncertain) return;
        const groups = new Set<number>();
        for (const target of targets) {
          if (!await identityLive(target)) continue;
          try {
            if (protectedGroup !== target.group && !groups.has(target.group)) { groups.add(target.group); process.kill(-target.group, signal); }
            else if (protectedGroup === target.group) process.kill(target.pid, signal);
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        }
        await pause(20);
      } while (Date.now() < deadline);
    }
    const remaining = await this.capture();
    if (remaining.processes.some(row => row.pid !== protectedPid) || remaining.uncertain) throw new Error("Playwright detached process ownership uncertain; preserve leases and data");
  }
}
