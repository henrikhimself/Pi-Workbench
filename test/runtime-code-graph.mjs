/** Explicit opt-in: actual pinned installer/manager, synthetic data, private roots. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createJiti } from "jiti";
import { treeFingerprint } from "./helpers/tree-fingerprint.mjs";
import { FixtureMcpClient } from "./helpers/mcp-client.mjs";
if (process.env.WORKBENCH_RUNTIME_TESTS !== "1") throw new Error("Set WORKBENCH_RUNTIME_TESTS=1 to authorize isolated native runtime installation");
if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) throw new Error("Native Linux AMD64/ARM64 required; do not run ELF on macOS");
const run = promisify(execFile), jiti = createJiti(import.meta.url);
const { resolveWorkbenchPaths } = await jiti.import("../src/paths.ts");
const { CodeGraphInstaller } = await jiti.import("../src/code-graph-installer.ts");
const { CodeGraphManager } = await jiti.import("../src/code-graph-manager.ts");
const { resolveCodeGraphProject } = await jiti.import("../src/code-graph-config.ts");
const { activeConsumers } = await jiti.import("../src/managed-lifecycle.ts");
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
// The registered config launches the owned launcher; the CBM environment is inside its JSON spec.
const launcherEnv = value => JSON.parse(configs.get(value).args[1]).env;
async function connect(value) { const client = new FixtureMcpClient(configs.get(value)); clients.push(client); await client.initialize(); return client; }
function text(result) { return result.content?.filter(item => item.type === "text").map(item => item.text).join("\n") ?? JSON.stringify(result); }
async function drain(project) {
  const deadline = Date.now() + 15000;
  while ((await activeConsumers(join(paths.codeGraphRuntime, "consumers", project.identifier))).length) {
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
  report.binary = { path: activated.binaryPath, version: activated.identity.codeGraphVersion, sha256: activated.identity.sha256 };
  const first = await connect(a), tools = await first.call("tools/list");
  assert.equal(tools.tools.length, 17);
  await writeFile(join(home, "tool-schemas.json"), JSON.stringify(tools.tools, null, 2));
  assert.match(text(await first.tool("search_graph", { project: (await a.fetchIndexSummary(one.project, activated.binaryPath)), name_pattern: "fixtureSentinel" })), /fixtureSentinel/);
  assert.equal((await b.activate(two.project)).ok, true); const second = await connect(b);
  assert.notEqual(launcherEnv(a).CBM_RUNTIME_DIR, launcherEnv(b).CBM_RUNTIME_DIR);
  assert.equal(launcherEnv(a).CBM_CACHE_DIR, one.project.directory);
  assert.match(text(await second.tool("list_projects", {})), /root_path/);
  report.checks.push("actual pinned installer, initial indexing, 17 server tools (15 exposed to the model), two isolated workspace domains");
  const peer = manager(); assert.equal((await peer.restore(one.project)).ok, true); const peerClient = await connect(peer);
  await first.close(); await a.stop(one.project);
  assert.match(text(await peerClient.tool("list_projects", {})), /root_path/);
  await assert.rejects(a.removeProject(one.project, { timeoutMs: 0 }), /Active workspace consumers/);
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
  // Data written by another version is refused and left unchanged; `off` can still delete it.
  const originalIdentity = await readFile(one.project.identityPath, "utf8");
  await writeFile(one.project.identityPath, JSON.stringify({ ...JSON.parse(originalIdentity), codeGraphVersion: "v0.8.1", resolvedUrl: "https://fixture.invalid/v0.8.1", sha256: "a".repeat(64) }));
  const mismatchedTree = await treeFingerprint(one.project.directory);
  const refused = await manager().restore(one.project);
  assert.equal(refused.ok, false); assert.equal(refused.kind, "upgrade_pending");
  assert.deepEqual(await treeFingerprint(one.project.directory), mismatchedTree);
  await manager().removeProject(one.project);
  await assert.rejects(readFile(one.project.optInPath), { code: "ENOENT" });
  report.checks.push("actual pinned backend: mismatched data refused as upgrade_pending, left unchanged, and deletable");
  report.checks.push("last owned clients and daemons drain");
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const client of clients) await client.close({ allowFailure: true });
  for (const value of managers) await value.shutdown().catch(error => console.error(String(error)));
  if (process.argv.includes("--keep")) console.error(`Retained native fixture: ${home}`);
  else await rm(home, { recursive: true, force: true });
}
