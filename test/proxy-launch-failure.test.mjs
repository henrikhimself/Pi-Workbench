/** H-12. Own file: it needs a real spawn, and proxy-manager.test.mjs mocks spawn (the module keeps the first binding). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { ProxyManager } = await jiti.import("../src/proxy-manager.ts");
const { createConsumerLease, publishJson } = await jiti.import("../src/managed-lifecycle.ts");

test("H-12: a launch that fails after spawn kills the child and removes its service lease", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "wb-proxy-launch-failure-"));
  let pid = 0;
  try {
    const slot = join(root, "runtimes", "0.41.0", "fixture"); await mkdir(join(slot, "bin"), { recursive: true, mode: 0o700 });
    const python = join(slot, "bin", "python"), pidFile = join(root, "child.pid");
    // The fixture child records its pid, then idles until it is killed.
    await writeFile(python, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
    const descriptor = { schemaVersion: 1, version: "0.41.0", slot, python, cli: join(slot, "bin", "headroom"), inventory: [], pythonIdentity: "fixture", dependencyDigest: "fixture", embedding: { model: "Qdrant/all-MiniLM-L6-v2-onnx", dimensions: 384, provider: "CPUExecutionProvider" } };
    await publishJson(root, join(slot, "ready.json"), descriptor);
    const leaseRoot = join(root, "consumers");
    const runtime = { root, leaseRoot, inspect: async () => descriptor, environment: () => ({}),
      acquire: async resource => ({ descriptor, lease: await createConsumerLease(leaseRoot, resource) }) };
    const port = 38787;
    const manager = new ProxyManager({ port, runtime });
    manager.descriptor = descriptor;
    await mkdir(join(root, "proxies", String(port), "owner.json"), { recursive: true }); // publishing owner.json now fails
    await assert.rejects(manager.launch(() => {}));
    assert.deepEqual((await readdir(leaseRoot)).filter(name => name.endsWith(".json")), [], "no service lease is left behind");
    // A child killed before it ran never wrote the file; one that ran must be gone within 3 s.
    const written = Date.now() + 1500;
    while (!pid && Date.now() < written) { pid = Number(await readFile(pidFile, "utf8").catch(() => "")); if (!pid) await new Promise(resolve => setTimeout(resolve, 25)); }
    if (pid) {
      const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
      const deadline = Date.now() + 3000;
      while (alive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(alive(), false, "the child must not keep running without an owner record");
    }
  } finally {
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await rm(root, { recursive: true, force: true });
  }
});
