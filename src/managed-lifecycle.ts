import { execFile } from "node:child_process";
import { requireSchemaVersion } from "./schema-version.js";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm, statfs } from "node:fs/promises";

/** Small shared filesystem/consumer primitives, not a rollback engine. */
export function assertWithin(root: string, target: string): void {
  const rel = relative(resolve(root), resolve(target));
  if (!isAbsolute(target) || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Managed path escapes protected root: ${target}`);
  }
}

/** Reject symlinks in existing ancestry, including ancestors of the private root. */
export async function assertNoSymlink(path: string): Promise<void> {
  let current = resolve(path);
  for (;;) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`Symlink in managed path: ${current}`);
      if (process.platform !== "win32" && info.isDirectory() && (info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0) {
        throw new Error(`Unsafe writable ancestor in managed path: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/**
 * Use a NEW private namespace. Group/other permission bits inside the managed root are self-healing:
 * every existing component is verified as an owned, real directory and tightened to owner-only, so
 * directories an earlier version left at 775 are repaired. Ancestors of the root are never touched and
 * must still pass `assertNoSymlink`.
 */
export async function ensurePrivateDirectory(root: string, target = root): Promise<void> {
  assertWithin(root, target);
  await assertNoSymlink(dirname(resolve(root)));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rel = relative(root, target);
  let current = root;
  for (const component of ["", ...rel.split(sep).filter(Boolean)]) {
    if (component) current = join(current, component);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await verifyAndTightenDirectory(current);
  }
  await assertNoSymlink(target);
}

/** Owner and type check, then owner-only mode, on one directory without following a symlink swapped in meanwhile. */
async function verifyAndTightenDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`Symlink in managed path: ${path}`);
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) {
    throw new Error(`Unsafe managed directory (owner, or type): ${path}`);
  }
  if (process.platform === "win32" || (info.mode & 0o077) === 0) return;
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.ino !== info.ino || opened.dev !== info.dev || (process.getuid && opened.uid !== process.getuid())) {
      throw new Error(`Unsafe managed directory (changed during repair): ${path}`);
    }
    await handle.chmod(0o700);
  } finally { await handle.close(); }
}

export async function syncDirectory(directory: string): Promise<void> {
  // Windows does not support opening a directory for fsync.
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function publishJson(root: string, path: string, value: unknown): Promise<void> {
  assertWithin(root, path);
  await ensurePrivateDirectory(root, dirname(path));
  await assertNoSymlink(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally { await rm(temporary, { force: true }); }
}

export interface ProcessIdentity { pid: number; start: string; host: string }
/** `ps -o lstart=` prints local time in the caller's locale. Node and the Python proxy monitor
 * both compare these strings, so both must run `ps` with the same fixed locale and time zone
 * (the monitor's own environment is filtered and has neither TZ nor LC_TIME). */
export function psEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...source, LC_ALL: "C", TZ: "UTC" };
}

export type IdentityReader = (pid: number) => Promise<string | null>;

