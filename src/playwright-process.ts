import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { lstat, readFile, readdir } from "node:fs/promises";
import { hostname } from "node:os";
import { identityLive, processBirth, type ProcessIdentity } from "./managed-lifecycle.js";

export interface PlaywrightCommand { command: string; args: string[]; cwd: string; env: Record<string, string>; timeoutMs?: number; signal?: AbortSignal }
export interface PlaywrightCommandResult { exitCode: number; stdout: string; stderr: string }
export type PlaywrightCommandRunner = (spec: PlaywrightCommand) => Promise<PlaywrightCommandResult>;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Linux metadata only; never inspect unrelated process environments or user stores. */
export async function playwrightGroupMembers(group: number): Promise<ProcessIdentity[]> {
  if (process.platform !== "linux") throw new Error("Playwright process ownership requires Linux");
  const members: ProcessIdentity[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const directory = `/proc/${name}`, info = await lstat(directory);
      if (process.getuid && info.uid !== process.getuid()) continue;
      const raw = await readFile(`${directory}/stat`, "utf8");
      const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
      if (Number(fields[2]) === group && fields[0] !== "Z" && fields[0] !== "X" && fields[19]) members.push({ pid: Number(name), start: `linux:${fields[19]}`, host: hostname() });
    } catch (error) { if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  }
  return members;
}

/** A recorded live member anchors the process group against PGID/PID reuse. */
export class PlaywrightOwnedGroup {
  private known = new Map<number, ProcessIdentity>();
  constructor(readonly group: number, readonly owner: ProcessIdentity) { this.known.set(owner.pid, owner); }
  async capture(): Promise<ProcessIdentity[]> {
    // A snapshot can outlive its final member during normal EOF cleanup. Re-read
    // before declaring uncertainty; never adopt a nonempty unanchored group.
    for (let attempt = 0; attempt < 3; attempt++) {
      const members = await playwrightGroupMembers(this.group);
      if (!members.length) return members;
      for (const member of members) {
        const known = this.known.get(member.pid);
        if (known?.start === member.start && await identityLive(known)) {
          for (const observed of members) this.known.set(observed.pid, observed);
          return members;
        }
      }
      await delay(1);
    }
    throw new Error("Playwright process-tree ownership uncertain; preserve leases and recovery evidence");
  }
  async signal(signal: NodeJS.Signals): Promise<void> {
    if (!(await this.capture()).length) return;
    // capture attests a still-live recorded member in this group; no unrelated PID/group adoption.
    try { process.kill(-this.group, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  async waitEmpty(timeoutMs: number): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    do { if (!(await this.capture()).length) return true; await delay(20); } while (Date.now() < until);
    return false;
  }
  async stop(): Promise<void> {
    if (!(await this.capture()).length) return;
    await this.signal("SIGTERM");
    if (await this.waitEmpty(1500)) return;
    await this.signal("SIGKILL");
    if (!await this.waitEmpty(1500)) throw new Error("Playwright process tree did not quiesce; preserve ownership evidence");
  }
}

async function spawned(spec: PlaywrightCommand): Promise<{ child: ChildProcessWithoutNullStreams; group: PlaywrightOwnedGroup; closed: Promise<number> }> {
  spec.signal?.throwIfAborted();
  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {});
  const closed = new Promise<number>(resolve => child.once("close", code => resolve(code ?? 1)));
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  const pid = child.pid!, start = await processBirth(pid);
  if (!start) { child.kill("SIGKILL"); throw new Error("Cannot establish Playwright child birth identity"); }
  return { child, group: new PlaywrightOwnedGroup(pid, { pid, start, host: hostname() }), closed };
}

export const runPlaywrightCommand: PlaywrightCommandRunner = async spec => {
  const { child, group, closed: exit } = await spawned(spec);
  let stdout = "", stderr = "", interrupted = false;
  const capture = (which: "stdout" | "stderr", chunk: Buffer) => {
    if (which === "stdout") stdout = (stdout + chunk.toString()).slice(-4 * 1024 * 1024);
    else stderr = (stderr + chunk.toString()).slice(-4 * 1024 * 1024);
  };
  child.stdout.on("data", chunk => capture("stdout", chunk)); child.stderr.on("data", chunk => capture("stderr", chunk));
  let rejectInterrupted!: (error: Error) => void;
  const interruption = new Promise<never>((_, reject) => { rejectInterrupted = reject; });
  const abort = () => { interrupted = true; rejectInterrupted(new Error("Playwright operation cancelled or timed out")); };
  spec.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, spec.timeoutMs ?? 30000);
  if (spec.signal?.aborted) abort();
  child.stdin.end();
  try {
    const exitCode = await Promise.race([exit, interruption]);
    await group.stop();
    if (interrupted) throw new Error("Playwright operation cancelled or timed out");
    return { exitCode, stdout, stderr };
  } catch (error) {
    await group.stop(); // Bounded cleanup, or explicit uncertain-ownership failure; never await a refused kill forever.
    throw error;
  } finally { clearTimeout(timer); spec.signal?.removeEventListener("abort", abort); }
};

