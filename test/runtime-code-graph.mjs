/** Explicit opt-in: actual pinned installer/manager, synthetic data, private roots. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, cp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";
import { graphQns } from "./helpers/graph-qns.mjs";
import { treeFingerprint } from "./helpers/tree-fingerprint.mjs";
import { FixtureMcpClient } from "./helpers/mcp-client.mjs";
if (process.env.WORKBENCH_RUNTIME_TESTS !== "1") throw new Error("Set WORKBENCH_RUNTIME_TESTS=1 to authorize isolated native runtime installation");
if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) throw new Error("Native Linux AMD64/ARM64 required; do not run ELF on macOS");
const run = promisify(execFile), jiti = createJiti(import.meta.url);
const { resolveWorkbenchPaths } = await jiti.import("../src/paths.ts");
const { CodeGraphInstaller } = await jiti.import("../src/code-graph-installer.ts");
const { CodeGraphManager } = await jiti.import("../src/code-graph-manager.ts");
const { resolveCodeGraphProject } = await jiti.import("../src/code-graph-config.ts");
const { authoredFingerprint, captureAuthoredData } = await jiti.import("../src/code-graph-upgrade.ts");
const { activeConsumers, managedCacheUsers, promoteDirectory } = await jiti.import("../src/managed-lifecycle.ts");
const home = await mkdtemp(join(tmpdir(), "wc-")), paths = resolveWorkbenchPaths(home);
const report = { home, platform: `${process.platform}/${process.arch}`, checks: [] }, managers = [], clients = [];
const status = message => console.error(message);
const installer = new CodeGraphInstaller({ paths });
const configs = new Map();
function manager(overrides = {}) {
  const value = new CodeGraphManager({ paths, ensureInstalled: callback => installer.ensureInstalled(callback),
    onStatus: status, registerMcp: (_name, config) => configs.set(value, config), unregisterMcp: () => {}, ...overrides });
  managers.push(value); return value;
}
async function connect(value) { const client = new FixtureMcpClient(configs.get(value)); clients.push(client); await client.initialize(); return client; }
function text(result) { return result.content?.filter(item => item.type === "text").map(item => item.text).join("\n") ?? JSON.stringify(result); }
async function drain(project) {
  const deadline = Date.now() + 15000;
  while ((await managedCacheUsers(project.directory)).length || (await activeConsumers(join(paths.codeGraphRuntime, "consumers", project.identifier))).length) {
    if (Date.now() >= deadline) throw new Error(`Owned CBM consumers failed to drain: ${project.identifier}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function workspace(name) {
  const cwd = join(home, name); await mkdir(cwd);
  await run("git", ["init", "--quiet"], { cwd });
  await writeFile(join(cwd, "fixture.ts"), ["export function fixtureSentinel(value: number): number { return value + 978163; }", "export function fixtureCallee(value: number): number { return value; }", ""].join("\n"));
  return { cwd, project: resolveCodeGraphProject(cwd, paths) };
}
try {
  const one = await workspace("a"), two = await workspace("b"), a = manager(), b = manager();
  const activated = await a.activate(one.project); assert.equal(activated.ok, true, activated.detail);
  report.binary = { path: activated.binaryPath, version: activated.state.version, sha256: activated.state.sha256 };
  const first = await connect(a), tools = await first.call("tools/list");
  assert.equal(tools.tools.length, 17);
  await writeFile(join(home, "tool-schemas.json"), JSON.stringify(tools.tools, null, 2));
  assert.match(text(await first.tool("search_graph", { project: (await a.fetchIndexSummary(one.project, activated.binaryPath)), name_pattern: "fixtureSentinel" })), /fixtureSentinel/);
  assert.equal((await b.activate(two.project)).ok, true); const second = await connect(b);
  assert.notEqual(configs.get(a).env.CBM_RUNTIME_DIR, configs.get(b).env.CBM_RUNTIME_DIR);
  assert.equal(configs.get(a).env.CBM_CACHE_DIR, one.project.directory);
  assert.match(text(await second.tool("list_projects", {})), /root_path/);
  report.checks.push("actual pinned installer, initial indexing, 17 direct MCP tools, two isolated workspace domains");
  const peer = manager(); assert.equal((await peer.restore(one.project)).ok, true); const peerClient = await connect(peer);
  await first.close(); await a.stop(one.project);
  assert.match(text(await peerClient.tool("list_projects", {})), /root_path/);
  await assert.rejects(a.removeProject(one.project), /Active workspace consumers/);
  report.checks.push("same-workspace peers survive creator release; deletion remains guarded");
  await writeFile(join(one.cwd, "fixture.ts"), ["export function watcherSentinel(): number { return watcherCallee(); }", "export function watcherCallee(): number { return 712398; }", ""].join("\n"));
  let watched = false; const watchDeadline = Date.now() + 20000;
  const projectName = await peer.fetchIndexSummary(one.project, activated.binaryPath);
  while (Date.now() < watchDeadline) {
    const result = await peerClient.tool("search_graph", { project: projectName, name_pattern: "watcherSentinel" });
    if (text(result).includes("watcherSentinel")) { watched = true; break; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(watched, true, "auto-index watcher must observe synthetic edit without manual reindex");
  report.checks.push("auto-index watcher observes edit");
  await peerClient.close(); await peer.stop(one.project); await drain(one.project);
  await second.close(); await b.stop(two.project); await drain(two.project);
  // This is a copied contract fixture, not a claim of production v0.8.1 canary coverage.
  let state;
  if (process.argv.includes("--old-fixture")) {
    const { createLegacyFixture } = await import("./helpers/legacy-cbm.mjs");
    const old = await createLegacyFixture(paths, one.cwd, status);
    await rm(one.project.directory, { recursive: true });
    await cp(old.cache, one.project.directory, { recursive: true });
    state = { ...activated.state, version: old.version, resolvedUrl: old.resolvedUrl, sha256: old.sha256 };
    report.legacy = old;
  } else {
    const index = (await readdir(one.project.directory)).find(name => name.endsWith(".db") && name !== "_config.db"); assert.ok(index);
    const db = new DatabaseSync(join(one.project.directory, index));
    await writeFile(join(home, "authored-schema.json"), JSON.stringify(Object.fromEntries(["project_summaries", "observed_calls", "observed_paths"].map(name => [name, db.prepare(`PRAGMA table_info(${name})`).all()])), null, 2));
    db.prepare("INSERT OR REPLACE INTO project_summaries(project,summary,source_hash,created_at,updated_at) VALUES (?,?,?,?,?)").run(projectName, "ADR runtime sentinel", "fixture", "2020-01-01", "2020-01-01");
    db.prepare("INSERT OR REPLACE INTO observed_calls(project,caller_qn,callee_qn,label,count,first_seen,last_seen) VALUES (?,?,?,?,?,?,?)").run(projectName, "caller", "callee", "fixture", 12, "2020-01-01", "2020-01-01");
    db.prepare("INSERT OR REPLACE INTO observed_paths(project,label,path_json,count,first_seen,last_seen) VALUES (?,?,?,?,?,?)").run(projectName, "fixture", '["caller","callee"]', 3, "2020-01-01", "2020-01-01");
    db.close();
    state = { ...activated.state, version: "v0.8.1", resolvedUrl: "https://fixture.invalid/v0.8.1", sha256: "a".repeat(64) };
  }
  await writeFile(one.project.statePath, JSON.stringify(state));
  const expected = await captureAuthoredData(one.project.directory), before = authoredFingerprint(expected);
  const physicalBefore = await treeFingerprint(one.project.directory);
  const upgrade = manager(); const upgraded = await upgrade.restore(one.project); assert.equal(upgraded.ok, true, upgraded.detail);
  const after = await captureAuthoredData(one.project.directory);
  for (const source of expected) {
    const target = after.find(item => item.file === source.file); assert.ok(target);
    const projected = { file: source.file, tables: source.tables.map(table => {
      const found = target.tables.find(item => item.table === table.table); assert.ok(found);
      return { ...table, rows: found.rows.map(row => table.columns.map(name => row[found.columns.indexOf(name)])) };
    }) };
    assert.equal(authoredFingerprint([projected]), authoredFingerprint([source]));
  }
  const backups = (await readdir(join(paths.codeGraphRuntime, "backups"))).filter(name => name.startsWith(one.project.identifier + ".backup-")); assert.equal(backups.length, 1);
  const backup = join(paths.codeGraphRuntime, "backups", backups[0]);
  assert.deepEqual(await treeFingerprint(backup), physicalBefore);
  assert.equal(authoredFingerprint(await captureAuthoredData(backup)), before);
  if (process.argv.includes("--old-fixture")) {
    const pair = join(paths.codeGraphRoot, "fixtures", "manual-pair"); await cp(backup, pair, { recursive: true });
    const { verifyManualPair } = await import("./helpers/manual-downgrade.mjs");
    report.manualDowngrade = await verifyManualPair(paths, one.cwd, pair);
  }

  const upgradedClient = await connect(upgrade);
  const found = JSON.parse(text(await upgradedClient.tool("search_graph", { project: projectName, label: "Function", format: "json" })));
  const qns = graphQns(found); assert.ok(qns.length >= 2);
  await upgradedClient.tool("ingest_traces", { project: projectName, traces: [{ path: qns.slice(0, 2), count: 12 }], label: "runtime-fixture" });
  await upgradedClient.close(); await upgrade.stop(one.project); await drain(one.project);
  const traced = await captureAuthoredData(one.project.directory);
  const observed = traced.flatMap(item => item.tables).find(table => table.table === "observed_calls");
  assert.ok(observed && observed.rows.some(row => Number(row[observed.columns.indexOf("count")]) >= 12), "new backend must persist real traces");
  report.checks.push("actual legacy ADR upgrade and full physical backup; v0.8.1 trace stub recorded, v0.12.1 traces persist");
  // Recreate only synthetic older-state metadata to exercise actual staged backend plus caught publication failure.
  const current = await readFile(one.project.statePath, "utf8"); await writeFile(one.project.statePath, JSON.stringify(state));
  const original = await readFile(one.project.statePath, "utf8"), fingerprint = authoredFingerprint(await captureAuthoredData(one.project.directory));
  const failing = manager({ promoteUpgrade: async (root, live, stage, retained) => promoteDirectory(root, live, stage, retained, { rename: async (from, to) => {
    if (from === stage) throw new Error("runtime injected publication failure");
    const { rename } = await import("node:fs/promises"); await rename(from, to);
  } }) });
  const failed = await failing.restore(one.project); assert.equal(failed.ok, false); assert.match(failed.detail, /original restored/);
  assert.equal(await readFile(one.project.statePath, "utf8"), original); assert.equal(authoredFingerprint(await captureAuthoredData(one.project.directory)), fingerprint);
  await writeFile(one.project.statePath, current);
  report.checks.push("actual staging backend survives injected publication failure with original data restored");
  if (process.argv.includes("--debian11")) {
    assert.equal(process.arch, "x64", "this external userland gate requires native AMD64");
    const image = "debian:bullseye-slim";
    const uid = (await run("docker", ["run", "--rm", "--network", "none", "-v", `${home}:/wb:ro`, image, "stat", "-c", "%u:%g", "/wb"], { timeout: 30000 })).stdout.trim();
    assert.match(uid, /^[0-9]+:[0-9]+$/);
    const imageId = (await run("docker", ["image", "inspect", image, "--format", "{{.Id}}"], { timeout: 10000 })).stdout.trim();
    const dockerBase = ["run", "--rm", "-i", "--network", "none", "--read-only", "--user", uid, "--tmpfs", "/tmp:rw,mode=1777", "-v", `${home}:${home}:rw`];
    const env = configs.get(a).env;
    for (const key of ["HOME", "CBM_CACHE_DIR", "CBM_RUNTIME_DIR", "CBM_ALLOWED_ROOT", "CBM_LOG_LEVEL"]) dockerBase.push("-e", `${key}=${env[key]}`);
    dockerBase.push("-w", one.cwd, image);
    const version = (await run("docker", [...dockerBase, activated.binaryPath, "--version"], { timeout: 30000 })).stdout;
    assert.match(version, /0\.12\.1/);
    const cli = (await run("docker", [...dockerBase, activated.binaryPath, "cli", "--quiet", "list_projects"], { timeout: 30000 })).stdout; assert.match(cli, /root_path/);
    const oldUserland = new FixtureMcpClient({ command: "docker", args: [...dockerBase, activated.binaryPath, "--quiet", "--ui=false", "--repo-path", one.cwd], env: process.env }); clients.push(oldUserland);
    await oldUserland.initialize(); assert.equal((await oldUserland.call("tools/list")).tools.length, 17); await oldUserland.close(); await drain(one.project);
    report.debian11 = { image: imageId, version: version.trim(), network: "none", scope: "same verified artifact CLI/MCP ABI gate; Node manager host gate above" };
    report.checks.push("network-disabled Debian 11/glibc 2.31 portable ELF CLI/MCP");
  }
  report.checks.push("last owned clients and daemons drain");
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const client of clients) await client.close({ allowFailure: true });
  for (const value of managers) await value.shutdown().catch(error => console.error(String(error)));
  if (process.argv.includes("--keep")) console.error(`Retained native fixture: ${home}`);
  else await rm(home, { recursive: true, force: true });
}
