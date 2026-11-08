import { execFile } from "node:child_process";

export const KILL_GRACE_MS = 3_000;

export interface EscalatingExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
  /** Time between SIGTERM and SIGKILL when the child does not exit. */
  killGraceMs?: number;
}

export interface EscalatingExecResult { code: number; stdout: string; stderr: string }

/**
 * `execFile` without a shell, where a timeout or abort sends SIGTERM and then SIGKILL if the child
 * has not exited after `killGraceMs`. Plain `execFile({ timeout })` sends SIGTERM once, so a child
 * that ignores it keeps the caller (and any lock it holds) waiting forever.
 */
export function execWithKillEscalation(command: string, args: string[], options: EscalatingExecOptions): Promise<EscalatingExecResult> {
  return new Promise((resolve) => {
    const child = execFile(command, args, { cwd: options.cwd, env: options.env, maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      clearTimeout(timer); clearTimeout(grace); options.signal?.removeEventListener("abort", terminate);
      let code = 0;
      if (error) {
        const errno = (error as NodeJS.ErrnoException).code;
        code = typeof errno === "number" ? errno : 1;
      }
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
    let timer: NodeJS.Timeout | undefined, grace: NodeJS.Timeout | undefined;
    function terminate(): void {
      if (child.exitCode !== null || child.signalCode !== null || grace) return;
      child.kill("SIGTERM");
      grace = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, options.killGraceMs ?? KILL_GRACE_MS);
    }
    if (options.timeoutMs !== undefined) timer = setTimeout(terminate, options.timeoutMs);
    if (options.signal?.aborted) terminate(); else options.signal?.addEventListener("abort", terminate, { once: true });
  });
}
