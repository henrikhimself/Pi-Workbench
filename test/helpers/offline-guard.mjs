/** Enforced in every offline test worker. A swallowed fail-open error still fails exit. */
import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename, delimiter, join, isAbsolute } from "node:path";
import { readFileSync, statSync } from "node:fs";
const require = createRequire(import.meta.url), violations = [];
function deny(reason) { violations.push(reason); throw new Error(`Offline policy violation: ${reason}`); }
process.once("exit", () => { if (violations.length) { process.stderr.write(`Offline policy violation(s): ${[...new Set(violations)].join(", ")}\n`); process.exitCode = 1; } });
function endpoint(host, port) {
  host = String(host ?? "localhost").replace(/^\[|\]$/g, "");
  if (!["localhost", "127.0.0.1", "::1"].includes(host) || !Number.isInteger(Number(port)) || Number(port) < 32768) deny(`network ${host}:${String(port)}`);
}
function urlEndpoint(input) { const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url); endpoint(url.hostname, url.port || (url.protocol === "https:" ? 443 : 80)); }
const dns = require("node:dns");
for (const method of ["lookup", "resolve", "resolve4", "resolve6"]) {
  const original = dns[method]; dns[method] = function(host, ...args) {
    if (!["localhost", "127.0.0.1", "::1"].includes(host)) deny(`DNS ${String(host)}`);
    return original.call(this, host, ...args);
  };
}
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => { urlEndpoint(input); return originalFetch(input, options); };
for (const name of ["http", "https"]) {
  const api = require(`node:${name}`);
  for (const method of ["request", "get"]) {
    const original = api[method]; api[method] = function(input, ...rest) {
      if (typeof input === "string" || input instanceof URL) urlEndpoint(input);
      else endpoint(input.hostname ?? input.host, input.port ?? (name === "https" ? 443 : 80));
      return original.call(this, input, ...rest);
    };
  }
}
for (const [name, methods] of [["net", ["connect", "createConnection"]], ["tls", ["connect"]]]) {
  const api = require(`node:${name}`);
  for (const method of methods) {
    const original = api[method]; api[method] = function(...args) {
      const first = args[0];
      if (typeof first === "object" && first.path) deny("unexpected Unix socket client");
      if (typeof first === "object") endpoint(first.host ?? first.servername, first.port);
      else endpoint(typeof args[1] === "string" ? args[1] : "localhost", first);
      return original.apply(this, args);
    };
  }
}
function resolved(command, options) {
  if (isAbsolute(command)) return command;
  for (const dir of String(options?.env?.PATH ?? process.env.PATH ?? "").split(delimiter)) { const path = join(dir, command); try { if (statSync(path).isFile()) return path; } catch {} }
  return command;
}
function checkCommand(command, args = [], options = {}) {
  const name = basename(String(command)).toLowerCase(), text = args.join(" ");
  if (name === "curl") {
    const path = resolved(command, options);
    try { if (statSync(path).size < 100 && readFileSync(path, "utf8") === "#!/bin/sh\nexit 3\n") return; } catch {}
    deny("curl network client");
  }
  if (["wget", "pip", "pip3", "uv", "npm", "npx", "yarn", "pnpm", "bash", "sh", "zsh"].includes(name)) deny(`unexpected installer/shell ${name}`);
  if (name === "git" && args.some(arg => ["clone", "fetch", "pull", "push", "ls-remote"].includes(arg))) deny("Git network operation");
  if (/python(?:3(?:[.][0-9]+)?)?(?:[.]exe)?$/.test(name)) {
    if (args[0] === "-m" && /^(pip|venv|headroom)([.]|$)/.test(args[1] ?? "")) deny("Python package/service operation");
    if (args[0] === "-c" && /(?:import|from) +(headroom|urllib|requests|socket)([ .;,]|$)/.test(args[1] ?? "")) deny("Python network/backend operation");
  }
  if (name === "codebase-memory-mcp") {
    const path = resolved(command, options);
    try { if (readFileSync(path).subarray(0, 2).toString() !== "#!") deny("real Code Graph ELF execution"); } catch (error) { if (error.message.startsWith("Offline policy")) throw error; }
  }
  for (const arg of args) {
    if (typeof arg !== "string" || !arg.startsWith("{")) continue;
    try { const spec = JSON.parse(arg); if (spec.schema === 1 && typeof spec.command === "string") checkCommand(spec.command, spec.args, options); }
    catch (error) { if (error.message.startsWith("Offline policy")) throw error; }
  }
}
const child = require("node:child_process");
for (const method of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync"]) {
  const original = child[method]; child[method] = function(command, ...rest) {
    if (method === "exec" || method === "execSync") deny("unexpected shell execution");
    const args = Array.isArray(rest[0]) ? rest[0] : [];
    const options = (Array.isArray(rest[0]) ? rest[1] : rest[0]) ?? {};
    checkCommand(command, args, options); return original.call(this, command, ...rest);
  };
  const custom = Symbol.for("nodejs.util.promisify.custom");
  if (original[custom]) child[method][custom] = function(command, args = [], options = {}) {
    checkCommand(command, args, options); return original[custom].call(this, command, args, options);
  };
}
syncBuiltinESMExports();
