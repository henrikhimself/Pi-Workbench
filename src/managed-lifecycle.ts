import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, statfs } from "node:fs/promises";

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

/** Use a NEW private namespace; never chmod/adopt existing unsafe directories. */
export async function ensurePrivateDirectory(root: string, target = root): Promise<void> {
  assertWithin(root, target);
  await assertNoSymlink(target);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rel = relative(root, target);
  let current = root;
  for (const component of ["", ...rel.split(sep).filter(Boolean)]) {
    if (component) current = join(current, component);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() ||
        (process.getuid && info.uid !== process.getuid()) ||
        (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
      throw new Error(`Unsafe managed directory (owner, type or permissions): ${current}`);
    }
  }
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
    execFile(command, args, { timeout: 5_000, maxBuffer: 4096 }, (error, stdout) => {
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

export async function identityLive(owner: ProcessIdentity, readIdentity: IdentityReader = processBirth): Promise<boolean> {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !owner.start || owner.host !== hostname()) {
    throw new Error("Unknown or foreign managed consumer identity");
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
      await publishJson(root, join(path, "owner.json"), { schema: 1, token, ...owner });
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
        if (record.schema !== 1 || typeof record.token !== "string") throw new Error("Invalid owner record");
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
  await publishJson(root, path, { schema: 1, token, resource, ...await ownIdentity() });
  let released = false;
  return { token, release: async () => {
    if (released) return;
    await assertNoSymlink(path);
    const record = JSON.parse(await readFile(path, "utf8"));
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
    const info = await lstat(path);
    if (!info.isFile() || (process.getuid && info.uid !== process.getuid()) ||
        (process.platform !== "win32" && (info.mode & 0o077) !== 0)) throw new Error(`Unsafe lease: ${path}`);
    const record = JSON.parse(await readFile(path, "utf8"));
    if (record.schema !== 1 || `${record.token}.json` !== name || typeof record.resource !== "string") {
      throw new Error(`Invalid managed lease: ${path}`);
    }
    if (await identityLive(record) && (!resource || record.resource === resource)) active.push(record.token);
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

export interface SwapOptions { rename?: typeof rename }
/** Caller must quiesce writers and validate staging first. Backup retained on success. */
export async function promoteDirectory(root: string, live: string, staging: string,
  backup: string, options: SwapOptions = {}): Promise<void> {
  for (const path of [live, staging, backup]) { assertWithin(root, path); await assertNoSymlink(path); }
  const paths = [live, staging, backup].map((path) => resolve(path));
  if (new Set(paths).size !== 3 || paths.some((a) => paths.some((b) =>
    a !== b && !relative(a, b).startsWith(`..${sep}`) && relative(a, b) !== ".."))) {
    throw new Error("Overlapping promotion paths");
  }
  try { await lstat(backup); throw new Error(`Backup already exists: ${backup}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const devices = await Promise.all([live, staging, dirname(backup)].map(path => lstat(path).then(info => info.dev)));
  if (new Set(devices).size !== 1) throw new Error("Cross-device promotion deferred; original data unchanged");
  const move = options.rename ?? rename;
  await move(live, backup);
  try { await move(staging, live); }
  catch (error) {
    try { await move(backup, live); }
    catch (restoreError) {
      throw new Error(`Publication and restoration failed; preserve backup ${backup} and staging ${staging}: ${String(error)}; ${String(restoreError)}`);
    }
    throw new Error(`Publication failed; original restored: ${String(error)}`);
  }
  await syncDirectory(dirname(live));
}

/** Linux-only Code Graph guard for pre-refactor clients without our leases.
 * Inspect only same-user process metadata; never expose environment contents.
 * Registered new clients additionally use activation locks and birth-identity leases.
 */
export async function managedCacheUsers(cache: string): Promise<number[]> {
  if (process.platform !== "linux") throw new Error("Cannot establish Linux Code Graph writer quiescence");
  const target = resolve(cache);
  const users = new Set<number>();
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    const directory = `/proc/${name}`;
    try {
      const info = await lstat(directory);
      if (process.getuid && info.uid !== process.getuid()) continue;
      const argv = (await readFile(join(directory, "cmdline"), "utf8")).split("\0");
      const isCbm = argv.some((arg) => arg.endsWith("/codebase-memory-mcp") || arg === "--cbm-daemon-internal");
      // Arbitrary unrelated processes are not managed store consumers. Some are
      // intentionally non-dumpable; their private FDs must not be inspected.
      if (!isCbm) continue;
      {
        const environment = (await readFile(join(directory, "environ"), "utf8")).split("\0");
        const configured = environment.find((entry) => entry.startsWith("CBM_CACHE_DIR="))?.slice(14);
        if (configured) {
          const configuredRoot = await realpath(configured).catch(() => resolve(configured));
          if (configuredRoot === target) users.add(Number(name));
          // CBM binds a single cache per daemon domain. Do not inspect FDs of
          // unrelated workspaces (including processes concurrently exiting).
          continue;
        }
      }
      // Catch CBM database handles even when its cache env uses a path alias.
      for (const fd of await readdir(join(directory, "fd"))) {
        try {
          const path = await readlink(join(directory, "fd", fd));
          if (path === target || path.startsWith(`${target}${sep}`)) users.add(Number(name));
        } catch (error) {
          if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        }
      }
    } catch (error) {
      const current = await processBirth(Number(name));
      if (!current || current.startsWith("linux-dead:")) continue;
      if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        throw new Error(`Cannot establish writer quiescence for PID ${name}: ${(error as Error).message}`);
      }
    }
  }
  return [...users];
}
