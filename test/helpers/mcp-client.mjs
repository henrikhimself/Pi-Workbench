/** Bounded, strict JSONL stdio client for opt-in runtime acceptance. */
import { spawn } from "node:child_process";
export class FixtureMcpClient {
  constructor(config, timeoutMs = 60000) {
    this.timeoutMs = timeoutMs; this.pending = new Map(); this.nextId = 1; this.stderr = ""; this.buffer = ""; this.closed = false; this.exitCode = null; this.protocolError = null;
    this.child = spawn(config.command, config.args ?? [], { cwd: config.cwd, env: config.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdin.on("error", () => {});
    this.child.stderr.on("data", data => { this.stderr = (this.stderr + data).slice(-8000); });
    this.child.stdout.on("data", data => {
      this.buffer += data;
      if (this.buffer.length > 4 * 1024 * 1024) { this.protocolError = new Error("MCP stdout limit exceeded"); return this.fail(this.protocolError); }
      let newline;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let response;
        try { response = JSON.parse(line); if (response.jsonrpc !== "2.0") throw new Error("Not JSON-RPC"); }
        catch { this.protocolError = new Error("Non-protocol MCP stdout"); this.fail(this.protocolError); continue; }
        const waiting = this.pending.get(response.id);
        if (!waiting) continue;
        this.pending.delete(response.id); clearTimeout(waiting.timer);
        if (response.error) waiting.reject(new Error(JSON.stringify(response.error))); else waiting.resolve(response.result);
      }
    });
    this.child.on("error", error => { this.protocolError = error; this.fail(error); });
    this.finished = new Promise(resolve => this.child.once("close", code => {
      this.closed = true; this.exitCode = code;
      if (this.buffer.trim()) this.protocolError = new Error("Truncated MCP stdout frame");
      this.fail(new Error(`MCP exited ${code}: ${this.stderr}`)); resolve(code);
    }));
  }
  fail(error) { for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(error); } this.pending.clear(); }
  call(method, params = {}) {
    if (this.protocolError) return Promise.reject(this.protocolError);
    if (this.closed) return Promise.reject(new Error("MCP client is closed"));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP timeout: ${method}: ${this.stderr}`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async initialize() {
    const result = await this.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "workbench-acceptance", version: "1" } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return result;
  }
  async tool(name, args) {
    const result = await this.call("tools/call", { name, arguments: args });
    if (result.isError) throw new Error(JSON.stringify(result.content));
    return result;
  }
  async close({ allowFailure = false } = {}) {
    if (!this.closed) {
    this.child.stdin.end();
    const terminate = setTimeout(() => this.child.kill("SIGTERM"), 10000);
    const kill = setTimeout(() => this.child.kill("SIGKILL"), 15000);
    try { await this.finished; } finally { clearTimeout(terminate); clearTimeout(kill); }
    }
    if (!allowFailure && (this.protocolError || this.exitCode !== 0)) throw this.protocolError ?? new Error(`MCP exited ${this.exitCode}: ${this.stderr}`);
  }
}
