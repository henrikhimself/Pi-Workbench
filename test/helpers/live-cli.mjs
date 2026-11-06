/** Real CLI process/PTY gates; no router control endpoints or default provider. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { RpcClient } from "@earendil-works/pi-coding-agent";
const cliPath = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
export async function cliAcceptance({ cwd, extension, modelId, loaded, wait, search }) {
  const checks = [];
  const inspection = fileURLToPath(new URL("./live-inspect.ts", import.meta.url));
  const common = ["--no-session", "--no-extensions", "-e", "builtin:mcp", "-e", extension, "-e", inspection, "--thinking", "off", "--no-builtin-tools"];
  const rpc = new RpcClient({ cliPath, cwd, provider: "llama.cpp", model: modelId, args: common });
  const events = []; rpc.onEvent(event => events.push(event));
  try {
    await rpc.start();
    const state = await rpc.getState(); assert.equal(state.model.provider, "llama.cpp"); assert.equal(state.model.id, modelId);
    await rpc.setAutoRetry(false); await rpc.setAutoCompaction(false);
    const commands = await rpc.getCommands(); assert.ok(commands.some(command => command.name === "wb:headroom-memory"));
    assert.ok(commands.some(command => command.name === "mcp"), "explicit builtin:mcp must load despite --no-extensions");
    await wait(() => events.some(event => event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === "headroom-memory" && event.statusText?.includes("✓")), "RPC Memory readiness");
    await wait(async () => {
      const start = events.length; await rpc.prompt("/wb-live-inspect");
      return events.slice(start).some(event => event.type === "extension_ui_request" && event.method === "notify" && event.message.startsWith("{") && JSON.parse(event.message).liveActiveTools?.includes(search));
    }, "actual CLI direct MCP tools, not merely registration intent");
    await loaded();
    const turn = await rpc.promptAndWait(`Call ${search} with query "violet_978163 Workbench live fixture" and top_k 1, then reply with retrieved sentinel. Use no other tool. Synthetic acceptance data.`, undefined, 90000);
    if (!turn.some(event => event.type === "tool_execution_start" && event.toolName === search)) {
      console.error(JSON.stringify({ eventTypes: turn.map(event => event.type), last: await rpc.getLastAssistantText() }).replaceAll(process.env.LLAMA_API_KEY, "[REDACTED]"));
    }
    assert.ok(turn.some(event => event.type === "tool_execution_start" && event.toolName === search), "real CLI model must call direct MCP tool");
    assert.match(await rpc.getLastAssistantText(), /violet_978163/);
    const messages = await rpc.getMessages();
    assert.ok(messages.filter(message => message.role === "assistant").every(message => !["error", "aborted", "length"].includes(message.stopReason)));
    await rpc.prompt("/wb:headroom-memory off --confirm-delete");
    await wait(() => events.some(event => event.type === "extension_ui_request" && event.method === "notify" && event.message === "Could not delete Headroom Memory: Memory store busy in another/closing session; operation deferred"), "RPC direct Memory removal with busy-store protection", 5000);
    await wait(async () => {
      const start = events.length; await rpc.prompt("/wb-live-inspect");
      return events.slice(start).some(event => event.type === "extension_ui_request" && event.method === "notify" && event.message.startsWith("{") && !JSON.parse(event.message).liveActiveTools?.includes(search));
    }, "actual CLI direct Memory removal");
    assert.ok(!events.some(event => event.type === "extension_ui_request" && event.method === "confirm"), "no upgrade approval prompt");
    checks.push("separate real RPC Pi process completes exact local-model direct MCP turn and Memory off command");
  } finally { await rpc.stop(); }
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = "stty cols 120 rows 40; exec " + [process.execPath, cliPath, "--provider", "llama.cpp", "--model", modelId, ...common].map(quote).join(" ");
  const terminal = spawn("script", ["-q", "-e", "-c", command, "/dev/null"], { cwd, env: { ...process.env, TERM: "xterm-256color" }, stdio: ["pipe", "pipe", "pipe"] });
  let raw = "", errors = "", exited = false;
  const exit = new Promise(resolve => terminal.once("exit", (code, signal) => { exited = true; resolve({ code, signal }); }));
  terminal.stdout.on("data", data => { raw = (raw + data).slice(-600000); });
  terminal.stderr.on("data", data => { errors = (errors + data).slice(-20000); });
  terminal.stdin.on("error", () => {});
  const text = () => stripVTControlCharacters(raw);
  try {
    await wait(() => text().includes(modelId) && /✓ Headroom(?! Memory)/.test(text()), "interactive real PTY owned proxy readiness", 30000);
    terminal.stdin.write("/wb:headroom-health\r");
    await wait(() => text().includes("online (managed)"), "interactive owned health command", 20000);
    terminal.stdin.write("/wb:study-mode on\r");
    await wait(() => text().includes("Study Mode enabled."), "interactive Study Mode on", 10000);
    terminal.stdin.write("/wb:study-mode off\r");
    await wait(() => text().includes("Study Mode disabled."), "interactive Study Mode off", 10000);
    terminal.stdin.write("\x04");
    await wait(() => exited, "interactive graceful exit", 15000);
    assert.equal((await exit).code, 0, errors);
    checks.push("real interactive PTY startup, managed health, branch Study Mode on/off and graceful exit without inference");
  } catch (error) { console.error(JSON.stringify({ terminalTail: text().slice(-8000), errors })); throw error; }
  finally { if (!exited) { terminal.kill("SIGTERM"); await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 3000))]); } }
  return checks;
}