/** OS process birth identity, not merely a reusable PID. Failure is fail-closed. */
export const processBirth: IdentityReader = async (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const raw = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
      return fields[19] ? `${fields[0] === "Z" || fields[0] === "X" ? "linux-dead" : "linux"}:${fields[19]}` : null;
    } catch { return null; }
  }
  return new Promise((done) => {
    const command = process.platform === "win32" ? "powershell.exe" : "ps";
    const args = process.platform === "win32"
      ? ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`]
      : ["-p", String(pid), "-o", "lstart="];
    execFile(command, args, { timeout: 5_000, maxBuffer: 4096, env: process.platform === "win32" ? process.env : psEnvironment() }, (error, stdout) => {
      done(!error && stdout.trim() ? `${process.platform}:${stdout.trim()}` : null);
    });
  });
};

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export async function ownIdentity(readIdentity: IdentityReader = processBirth): Promise<ProcessIdentity> {
  const start = await readIdentity(process.pid);
  if (!start) throw new Error("Cannot establish managed consumer process birth identity");
  return { pid: process.pid, start, host: hostname() };
}

/** Whether the recorded process is still the same running process.
 *
 * `host` is recorded for diagnostics only. Managed state is local to this machine (loopback
 * port, PID and birth-time records; shared or network-mounted state directories are
 * unsupported), so the PID plus its birth identity is authoritative whatever the host is
 * called now. Treating a different host name as fatal would let a renamed laptop (hostname
 * changes between networks) block every activation until someone cleaned up by hand. A record
 * written under another name is live only if that exact process still exists here, and stale
 * otherwise. */
export async function identityLive(owner: ProcessIdentity, readIdentity: IdentityReader = processBirth): Promise<boolean> {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !owner.start ||
      typeof owner.host !== "string" || !owner.host) {
    throw new Error("Unknown managed consumer identity");
  }
  if (!processExists(owner.pid)) return false;
  const current = await readIdentity(owner.pid);
  if (!current) throw new Error(`Cannot verify managed consumer PID ${owner.pid}`);
  return current === owner.start;
}

export interface LockOptions {
  timeoutMs?: number;
  retryMs?: number;
  readIdentity?: IdentityReader;
  signal?: AbortSignal;
}

/** No age-based lock stealing: an uncertain/stale lock needs diagnosed recovery. */
export async function acquireManagedLock(root: string, name: string, options: LockOptions = {}): Promise<() => Promise<void>> {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error("Unsafe managed lock name");
  await ensurePrivateDirectory(root);
  const path = join(root, `${name}.lock`);
  const token = randomUUID();
  const owner = await ownIdentity(options.readIdentity);
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  for (;;) {
    if (options.signal?.aborted) throw new Error("Managed activation cancelled");
    await assertNoSymlink(path);
    let created = false;
    try {
      await mkdir(path, { mode: 0o700 });
      created = true;
      await publishJson(root, join(path, "owner.json"), { schemaVersion: 1, token, ...owner });
      return async () => {
        const record = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
        if (record.token !== token) throw new Error(`Managed lock ownership changed: ${path}`);
        await rm(path, { recursive: true });
      };
    } catch (error) {
      if (created) { await rm(path, { recursive: true, force: true }); throw error; }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const record = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
        requireSchemaVersion(record, "Managed lock owner record");
        if (typeof record.token !== "string") throw new Error("Invalid owner record");
        if (!await identityLive(record, options.readIdentity)) {
          // Automatically rm/rename-stealing a mkdir lock has an ABA race with a
          // newly acquired lock. Preserve it; do not pretend PID checks fix that.
          throw new Error(`Stale managed lock; verify quiescence and remove manually: ${path}`);
        }
      } catch (ownerError) {
        if ((ownerError as NodeJS.ErrnoException).code !== "ENOENT") throw ownerError;
      }
      if (Date.now() >= deadline) throw new Error(`Managed lock busy: ${path}`);
      await new Promise((done) => setTimeout(done, options.retryMs ?? 50));
    }
  }
}

export interface ConsumerLease { token: string; release(): Promise<void> }
export async function createConsumerLease(root: string, resource: string): Promise<ConsumerLease> {
  const token = randomUUID();
  const path = join(root, `${token}.json`);
  await publishJson(root, path, { schemaVersion: 1, token, resource, ...await ownIdentity() });
  let released = false;
  return { token, release: async () => {
    if (released) return;
    await assertNoSymlink(path);
    let record;
    try { record = JSON.parse(await readFile(path, "utf8")); }
    catch (error) {
      // Already removed by dead-lease cleanup: nothing left to release.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { released = true; return; }
      throw error;
    }
    if (record.token !== token) throw new Error("Consumer lease ownership changed");
    await rm(path); released = true;
  } };
}

/** Call under the same activation lock used by new consumers. Unknown records block. */
export async function activeConsumers(root: string, resource?: string): Promise<string[]> {
  await ensurePrivateDirectory(root);
  const active: string[] = [];
  for (const name of await readdir(root)) {
    // Uncommitted atomic lease writes grant no ownership. Their publishers
    // must finish publication under the relevant activation lock before work.
    if (/^[0-9a-f-]+\.json\.[0-9a-f-]+\.tmp$/.test(name)) continue;
    if (!/^[0-9a-f-]+\.json$/.test(name)) throw new Error(`Unknown managed lease entry: ${name}`);
    const path = join(root, name);
    await assertNoSymlink(path);
    let record;
    try {
      const info = await lstat(path);
      if (!info.isFile() || (process.getuid && info.uid !== process.getuid()) ||
          (process.platform !== "win32" && (info.mode & 0o077) !== 0)) throw new Error(`Unsafe lease: ${path}`);
      record = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      // Its owner released the lease after the directory listing: nothing to count.
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      throw error;
    }
    requireSchemaVersion(record, "Managed lease");
    if (`${record.token}.json` !== name || typeof record.resource !== "string") {
      throw new Error(`Invalid managed lease: ${path}`);
    }
    if (!await identityLive(record)) {
      // Provably dead owner (process gone or PID reused). Leases are unique per token and only
      // their owner releases them, so removing one has none of the ABA race that makes lock
      // stealing unsafe. Locks are never removed this way.
      await rm(path, { force: true });
      continue;
    }
    if (!resource || record.resource === resource) active.push(record.token);
  }
  return active;
}

/** Count regular owned data only. Never follow a symlink during a physical backup. */
export async function treeBytes(path: string): Promise<number> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`Symlink in backup source: ${path}`);
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) throw new Error(`Unsupported backup entry: ${path}`);
  let bytes = 0;
  for (const name of await readdir(path)) bytes += await treeBytes(join(path, name));
  return bytes;
}

export async function requireDiskSpace(path: string, requiredBytes: number,
  inspect: typeof statfs = statfs): Promise<void> {
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0) throw new Error("Invalid disk-space estimate");
  const info = await inspect(path);
  const available = Number(info.bavail) * Number(info.bsize);
  if (!Number.isFinite(available) || available < requiredBytes) {
    throw new Error(`Insufficient or unknown safe disk capacity: need ${requiredBytes}, available ${available}`);
  }
}
