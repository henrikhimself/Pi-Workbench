import { join } from "node:path";
import { hostname } from "node:os";
import { identityLive, syncDirectory, type ProcessIdentity } from "./managed-lifecycle.js";
import { assertPlaywrightId, readPlaywrightJson, type PlaywrightSession } from "./playwright-config.js";
import { readFile, rm } from "node:fs/promises";
import { PlaywrightOwnedTree, type PlaywrightTreeScope } from "./playwright-tree.js";

export interface PlaywrightOwnership {
  schema: 1; sessionId: string; runtimeId: string; runtimeVersion: string; group: number;
  supervisor: ProcessIdentity; child: ProcessIdentity; workspaceToken: string; runtimeToken: string;
  processes?: ProcessIdentity[]; uncertain?: boolean;
}
function identity(value: any): ProcessIdentity {
  if (!value || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.start !== "string" || !value.start || value.host !== hostname()) throw new Error("Invalid Playwright process ownership witness");
  return { pid: value.pid, start: value.start, host: value.host };
}

/** Persisted PID evidence alone cannot authorize recovery signals. Reattest private
 * session/runtime tags of surviving witnesses; unrelated processes are never roots.
 */
export async function attestPlaywrightWitnesses(scope: PlaywrightTreeScope, witnesses: ProcessIdentity[]): Promise<ProcessIdentity[]> {
  const roots: ProcessIdentity[] = [];
  for (const raw of witnesses) {
    const owner = identity(raw);
    if (!await identityLive(owner)) continue;
    try {
      const entries = (await readFile(`/proc/${owner.pid}/environ`, "utf8")).split("\0");
      if (entries.includes(`WB_PLAYWRIGHT_SESSION_ID=${scope.sessionId}`) && entries.includes(`WB_PLAYWRIGHT_RUNTIME_ID=${scope.runtimeId}`)) roots.push(owner);
    } catch (error) { if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  }
  return roots;
}
export async function readPlaywrightOwnership(session: PlaywrightSession): Promise<{ record: PlaywrightOwnership; scope: PlaywrightTreeScope; roots: ProcessIdentity[] } | null> {
  const raw = await readPlaywrightJson(session.project.root, join(session.directory, "ownership.json")) as any;
  if (raw === null) return null;
  const fields = ["schema", "sessionId", "runtimeId", "runtimeVersion", "group", "supervisor", "child", "workspaceToken", "runtimeToken", "processes", "uncertain"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !fields.includes(key)) || raw.schema !== 1 || raw.sessionId !== session.id || typeof raw.runtimeVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(raw.runtimeVersion)) throw new Error("Invalid Playwright ownership record");
  assertPlaywrightId(raw.runtimeId); assertPlaywrightId(raw.workspaceToken); assertPlaywrightId(raw.runtimeToken);
  const supervisor = identity(raw.supervisor), child = identity(raw.child);
  if (raw.group !== supervisor.pid || raw.processes !== undefined && !Array.isArray(raw.processes) || raw.uncertain !== undefined && typeof raw.uncertain !== "boolean") throw new Error("Invalid Playwright ownership group/processes");
  const processes = (raw.processes ?? []).map(identity);
  const scope = { sessionId: session.id, runtimeId: raw.runtimeId, browserRoot: join(session.project.root, "runtimes", raw.runtimeVersion, raw.runtimeId, "browsers"), directory: session.directory };
  const roots = await attestPlaywrightWitnesses(scope, [supervisor, child, ...processes]);
  return { record: { ...raw, supervisor, child, processes }, scope, roots };
}

/** Retire only matching completed leases, after independently verified quiescence. */
export async function retirePlaywrightOwnership(session: PlaywrightSession, evidence: NonNullable<Awaited<ReturnType<typeof readPlaywrightOwnership>>>): Promise<void> {
  const snapshot = await new PlaywrightOwnedTree(evidence.scope, evidence.roots).capture();
  if (snapshot.processes.length || snapshot.uncertain) throw new Error("Playwright prior session runtime remains active or uncertain");
  for (const [token, resource] of [[evidence.record.workspaceToken, `workspace:${session.project.identifier}`], [evidence.record.runtimeToken, `runtime:${evidence.record.runtimeId}`]]) {
    const path = join(session.project.root, "consumers", `${token}.json`), record = await readPlaywrightJson(session.project.root, path) as any;
    if (record === null) continue;
    if (record.schema !== 1 || record.token !== token || record.resource !== resource || record.sessionId !== session.id || record.runtimeId !== evidence.record.runtimeId || record.workspace !== session.project.projectPath || record.group !== evidence.record.group) throw new Error("Playwright completed lease identity mismatch");
    const owner = identity(record);
    if (![evidence.record.child, evidence.record.supervisor].some(expected => expected.pid === owner.pid && expected.start === owner.start) || await identityLive(owner)) throw new Error("Playwright lease still live or ownership changed");
    await rm(path);
    await syncDirectory(join(session.project.root, "consumers"));
  }
}
