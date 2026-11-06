import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureMcpClient } from "./helpers/mcp-client.mjs";
for (const [label, trailer, code, error] of [
  ["nonzero backend exit", "", 7, /MCP exited 7/],
  ["trailing protocol garbage", "garbage" + String.fromCharCode(10), 0, /Non-protocol/],
  ["truncated frame", "{", 0, /Truncated/],
]) test("runtime client rejects " + label, async () => {
  const root = await mkdtemp(join(tmpdir(), "wb-mcp-client-negative-"));
  const file = join(root, "fixture.mjs");
  await writeFile(file, `process.stdin.once("data", data => {
    const request = JSON.parse(String(data).trim().split("\\n")[0]);
    process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result:{protocolVersion:"2024-11-05"}})+"\\n");
    process.stdin.once("end", () => { process.stdout.write(${JSON.stringify(trailer)}); process.exitCode = ${code}; });
    process.stdin.resume();
  });`);
  const client = new FixtureMcpClient({ command: process.execPath, args: [file], cwd: root, env: process.env }, 3000);
  try { await client.initialize(); await assert.rejects(client.close(), error); }
  finally { await client.close({ allowFailure: true }); await rm(root, { recursive: true, force: true }); }
});
