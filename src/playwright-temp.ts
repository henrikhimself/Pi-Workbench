import childProcess, { type SpawnOptions } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inspectPlaywrightPath } from "./playwright-config.js";

/** Linux AF_UNIX names cannot use the full managed directory hierarchy.
 * MCP socket creation uses a self-owned FD alias; Chromium uses its own private
 * working directory. Both resolve to the original managed directories. No parent
 * PID aliases, global /tmp fallback, extra browser FDs, or sandbox changes.
 * Installed only inside the managed MCP child, never the Pi process.
 */
export async function installPlaywrightTempRouting(options: { root: string; directory: string; home: string; browser: string }): Promise<{ runtimeAlias: string; close(): Promise<void> }> {
  const runtime = join(options.directory, "run");
  if (process.platform !== "linux") throw new Error("Playwright short socket routing requires Linux /proc");
  await inspectPlaywrightPath(options.root, options.directory); await inspectPlaywrightPath(options.root, runtime);
  const handle = await open(runtime, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const originalSpawn = childProcess.spawn, previousRuntime = process.env.XDG_RUNTIME_DIR;
  try {
    const info = await handle.stat(), canonical = await realpath(runtime), runtimeAlias = `/proc/self/fd/${handle.fd}`;
    if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0 || canonical !== resolve(runtime) || await realpath(runtimeAlias) !== canonical) throw new Error("Playwright runtime descriptor ownership/containment mismatch");
    process.env.XDG_RUNTIME_DIR = runtimeAlias;
    const routed = function(this: unknown, command: string, args: readonly string[], supplied: SpawnOptions) {
      // Retain the handle object in this installed closure for the MCP lifetime.
      if (handle.fd < 0) throw new Error("Playwright socket routing descriptor closed");
      if (command === options.browser) {
        if (!Array.isArray(supplied.stdio) || supplied.stdio.length !== 5 || supplied.stdio[0] !== "ignore" || supplied.stdio.slice(1).some(value => value !== "pipe") || supplied.cwd !== undefined || supplied.env?.HOME !== options.home || supplied.env?.TMPDIR !== options.directory || supplied.env?.XDG_RUNTIME_DIR !== runtimeAlias) throw new Error("Unexpected pinned Chromium spawn/environment contract");
        supplied = { ...supplied, cwd: options.directory, env: { ...supplied.env, TMPDIR: "/proc/self/cwd", TMP: "/proc/self/cwd", TEMP: "/proc/self/cwd", XDG_RUNTIME_DIR: runtime } };
      }
      return originalSpawn.call(this, command, args, supplied);
    } as typeof childProcess.spawn;
    childProcess.spawn = routed; syncBuiltinESMExports();
    let closing: Promise<void> | undefined;
    return { runtimeAlias, close: () => closing ??= (async () => {
      if (childProcess.spawn === routed) { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); }
      if (process.env.XDG_RUNTIME_DIR === runtimeAlias) { if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = previousRuntime; }
      await handle.close();
    })() };
  } catch (error) { await handle.close(); throw error; }
}
