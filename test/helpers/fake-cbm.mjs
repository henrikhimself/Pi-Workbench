/** Realistic offline v0.12.1 CLI/MCP fixture. Never invokes an installer. */
export const fakeCbmTools = [
  "index_repository", "search_graph", "query_graph", "trace_path", "get_code_snippet",
  "get_file_outline", "get_graph_schema", "compare_graphs", "get_architecture", "search_code",
  "list_projects", "delete_project", "index_status", "check_index_coverage", "detect_changes",
  "manage_adr", "ingest_traces",
];
export function fakeCbmSource(config = {}) {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const CONFIG = ${JSON.stringify(config)};
const TOOL_NAMES = ${JSON.stringify(fakeCbmTools)};
const argv = process.argv.slice(2);
const args = argv[0] === "--ui=false" ? [] : argv.filter(x => x !== "--quiet");
const cacheDir = process.env.CBM_CACHE_DIR || "";
const option = name => args[args.indexOf(name) + 1];
const log = name => { if (CONFIG.callLog) fs.appendFileSync(CONFIG.callLog, name + "\\n"); };
if (args.length > 0) {
  if (args[0] === "--version") {
    console.log("codebase-memory-mcp " + (CONFIG.version || "0.12.1")); process.exit(0);
  }
  const dbPath = path.join(cacheDir, "_config.db");
  if (args[0] === "config") {
    if (args[1] === "set" && args[2] === "auto_index") {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(dbPath, "auto_index = " + args[3] + "\\n"); console.log(args[3]); process.exit(0);
    }
    if (args[1] === "get" && args[2] === "auto_index") {
      log("config-get"); const raw = fs.existsSync(dbPath) ? fs.readFileSync(dbPath, "utf8") : "";
      const match = raw.match(/auto_index = (\\S+)/); console.log(match ? match[1] : "false"); process.exit(0);
    }
  }
  if (args[0] === "cli") {
    if (args[1] === "index_repository") {
      log("index-repository");
      if (CONFIG.failIndex) { console.error("simulated index failure"); process.exit(7); }
      if (!args.includes("--repo-path")) { console.error("explicit repo flag required"); process.exit(2); }
      const root = option("--repo-path");
      const projectName = String(root).replace(/^\\//, "").replace(/\\//g, "-");
      fs.mkdirSync(cacheDir, { recursive: true });
      const indexPath = path.join(cacheDir, projectName + ".db");
      if (CONFIG.sqliteIndex) {
        const {DatabaseSync} = require("node:sqlite");
        const db = new DatabaseSync(indexPath);
        db.exec("CREATE TABLE IF NOT EXISTS project_summaries(project TEXT PRIMARY KEY,summary TEXT NOT NULL,source_hash TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS observed_calls(project TEXT NOT NULL,caller_qn TEXT NOT NULL,callee_qn TEXT NOT NULL,label TEXT NOT NULL DEFAULT '',count INTEGER NOT NULL DEFAULT 1,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,PRIMARY KEY(project,caller_qn,callee_qn,label)); CREATE TABLE IF NOT EXISTS observed_paths(project TEXT NOT NULL,label TEXT NOT NULL DEFAULT '',path_json TEXT NOT NULL,count INTEGER NOT NULL DEFAULT 1,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,PRIMARY KEY(project,label,path_json));");
        if (CONFIG.dropAuthored) for (const table of ["project_summaries", "observed_calls", "observed_paths"]) db.exec("DELETE FROM " + table);
        db.close();
      } else fs.writeFileSync(indexPath, "INDEX");
      console.log(JSON.stringify({ project: projectName, status: "indexed", nodes: 3, edges: 2 })); process.exit(0);
    }
    if (args[1] === "list_projects") {
      log("list-projects");
      if (option("--format") !== "json") { console.error("explicit JSON required"); process.exit(2); }
      const names = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).filter(x => x.endsWith(".db") && x !== "_config.db") : [];
      const rows = CONFIG.projectRows || names.map(x => ({name:x.slice(0,-3),root_path:process.cwd()}));
      const offset = Number(option("--offset") || 0), limit = Number(option("--limit") || 50);
      console.log(JSON.stringify({projects:rows.slice(offset,offset+limit),offset,limit,total:rows.length,has_more:offset+limit<rows.length})); process.exit(0);
    }
    if (args[1] === "index_status") {
      log("index-status");
      if (option("--format") !== "json") { console.error("explicit JSON required"); process.exit(2); }
      console.log(JSON.stringify({project:option("--project"),nodes:3,edges:2,status:"ready"})); process.exit(0);
    }
  }
  console.error("fake-cbm: unknown CLI " + JSON.stringify(args)); process.exit(2);
}
if (CONFIG.killedMarker) {
  process.on("SIGTERM", () => {fs.writeFileSync(CONFIG.killedMarker,"killed");process.exit(143);});
  process.stdin.on("end", () => {fs.writeFileSync(CONFIG.killedMarker,"closed");process.exit(0);});
}
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk.toString("utf8"); let newline;
  while ((newline=buffer.indexOf("\\n"))>=0) {
    const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(!line.trim())continue;
    let message;try{message=JSON.parse(line);}catch{continue;}
    if(CONFIG.mcpHang)continue;
    if(CONFIG.noisyStdout && message.method === "initialize")process.stdout.write("NOISE not json-rpc\\n");
    const respond = result => process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:message.id,result})+"\\n");
    if(message.method === "initialize")respond({protocolVersion:CONFIG.protocol || "2024-11-05",capabilities:{},serverInfo:{name:"fake-cbm",version:CONFIG.version || "0.12.1"}});
    else if(message.method === "tools/list") {
      const names=CONFIG.toolNames || TOOL_NAMES.slice(0,CONFIG.toolCount ?? 17);
      const offset=Number(message.params?.cursor || 0), size=CONFIG.toolPageSize || names.length;
      const result={tools:names.slice(offset,offset+size).map(name=>({name,description:"fake"}))};
      if(offset+size<names.length)result.nextCursor=CONFIG.cursorLoop ? "0" : String(offset+size);
      respond(result);
    }
  }
});
`;
}
