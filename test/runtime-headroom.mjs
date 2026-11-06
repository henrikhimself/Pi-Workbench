/** Explicit opt-in; verified packages, private installation/state, synthetic context only. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { verifyCompressionBridge } from "./helpers/compression-acceptance.mjs";
import { FixtureMcpClient } from "./helpers/mcp-client.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { createJiti } from "jiti";
if (process.env.WORKBENCH_RUNTIME_TESTS !== "1") throw new Error("Set WORKBENCH_RUNTIME_TESTS=1 to authorize isolated runtime installation");
const jiti = createJiti(import.meta.url);
const { ManagedHeadroomRuntime } = await jiti.import("../src/headroom-runtime.ts");
const { ProxyManager } = await jiti.import("../src/proxy-manager.ts");
const { MemoryManager } = await jiti.import("../src/memory-manager.ts");
const { resolveWorkbenchPaths } = await jiti.import("../src/paths.ts");
const home = await mkdtemp(join(tmpdir(), "wb-headroom-acceptance-"));
const paths = resolveWorkbenchPaths(home);
const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port; await new Promise(resolve => server.close(resolve));
const runtime = new ManagedHeadroomRuntime({ paths });
const a = new ProxyManager({ port, runtime }); const b = new ProxyManager({ port, runtime });
const report = { home, architecture: process.arch, model: "no chat model requested; CPU ONNX Memory only", checks: [] };
const clients = [];
const status = message => console.error(message);
try {
  assert.equal(await a.ensureRunning(status), true, "managed proxy A must start");
  const descriptor = await runtime.inspect(); assert.equal(descriptor.version, "0.41.0");
  assert.equal(await b.ensureRunning(status), true, "peer B must attach to attested process");
  const ownerPath = join(runtime.root, "proxies", String(port), "owner.json");
  const originalOwner = JSON.parse(await readFile(ownerPath, "utf8"));
  const compressed = await a.compressRaw({ model: "gpt-4o", messages: [{ role: "user", content: "Synthetic Workbench context. ".repeat(120) }] });
  report.bridge = await verifyCompressionBridge(a);
  assert.ok(Array.isArray(compressed.messages)); report.checks.push("owned sealed compression endpoint");
  assert.equal((await fetch(a.baseUrl + "/v1/retrieve/stats")).status, 403, "unauthenticated content routes remain private");
  const stored = JSON.parse((await promisify(execFile)(descriptor.python, ["-c", [
    "import json",
    "from headroom.cache.compression_store import get_compression_store",
    "s=get_compression_store()",
    "live=s.store('synthetic original CCR sentinel','synthetic compressed',original_tokens=8,compressed_tokens=2)",
    "expired=s.store('synthetic expired CCR sentinel','expired',original_tokens=8,compressed_tokens=2)",
    "e=s._backend.get(expired);e.created_at=0;e.ttl=1;s._backend.set(expired,e)",
    "print(json.dumps({'live':live,'expired':expired}))",
  ].join(";")], { env: runtime.environment(), cwd: runtime.root, timeout: 30000 })).stdout.trim());
  const retrieved = await a.requestOwned("/v1/retrieve/" + stored.live, null, "GET");
  assert.equal(retrieved.original_content, "synthetic original CCR sentinel");
  await assert.rejects(a.requestOwned("/v1/retrieve/" + stored.expired, null, "GET"), /HTTP 404/);
  assert.ok(await readFile(join(runtime.root, "proxy-state", "ccr_store.db")));
  report.checks.push("owned SQLite CCR retrieval, expiration and public content-route denial");
  await a.stop(); assert.equal(await b.healthCheck(), true); report.checks.push("creator exit preserves peer");
  process.kill(originalOwner.pid, "SIGKILL");
  const deadline = Date.now() + 5000;
  while (await b.healthCheck() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await b.tryRestart(status), true, "remaining consumer restarts owned crash");
  const restartedOwner = JSON.parse(await readFile(ownerPath, "utf8")); assert.notEqual(restartedOwner.pid, originalOwner.pid);
  report.checks.push("peer watchdog handoff and owned crash recovery");
  const workspace = join(home, "workspace"); await mkdir(workspace);
  const memory = new MemoryManager({ cwd: workspace, defaultRoot: paths.headroomMemory, runtime, userId: "fixture", exportPath: ".memory-bundle" });
  const python = await memory.prepare(status); assert.ok(python, "CPU model preflight must succeed");
  await memory.createStore();
  const m1 = new FixtureMcpClient(memory.getMcpConfig(python)); clients.push(m1); await m1.initialize();
  await (await import("node:fs/promises")).writeFile(join(home, "memory-tools.json"), JSON.stringify(await m1.call("tools/list"), null, 2));
  await m1.tool("memory_save", { facts: ["Workbench runtime fixture sentinel uses CPU ONNX memory."] });
  const found = await m1.tool("memory_search", { query: "Workbench fixture sentinel CPU ONNX", top_k: 3 });
  assert.match(JSON.stringify(found), /sentinel/i);
  const m2 = new FixtureMcpClient(memory.getMcpConfig(python)); clients.push(m2); await m2.initialize();
  const throughPeer = await m2.tool("memory_search", { query: "Workbench fixture sentinel", top_k: 3 });
  assert.match(JSON.stringify(throughPeer), /sentinel/i);
  assert.equal(await b.healthCheck(), true, "Memory readiness must not disable compression");
  report.checks.push("shared immutable installation: CPU Memory save/search and same-store peers");
  await m1.close();
  await assert.rejects(memory.deleteStore(), /store busy/);
  await m2.close();
  const marker = join(memory.store.directory, "workbench-identity.json");
  const originalMarker = await readFile(marker, "utf8"), invalid = JSON.parse(originalMarker); invalid.headroomVersion = "0.0.0";
  const { writeFile } = await import("node:fs/promises"); await writeFile(marker, JSON.stringify(invalid));
  assert.equal(await memory.prepare(() => {}), null);
  assert.equal(await b.healthCheck(), true, "incompatible Memory leaves healthy compression usable");
  await writeFile(marker, originalMarker);
  report.checks.push("Memory validation failure does not disable healthy proxy");
  const relationshipHelper = fileURLToPath(new URL("./helpers/memory-relationships.py", import.meta.url));
  const graphPath = join(memory.store.directory, "memory_graph.db");
  await promisify(execFile)(python, [relationshipHelper, "seed", graphPath], { env: runtime.environment(), timeout: 10000 });
  const exported = JSON.parse(await memory.exportBundle(python)); assert.ok(exported.memories >= 1); assert.ok(exported.entities >= 2); assert.ok(exported.relationships >= 1);
  const imported = await memory.importBundle(python); assert.ok(await readFile(join(imported.backupDirectory, "memory.db")));
  await promisify(execFile)(python, [relationshipHelper, "assert", graphPath], { env: runtime.environment(), timeout: 10000 });
  report.checks.push("Memory peers protect data; logical export/import preserves native relationships and physical backups");
  await b.stop(); assert.equal(await b.healthCheck(), false); report.checks.push("last proxy consumer shutdown");
  const memoryOnly = new FixtureMcpClient(memory.getMcpConfig(python)); clients.push(memoryOnly); await memoryOnly.initialize();
  assert.match(JSON.stringify(await memoryOnly.tool("memory_search", { query: "Workbench fixture sentinel", top_k: 3 })), /sentinel/i);
  assert.equal(await b.healthCheck(), false, "Memory-only readiness cannot start proxy");
  await memoryOnly.close(); report.checks.push("Memory-only post-import search without proxy");
  report.runtime = { version: descriptor.version, slot: descriptor.slot, dependencyDigest: descriptor.dependencyDigest, distributions: descriptor.inventory.length };
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const client of clients) await client.close({ allowFailure: true });
  await a.stop(); await b.stop();
  if (process.argv.includes("--keep")) console.error(`Retained owned fixture: ${home}`);
  else await rm(home, { recursive: true, force: true });
}
