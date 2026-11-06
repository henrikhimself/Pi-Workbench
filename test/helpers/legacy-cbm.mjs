/** Actual v0.8.1 fixture generator, NEVER an application backend fallback. */
import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createJiti } from "jiti";
import { graphQns } from "./graph-qns.mjs";
import { FixtureMcpClient } from "./mcp-client.mjs";
const jiti = createJiti(import.meta.url), run = promisify(execFile);
const { downloadArchive, sha256OfFile, extractCodeGraphArchive, findGnuTar } = await jiti.import("../../src/code-graph-installer.ts");
const reviewed = {
  x64: { platform: "linux-amd64", bytes: 37332248, sha256: "6ab87a6c05d049dde57700803ca0ab4199fcf25973a0606618af0fcee73f5abd" },
  arm64: { platform: "linux-arm64", bytes: 36951759, sha256: "13526acc2a6a0697dff3c763fb443a416589bc10ad8b12015b63d87e515dd72b" },
};
export async function createLegacyFixture(paths, workspace, status) {
  const asset = reviewed[process.arch]; assert.ok(asset, "native AMD64/ARM64 only");
  const root = join(paths.codeGraphRoot, "fixtures", "v0.8.1"), cache = join(root, "cache"), home = join(root, "home"), bin = join(root, "bin");
  for (const path of [root, cache, home, bin, join(paths.codeGraphIpc, "old")]) await mkdir(path, { recursive: true, mode: 0o700 });
  const archive = join(root, "asset.tar.gz"), url = `https://github.com/DeusData/codebase-memory-mcp/releases/download/v0.8.1/codebase-memory-mcp-${asset.platform}-portable.tar.gz`;
  await downloadArchive(url, archive, status); assert.equal((await stat(archive)).size, asset.bytes); assert.equal(await sha256OfFile(archive), asset.sha256);
  const { binaryPath } = await extractCodeGraphArchive(archive, bin, await findGnuTar());
  const image = "debian:trixie-slim", details = JSON.parse((await run("docker", ["image", "inspect", image], { timeout: 10000 })).stdout)[0];
  assert.equal(details.Architecture, process.arch === "x64" ? "amd64" : "arm64", "never emulate the other architecture");
  const mappedUid = (await run("docker", ["run", "--rm", "--network", "none", "-v", `${paths.root}:/wb:ro`, image, "stat", "-c", "%u:%g", "/wb"], { timeout: 30000 })).stdout.trim();
  assert.match(mappedUid, /^[0-9]+:[0-9]+$/);
  const docker = ["run", "--rm", "-i", "--network", "none", "--read-only", "--user", mappedUid,
    "--tmpfs", "/tmp:rw,mode=1777", "-v", `${paths.root}:${paths.root}:rw`, "-v", `${workspace}:${workspace}:ro`,
    "-w", workspace, "-e", `HOME=${home}`, "-e", `CBM_CACHE_DIR=${cache}`, "-e", `CBM_RUNTIME_DIR=${join(paths.codeGraphIpc, "old")}`, image, binaryPath];
  assert.match((await run("docker", [...docker, "--version"], { timeout: 30000 })).stdout, /0\.8\.1/);
  await run("docker", [...docker, "config", "set", "auto_index", "true"], { timeout: 30000 });
  const indexed = JSON.parse((await run("docker", [...docker, "cli", "index_repository", JSON.stringify({ repo_path: workspace })], { timeout: 60000 })).stdout);
  assert.equal(indexed.status, "indexed");
  const client = new FixtureMcpClient({ command: "docker", args: [...docker, "--quiet", "--ui=false"], env: process.env });
  let reportedMcpVersion;
  try {
    const init = await client.initialize(); reportedMcpVersion = init.serverInfo.version;
    assert.equal(typeof reportedMcpVersion, "string"); // CLI + digest prove legacy artifact; its MCP metadata is stale.
    const tools = (await client.call("tools/list")).tools;
    await writeFile(join(root, "tools.json"), JSON.stringify(tools, null, 2)); assert.equal(tools.length, 14);
    const graph = await client.tool("search_graph", { project: indexed.project, label: "Function", format: "json" });
    const graphText = graph.content.filter(part => part.type === "text").map(part => part.text).join("\n");
    await writeFile(join(root, "graph.json"), graphText);
    const qns = graphQns(JSON.parse(graphText)); assert.ok(qns.length >= 2, "two indexed functions required");
    await client.tool("manage_adr", { project: indexed.project, mode: "update", content: "# ADR\n\n## Runtime fixture\n\nADR runtime sentinel.\n" });
    const trace = await client.tool("ingest_traces", { project: indexed.project, traces: [{ path: qns.slice(0, 2), count: 12 }] });
    const traceResult = JSON.parse(trace.content.filter(part => part.type === "text").map(part => part.text).join("\n"));
    assert.match(traceResult.note, /not yet implemented/);
    await writeFile(join(root, "trace-result.json"), JSON.stringify(traceResult, null, 2));
    await client.close();
  } finally { await client.close({ allowFailure: true }); }
  return { cache, version: "v0.8.1", resolvedUrl: url, sha256: asset.sha256, image: details.Id, reportedMcpVersion, tracePersistence: false, projectName: indexed.project };
}
