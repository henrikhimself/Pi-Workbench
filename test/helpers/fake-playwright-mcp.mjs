/** Minimal NDJSON MCP fixture. No Playwright import, package install, browser or network. */
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const tools = ["browser_navigate", "browser_snapshot", "browser_take_screenshot", "browser_evaluate", "browser_mouse_click_xy", "browser_run_code_unsafe"];
const values = new Map();
const lines = createInterface({ input: process.stdin });
let descendant, stopping = false;
const send = message => process.stdout.write(JSON.stringify(message) + "\n");

if (process.argv.includes("--spawn-browser") || process.env.WB_PLAYWRIGHT_SESSION_ID) {
  const managed = !!process.env.WB_PLAYWRIGHT_SESSION_ID;
  const configIndex = process.argv.indexOf("--config");
  const config = configIndex >= 0 ? JSON.parse(readFileSync(process.argv[configIndex + 1], "utf8")) : undefined;
  descendant = spawn(process.execPath, [fileURLToPath(new URL("./fake-playwright-browser.mjs", import.meta.url)),
    ...(managed || process.argv.includes("--ignore-browser-term") ? ["--ignore-term"] : [])], { detached: managed || process.argv.includes("--detach-browser"),
      argv0: config?.browser?.launchOptions?.executablePath ?? process.execPath, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  descendant.on("message", message => send({ jsonrpc: "2.0", method: "notifications/fixture/browser", params: message }));
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (descendant && descendant.exitCode === null && descendant.signalCode === null) {
    await new Promise(resolve => {
      const timer = setTimeout(() => descendant.kill("SIGKILL"), 250);
      descendant.once("exit", () => { clearTimeout(timer); resolve(); });
      descendant.kill("SIGTERM");
    });
  }
  process.exit(0);
}
lines.on("close", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
lines.on("line", line => {
  let request;
  try { request = JSON.parse(line); } catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Fixture parse error" } }); return; }
  if (request.id === undefined) return;
  let result;
  if (request.method === "initialize") {
    result = { protocolVersion: request.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "synthetic-playwright", version: "fixture" } };
  } else if (request.method === "tools/list") {
    result = { tools: tools.map(name => ({ name, description: "Synthetic fixture only", inputSchema: { type: "object" } })) };
  } else if (request.method === "tools/call") {
    const args = request.params?.arguments ?? {};
    if (args.fixtureSet) values.set(args.fixtureSet.key, args.fixtureSet.value);
    const text = JSON.stringify({ synthetic: true, pid: process.pid, descendant: descendant?.pid, args,
      value: args.fixtureGet ? values.get(args.fixtureGet) ?? null : null });
    result = { content: [{ type: "text", text }] };
    if (request.params?.name === "browser_take_screenshot" && !request.params?.arguments?.filename) result.content.push({ type: "image", mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==" });
  } else {
    send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Fixture method not found" } }); return;
  }
  send({ jsonrpc: "2.0", id: request.id, result });
});
