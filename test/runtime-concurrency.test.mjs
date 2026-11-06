import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

function peer(home, version = "0.41.0") {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./helpers/runtime-peer.mjs", import.meta.url)), home, version], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "", buffer = ""; child.stderr.on("data", chunk => { stderr += chunk; }); child.stdin.on("error", () => {});
  const closed = new Promise(resolve => child.once("close", code => resolve(code)));
  const ready = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.on("data", chunk => { buffer += chunk; if (buffer.includes("\n")) { try { resolve(JSON.parse(buffer.split("\n")[0])); } catch (error) { reject(error); } } });
    child.once("close", () => { if (!buffer.includes("\n")) reject(new Error(`peer ended without result: ${stderr}`)); });
  });
  return { child, ready, closed, async stop() { child.stdin.end(); assert.equal(await closed, 0, stderr); }, async cleanup() { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; } };
}

test("separate Pi-process installers serialize; consumers defer mixed pin then retry cached candidate", { timeout: 15000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "wb-multiprocess-runtime-")), peers = [];
  try {
    const a = peer(home), b = peer(home); peers.push(a, b);
    const [one, two] = await Promise.all([a.ready, b.ready]);
    assert.equal(one.ok, true); assert.equal(two.ok, true); assert.equal(one.slot, two.slot);
    let installs = (await readFile(join(home, "installs.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(installs.filter(row => row.version === "0.41.0").length, 1, "exactly one real lock holder builds slot");
    const blocked = peer(home, "0.42.0"); peers.push(blocked);
    const result = await blocked.ready; assert.equal(result.ok, false); assert.match(result.messages.join("\n"), /consumers still use prior selection/);
    assert.equal(await blocked.closed, 2);
    await a.stop();
    assert.equal(b.child.exitCode, null, "creator exit preserves peer");
    await b.stop();
    const retry = peer(home, "0.42.0"); peers.push(retry); assert.equal((await retry.ready).ok, true); await retry.stop();
    installs = (await readFile(join(home, "installs.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(installs.filter(row => row.version === "0.42.0").length, 1, "retry reuses validated inactive candidate");
  } finally { await Promise.all(peers.map(child => child.cleanup())); await rm(home, { recursive: true, force: true }); }
});
