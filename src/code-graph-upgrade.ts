import { cp, mkdir, readdir, lstat, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { WorkbenchPaths } from "./paths.js";
import { activeConsumers, managedCacheUsers, treeBytes, ensurePrivateDirectory, requireDiskSpace, promoteDirectory, publishJson } from "./managed-lifecycle.js";
import { createCodeGraphState, writeCodeGraphStateAtomic, validateCodeGraphState, type CodeGraphProject, type CodeGraphState } from "./code-graph-config.js";
import type { InstalledBinary } from "./code-graph-installer.js";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/** User-authored state in the reviewed v0.8.1/v0.12.1 SQLite contract.
 * Read ONLY a quiescent staging copy. Never let a candidate open live old data.
 */
export async function assertCodeGraphQuiescent(project: CodeGraphProject, paths: WorkbenchPaths): Promise<void> {
  const leases = join(paths.codeGraphRuntime, "consumers", project.identifier);
  if ((await activeConsumers(leases)).length || (await managedCacheUsers(project.directory)).length) {
    throw new Error("Active workspace consumers; automatic upgrade/deletion deferred until they close");
  }
}

/** Caller holds the same activation lock used by all new registrations. */
export async function stageCodeGraphUpgrade(options: {
  project: CodeGraphProject; paths: WorkbenchPaths; state: CodeGraphState; binary: InstalledBinary;
  validate: (stage: CodeGraphProject) => Promise<void>;
  signal?: AbortSignal;
  promote?: typeof promoteDirectory;
}): Promise<string> {
  const { project, paths, state, binary } = options;
  options.signal?.throwIfAborted();
  if (state.version !== "v0.8.1" || binary.version !== "v0.12.1") throw new Error("No reviewed adapter for this backend/data pair; manual downgrade requires paired backend and data");
  await assertCodeGraphQuiescent(project, paths);
  await requireDiskSpace(paths.codeGraphProjects, (await treeBytes(project.directory)) * 3 + 64 * 1024 * 1024);
  const token = randomUUID();
  const identifier = `${project.identifier}-stage-${token}`;
  const stage = { ...project, identifier, directory: join(paths.codeGraphProjects, identifier),
    statePath: join(paths.codeGraphProjects, identifier, "state.json") };
  const backupRoot = join(paths.codeGraphRuntime, "backups");
  await ensurePrivateDirectory(paths.codeGraphRuntime, backupRoot);
  const backup = join(backupRoot, `${project.identifier}.backup-${token}`);
  await ensurePrivateDirectory(stage.directory);
  const coordination = join(paths.codeGraphRuntime, "coordination");
  const pending = join(coordination, `${project.identifier}.pending.json`);
  let publishing = false;
  try {
    await cp(project.directory, stage.directory, { recursive: true, dereference: false, force: false });
    await assertCodeGraphQuiescent(project, paths);
    const authored = await captureAuthoredData(stage.directory);
    await options.validate(stage);
    const deadline = Date.now() + 10_000;
    while ((await managedCacheUsers(stage.directory)).length) {
      if (Date.now() >= deadline) throw new Error("Staging daemon has not drained; publication deferred");
      await new Promise((done) => setTimeout(done, 100));
    }
    await restoreAuthoredData(stage.directory, authored);
    await writeCodeGraphStateAtomic(stage, { ...createCodeGraphState(project, binary), createdAt: state.createdAt });
    await assertCodeGraphQuiescent(project, paths);
    options.signal?.throwIfAborted();
    await publishJson(coordination, pending, { schema: 1, workspace: project.projectPath,
      live: project.directory, staging: stage.directory, backup, from: state.version, to: binary.version });
    publishing = true;
    await (options.promote ?? promoteDirectory)(paths.codeGraphRoot, project.directory, stage.directory, backup);
    await rm(pending);
    return backup;
  } catch (error) {
    // Clear only a caught, completely restored failed swap. An interrupted or
    // uncertain publication remains blocked with explicit recovery identities.
    const restored = validateCodeGraphState(project);
    if (publishing && restored.ok && restored.state.version === state.version &&
        restored.state.sha256 === state.sha256 && !await lstat(backup).then(() => true, () => false)) {
      await rm(pending, { force: true });
    }
    // Keep staging, original and any backup for explicit recovery; never run old binary.
    throw new Error(`Automatic upgrade deferred: ${String(error)}. Retained staging: ${stage.directory}; backup: ${backup}`);
  }
}

const AUTHORED_TABLES = ["project_summaries", "observed_calls", "observed_paths"] as const;
interface TableSnapshot { table: string; columns: string[]; rows: SQLInputValue[][] }
export interface AuthoredSnapshot { file: string; tables: TableSnapshot[] }
function quote(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) throw new Error("Unsafe authored-data column");
  return `"${identifier}"`;
}
function columns(db: DatabaseSync, table: string): string[] {
  return db.prepare(`PRAGMA table_info(${quote(table)})`).all().map((row) => String(row.name));
}
export function authoredFingerprint(snapshot: AuthoredSnapshot[]): string {
  return JSON.stringify(snapshot, (_key, value) => typeof value === "bigint" ? { bigint: String(value) }
    : value instanceof Uint8Array ? { bytes: [...value] } : value);
}
export async function captureAuthoredData(directory: string): Promise<AuthoredSnapshot[]> {
  const result: AuthoredSnapshot[] = [];
  for (const file of (await readdir(directory)).filter((name) => name.endsWith(".db") && name !== "_config.db").sort()) {
    const path = join(directory, file);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe graph database: ${file}`);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec("PRAGMA query_only=ON");
      const tables: TableSnapshot[] = [];
      for (const table of AUTHORED_TABLES) {
        const names = columns(db, table);
        if (names.length === 0) continue;
        const statement = db.prepare(`SELECT * FROM ${quote(table)} ORDER BY ${names.map(quote).join(",")}`);
        statement.setReadBigInts(true);
        const rows = statement.all().map((row) => names.map((name) => row[name] as SQLInputValue));
        tables.push({ table, columns: names, rows });
      }
      result.push({ file, tables });
    } finally { db.close(); }
  }
  return result;
}

/** Full rebuilds preserve ADR content but may reset metadata or observations.
 * Restore the copied authored rows explicitly against the verified target schema.
 */
export async function restoreAuthoredData(directory: string, snapshot: AuthoredSnapshot[]): Promise<void> {
  for (const source of snapshot) {
    const path = join(directory, source.file);
    if (!(await lstat(path)).isFile()) throw new Error(`Missing rebuilt graph database: ${source.file}`);
    const db = new DatabaseSync(path);
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const table of source.tables) {
          const targetColumns = columns(db, table.table);
          if (table.columns.some((column) => !targetColumns.includes(column))) {
            throw new Error(`Unsupported authored-data schema change: ${source.file}/${table.table}`);
          }
          db.exec(`DELETE FROM ${quote(table.table)}`);
          const statement = db.prepare(`INSERT INTO ${quote(table.table)} (${table.columns.map(quote).join(",")}) VALUES (${table.columns.map(() => "?").join(",")})`);
          for (const row of table.rows) statement.run(...row);
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally { db.close(); }
  }
  const restored = await captureAuthoredData(directory);
  // New target tables are allowed, but every source row/column must survive.
  for (const source of snapshot) {
    const target = restored.find((entry) => entry.file === source.file);
    if (!target) throw new Error(`Authored database disappeared: ${source.file}`);
    const projected: AuthoredSnapshot = { file: source.file, tables: [] };
    for (const table of source.tables) {
      const found = target.tables.find((entry) => entry.table === table.table);
      if (!found) throw new Error(`Authored table disappeared: ${table.table}`);
      projected.tables.push({ table: table.table, columns: table.columns,
        rows: found.rows.map((row) => table.columns.map((name) => row[found.columns.indexOf(name)])) });
    }
    if (authoredFingerprint([projected]) !== authoredFingerprint([source])) throw new Error("Authored-data preservation validation failed");
  }
}
