/** Test-owned pairing only; never a production rollback or backend fallback. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createJiti } from "jiti";
import { FixtureMcpClient } from "./mcp-client.mjs";
const run = promisify(execFile), jiti = createJiti(import.meta.url);
export async function verifyManualPair(paths, workspace, cache) {
  const revision = "f0f549bca882cb77b871bbcf116be18786b62047";
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  const root = join(paths.codeGraphRoot, "fixtures", "old-extension"), src = join(root, "src");
  await mkdir(src, { recursive: true, mode: 0o700 }); await writeFile(join(root, "package.json"), '{"type":"module"}');
  for (const file of ["paths.ts", "code-graph-assets.ts", "code-graph-installer.ts"]) {
    await writeFile(join(src, file), (await run("git", ["show", revision + ":src/" + file], { cwd: repository })).stdout);
  }
  const old = await jiti.import(join(src, "code-graph-installer.ts"));
  assert.equal(old.detectCodeGraphPlatform({ os: "linux", arch: "arm64" }), "linux-arm64");
  assert.equal(old.detectCodeGraphPlatform({ os: "linux", arch: "x64" }), null, "older Workbench must remain off on AMD64");
  const legacy = join(paths.codeGraphRoot, "fixtures", "v0.8.1"), image = "debian:trixie-slim";
  const mapped = (await run("docker", ["run", "--rm", "--network", "none", "-v", paths.root + ":/wb:ro", image, "stat", "-c", "%u:%g", "/wb"])).stdout.trim();
  const args = ["run", "--rm", "-i", "--network", "none", "--read-only", "--user", mapped,
    "--tmpfs", "/tmp:rw,mode=1777", "-v", paths.root + ":" + paths.root + ":rw", "-v", workspace + ":" + workspace + ":ro",
    "-w", workspace, "-e", "HOME=" + join(legacy, "home"), "-e", "CBM_CACHE_DIR=" + cache,
    image, join(legacy, "bin", "codebase-memory-mcp"), "--quiet", "--ui=false"];
  const client = new FixtureMcpClient({ command: "docker", args, env: process.env });
  try {
    await client.initialize();
    assert.equal((await client.call("tools/list")).tools.length, 14);
    const projects = await client.tool("list_projects", {});
    const result = JSON.parse(projects.content.filter(part => part.type === "text").map(part => part.text).join("\n"));
    const project = typeof result.projects[0] === "string" ? result.projects[0] : result.projects[0].name;
    const adr = await client.tool("manage_adr", { project, mode: "get" });
    assert.match(JSON.stringify(adr), /ADR runtime sentinel/);
    await client.close();
  } finally { await client.close({ allowFailure: true }); }
  return { olderWorkbenchRevision: revision, oldArm64Mapping: true, oldAmd64Mapping: false, pairedOldBackendData: true };
}
