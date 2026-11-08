import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { createJiti } from "jiti";
import { playwrightFixture } from "./helpers/playwright-fixture.mjs";
const m = await createJiti(import.meta.url).import("../src/playwright-process.ts");
const fake = fileURLToPath(new URL("./helpers/fake-playwright-mcp.mjs", import.meta.url));

test("Playwright command runner uses exact argv and reports bounded synthetic output", async t => {
  const f = await playwrightFixture(t);
  const result = await m.runPlaywrightCommand({ command: process.execPath, args: ["-e", 'process.stdout.write(process.argv[1]); process.stderr.write("synthetic stderr")', "literal; not shell"], cwd: f.workspace, env: f.env });
  assert.equal(result.exitCode, 0); assert.equal(result.stdout, "literal; not shell"); assert.equal(result.stderr, "synthetic stderr");
});
test("Playwright command runner cancels owned Node group without touching test process", async t => {
  const f = await playwrightFixture(t), controller = new AbortController();
  const promise = m.runPlaywrightCommand({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: f.workspace, env: f.env, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(promise, /cancelled|timed out/);
  process.kill(process.pid, 0);
});
test("Playwright command timeout escalates ignored SIGTERM with bounded cleanup", { timeout: 5000 }, async t => {
  const f = await playwrightFixture(t), start = Date.now();
  await assert.rejects(m.runPlaywrightCommand({ command: process.execPath, args: ["-e", 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'], cwd: f.workspace, env: f.env, timeoutMs: 200 }), /timed out/);
  assert.ok(Date.now() - start < 4500);
});
test("Playwright MCP client preserves text/images and closes owned synthetic descendants", async t => {
  const f = await playwrightFixture(t);
  const client = await m.PlaywrightStdioClient.connect({ command: process.execPath, args: [fake, "--spawn-browser", "--ignore-browser-term"], cwd: f.workspace, env: f.env, timeoutMs: 3000 });
  t.after(() => client.close());
  assert.ok((await client.request("tools/list")).tools.some(tool => tool.name === "browser_snapshot"));
  const response = await client.call("browser_take_screenshot"); assert.equal(response.content[1].type, "image");
  const fileOnly = await client.call("browser_take_screenshot", { filename: "synthetic-fixture.png" }); assert.equal(fileOnly.content.some(part => part.type === "image"), false);
  const pid = JSON.parse(response.content[0].text).descendant;
  assert.equal(typeof pid, "number");
  await client.close(); await client.close();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
test("Playwright MCP client cancellation closes synthetic owned group", async t => {
  const f = await playwrightFixture(t), controller = new AbortController();
  const client = await m.PlaywrightStdioClient.connect({ command: process.execPath, args: [fake], cwd: f.workspace, env: f.env, timeoutMs: 3000, signal: controller.signal });
  controller.abort(); await client.close();
  await assert.rejects(client.request("tools/list"), /closing|closed/);
});
test("Playwright group guard refuses unrelated/reused birth identity instead of killing", async () => {
  const group = await m.playwrightGroupMembers(process.pid);
  const id = group.find(item => item.pid === process.pid);
  // Test worker normally is not its group's leader, so choose an existing member's actual PGID.
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(`/proc/${process.pid}/stat`, "utf8");
  const pgid = Number(raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/)[2]);
  const guarded = new m.PlaywrightOwnedGroup(pgid, { pid: process.pid, start: "reused-pid", host: "fixture" });
  await assert.rejects(guarded.signal("SIGTERM"), /ownership uncertain/);
  process.kill(process.pid, 0);
});

test("LB-04: a response with U+2028, U+2029 or CR inside a JSON string is one message, split on LF only", async t => {
  const f = await playwrightFixture(t);
  const client = await m.PlaywrightStdioClient.connect({ command: process.execPath, args: [fake], cwd: f.workspace, env: f.env, timeoutMs: 3000 });
  t.after(() => client.close());
  const note = "before middle after\rend";
  const response = await client.call("browser_snapshot", { note });
  assert.equal(JSON.parse(response.content[0].text).args.note, note);
});

// Chunks are emitted one by one, exactly as given, so a multi-byte character can straddle two of them.
const linesOf = async chunks => {
  const lines = [], input = new EventEmitter();
  m.forEachLfLine(input, line => lines.push(line));
  for (const chunk of chunks) input.emit("data", chunk);
  input.emit("end");
  return lines;
};

test("LB-04: lines split on LF only; U+2028, U+2029 and CR stay inside the line, multi-byte text survives chunking, a last line needs no newline", async () => {
  const message = JSON.stringify({ id: 1, result: "a\u2028b\u2029c" });
  assert.deepEqual(await linesOf([Buffer.from(`${message}\n${message}\r\n{"last":true}`)]), [message, `${message}\r`, '{"last":true}']);
  const bytes = Buffer.from(`{"text":"caf\u00e9 \u{1f600}"}\n`);
  const split = bytes.indexOf(0xf0) + 2; // inside the 4-byte emoji
  assert.deepEqual(await linesOf([bytes.subarray(0, split), bytes.subarray(split)]), ['{"text":"caf\u00e9 \u{1f600}"}']);
  assert.deepEqual(await linesOf([Buffer.from('{"a":"x\ry"}\n')]), ['{"a":"x\ry"}'], "a lone CR does not split");
  assert.deepEqual(await linesOf([Buffer.from("")]), []);
});
