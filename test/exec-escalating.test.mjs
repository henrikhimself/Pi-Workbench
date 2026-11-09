/** L8: timeouts and aborts escalate SIGTERM to SIGKILL; a failed tar write kills tar. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { execWithKillEscalation, defaultProcessRunner, KILL_GRACE_MS } = await jiti.import("../src/exec-escalating.ts");
const { extractCodeGraphArchive } = await jiti.import("../src/code-graph-installer.ts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const stubborn = `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);`;
async function waitFor(condition, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await condition()) return true; await sleep(20); }
  return false;
}

test("grace period is shorter than typical lock waits", () => assert.ok(KILL_GRACE_MS >= 1000 && KILL_GRACE_MS <= 5000));

test("a child that ignores SIGTERM is SIGKILLed after the grace period on timeout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wb-escalate-")); const pidFile = join(dir, "pid");
  try {
    const started = Date.now();
    const result = await execWithKillEscalation(process.execPath, ["-e", stubborn, pidFile], { timeoutMs: 300, killGraceMs: 300 });
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.notEqual(result.code, 0);
    assert.ok(Date.now() - started < 3000, "returned without waiting for the child to exit by itself");
    assert.equal(await waitFor(() => !alive(pid)), true, "child is gone");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an abort escalates the same way, and an already-aborted signal does not run the child to completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wb-escalate-")); const pidFile = join(dir, "pid");
  try {
    const controller = new AbortController();
    const run = execWithKillEscalation(process.execPath, ["-e", stubborn, pidFile], { signal: controller.signal, killGraceMs: 300 });
    assert.equal(await waitFor(() => readFile(pidFile, "utf8").then(Boolean, () => false)), true);
    const pid = Number(await readFile(pidFile, "utf8"));
    controller.abort();
    assert.notEqual((await run).code, 0);
    assert.equal(await waitFor(() => !alive(pid)), true);
    const aborted = AbortSignal.abort();
    const early = await execWithKillEscalation(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { signal: aborted, killGraceMs: 200 });
    assert.notEqual(early.code, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("well-behaved children keep their output and exit code", async () => {
  const ok = await execWithKillEscalation(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err')"], { timeoutMs: 5000 });
  assert.deepEqual(ok, { code: 0, stdout: "out", stderr: "err" });
  const bad = await execWithKillEscalation(process.execPath, ["-e", "process.exit(3)"], { timeoutMs: 5000 });
  assert.equal(bad.code, 3);
  const missing = await execWithKillEscalation("/nonexistent/command", [], { timeoutMs: 5000 });
  assert.notEqual(missing.code, 0);
});

test("the shared default process runner uses the escalation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wb-escalate-")); const pidFile = join(dir, "pid");
  try {
    const result = await defaultProcessRunner()(process.execPath, ["-e", stubborn, pidFile], { env: process.env, cwd: dir, timeoutMs: 300, killGraceMs: 300 });
    assert.notEqual(result.code, 0);
    assert.equal(await waitFor(() => !alive(Number(require_(pidFile)))), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
function require_(path) { return fsSyncRead(path); }
import { readFileSync as fsSyncRead } from "node:fs";

const LIMIT_THEN_EXEC = "import os, resource, sys; resource.setrlimit(resource.RLIMIT_FSIZE, (512, 512)); os.execv(sys.argv[1], sys.argv[1:])";

test("a failed extraction write kills tar instead of leaving it blocked on a paused pipe", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "wb-tar-kill-")); const pidFile = join(dir, "tar.pid");
  let pid;
  try {
    const fakeTar = join(dir, "tar");
    // Prints two 4 KiB bursts (the first write is only partly accepted, the second hits the limit), then blocks like a tar whose stdout nobody reads.
    await writeFile(fakeTar, `#!/bin/sh\necho $$ > '${pidFile}'\nhead -c 4096 /dev/zero\nsleep 0.3\nhead -c 4096 /dev/zero\nexec sleep 60\n`); await chmod(fakeTar, 0o755);
    // A real write failure: the extraction runs in a child with a 512-byte file size limit (EFBIG).
    // (python3 sets the limit; the offline guard forbids spawning a shell in tests.)
    const body = `
      import { createJiti } from "jiti";
      process.on("SIGXFSZ", () => {});
      const jiti = createJiti(process.cwd() + "/x.mjs", { fsCache: false });
      const { extractCodeGraphArchive } = await jiti.import("./src/code-graph-installer.ts");
      try { await extractCodeGraphArchive(${JSON.stringify(join(dir, "a.tar.gz"))}, ${JSON.stringify(join(dir, "staging"))}, ${JSON.stringify(fakeTar)}); console.log("RESOLVED"); }
      catch (error) { console.log("REJECTED " + error.code); }
    `;
    const result = await execWithKillEscalation("python3", ["-c", LIMIT_THEN_EXEC, process.execPath, "--input-type=module", "-e", body], { cwd: process.cwd(), env: process.env, timeoutMs: 20000 });
    assert.match(result.stdout, /REJECTED EFBIG/, `${result.stdout} ${result.stderr}`);
    pid = Number(fsSyncRead(pidFile, "utf8"));
    assert.equal(await waitFor(() => !alive(pid), 3000), true, "tar was killed after the write failed");
  } finally {
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});
