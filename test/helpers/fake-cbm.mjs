/**
 * Shared fake codebase-memory-mcp generator for code-graph tests.
 *
 * Generates a Node script that imitates the owned CBM surface:
 * `--version`, CLI (`config set/get`, `cli index_repository/list_projects/
 * index_status`), and argument-less MCP stdio JSON-RPC mode. Behavior flags
 * are baked in at generation time because owned children see a minimal
 * environment.
 */
export function fakeCbmSource(config) {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const CONFIG = ${JSON.stringify(config)};
const args = process.argv.slice(2);
const cacheDir = process.env.CBM_CACHE_DIR || "";
const log = (name) => {
  if (CONFIG.callLog) {
    try { fs.appendFileSync(CONFIG.callLog, name + "\\n"); } catch {}
  }
};
if (args.length > 0) {
  if (args[0] === "--version") {
    console.log("codebase-memory-mcp " + (CONFIG.version || "0.8.1"));
    process.exit(0);
  }
  const dbPath = path.join(cacheDir, "_config.db");
  if (args[0] === "config") {
    if (args[1] === "set" && args[2] === "auto_index") {
      fs.mkdirSync(cacheDir, { recursive: true });
      const value = args[3] === "true" ? "true" : "false";
      fs.writeFileSync(dbPath, "auto_index = " + value + "\\n");
      console.log("auto_index = " + value);
      process.exit(0);
    }
    if (args[1] === "get" && args[2] === "auto_index") {
      log("config-get");
      const raw = fs.existsSync(dbPath) ? fs.readFileSync(dbPath, "utf8") : "";
      const match = raw.match(/auto_index = (\\S+)/);
      console.log(match ? match[1] : "false");
      process.exit(0);
    }
  }
  if (args[0] === "cli") {
    if (args[1] === "index_repository") {
      log("index-repository");
      if (CONFIG.failIndex) {
        console.error("simulated index failure");
        process.exit(7);
      }
      const request = JSON.parse(args[2]);
      fs.mkdirSync(cacheDir, { recursive: true });
      const projectName = String(request.repo_path).replace(/^\\//, "").replace(/\\//g, "-");
      fs.writeFileSync(path.join(cacheDir, projectName + ".db"), "INDEX");
      console.log(JSON.stringify({ project: projectName, status: "indexed", nodes: 3, edges: 2 }));
      process.exit(0);
    }
    if (args[1] === "list_projects") {
      log("list-projects");
      const entries = fs.existsSync(cacheDir)
        ? fs.readdirSync(cacheDir).filter((f) => f.endsWith(".db") && f !== "_config.db")
        : [];
      console.log(JSON.stringify({ projects: entries.map((f) => f.slice(0, -3)) }));
      process.exit(0);
    }
    if (args[1] === "index_status") {
      log("index-status");
      const request = JSON.parse(args[2]);
      console.log(JSON.stringify({ project: request.project, nodes: 3, edges: 2, status: "ready" }));
      process.exit(0);
    }
  }
  console.error("fake-cbm: unknown CLI " + JSON.stringify(args));
  process.exit(2);
}
// Argument-less mode: MCP stdio JSON-RPC server.
if (CONFIG.killedMarker) {
  process.on("SIGTERM", () => {
    try { fs.writeFileSync(CONFIG.killedMarker, "killed"); } catch {}
    process.exit(143);
  });
}
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (CONFIG.mcpHang) continue;
    if (CONFIG.noisyStdout && message.method === "initialize") {
      process.stdout.write("NOISE not json-rpc\\n");
    }
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: CONFIG.protocol || "2024-11-05",
          capabilities: {},
          serverInfo: { name: "fake-cbm", version: "0.10.0" },
        },
      }) + "\\n");
    } else if (message.method === "tools/list") {
      const count = CONFIG.toolCount ?? 14;
      const tools = Array.from({ length: count }, (_, i) => ({ name: "tool_" + i, description: "fake" }));
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools } }) + "\\n");
    }
  }
});
`;
}