const MAX_LINE_CHARACTERS = 16 * 1024 * 1024;

/**
 * Calls `handle` for every LF-terminated line, plus a final line without a newline when the stream ends.
 * Lines are split on LF only, as the Pi RPC docs require: `node:readline` has split on other separators on some
 * runtimes, and U+2028 or U+2029 inside a JSON string must stay inside that message. A trailing CR stays in the
 * line (JSON.parse accepts it). A line longer than the limit is handed over unterminated so the caller can fail.
 */
export function forEachLfLine(input: NodeJS.ReadableStream, handle: (line: string) => void): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  input.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      handle(line);
    }
    if (buffer.length > MAX_LINE_CHARACTERS) { const oversized = buffer; buffer = ""; handle(oversized); }
  });
  input.on("end", () => {
    buffer += decoder.end();
    if (buffer) { const last = buffer; buffer = ""; handle(last); }
  });
}

export class PlaywrightStdioClient {
  private nextId = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private heartbeat: ReturnType<typeof setInterval>;
  private closing: Promise<void> | null = null;
  private exited: Promise<void>;
  private failed: Error | null = null;
  private removeAbort?: () => void;
  private constructor(private child: ChildProcessWithoutNullStreams, readonly group: PlaywrightOwnedGroup, readonly timeoutMs: number, closed: Promise<number>) {
    this.exited = closed.then(() => { clearInterval(this.heartbeat); this.fail(new Error("Playwright MCP connection closed")); });
    child.stderr.resume(); // No raw page/server output is persisted as a durable diagnostic.
    forEachLfLine(child.stdout, line => {
      try {
        if (line.length > MAX_LINE_CHARACTERS) throw new Error("Oversized Playwright MCP response");
        const response = JSON.parse(line);
        if (response.id === undefined) return;
        const pending = this.pending.get(response.id);
        if (!pending) return;
        this.pending.delete(response.id); clearTimeout(pending.timer);
        void group.capture().then(() => {
          if (response.error) pending.reject(new Error("Playwright MCP request failed")); else pending.resolve(response.result);
        }, error => pending.reject(error));
      } catch { this.fail(new Error("Invalid Playwright MCP protocol output")); }
    });
    this.heartbeat = setInterval(() => { void group.capture().catch(error => this.fail(error)); }, 100);
  }
  static async connect(spec: PlaywrightCommand): Promise<PlaywrightStdioClient> {
    const { child, group, closed } = await spawned(spec);
    const client = new PlaywrightStdioClient(child, group, spec.timeoutMs ?? 120000, closed);
    if (spec.signal) {
      const abort = () => { void client.close().catch(error => client.fail(error)); };
      spec.signal.addEventListener("abort", abort, { once: true });
      client.removeAbort = () => spec.signal?.removeEventListener("abort", abort);
      if (spec.signal.aborted) abort();
    }
    try {
      const initialized = await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pi-workbench-readiness", version: "1" } });
      if (!initialized?.serverInfo || !initialized.capabilities?.tools) throw new Error("Invalid Playwright MCP handshake");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      return client;
    } catch (error) { await client.close(); throw error; }
  }
  private fail(error: Error): void {
    this.failed ??= error;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }
  request(method: string, params: unknown = {}): Promise<any> {
    if (this.failed) return Promise.reject(this.failed);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Playwright MCP request timed out: ${method}`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async call(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const result = await this.request("tools/call", { name, arguments: args });
    if (result?.isError) throw new Error(`Playwright readiness tool failed: ${name}`, { cause: result });
    return result;
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      clearInterval(this.heartbeat); this.removeAbort?.();
      this.fail(new Error("Playwright MCP connection closing"));
      await this.group.capture();
      this.child.stdin.end();
      if (!await this.group.waitEmpty(1000)) await this.group.stop();
      await this.exited;
    })();
  }
}
