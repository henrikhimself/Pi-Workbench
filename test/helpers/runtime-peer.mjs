/** Offline subprocess fixture: real ownership/locking, injected package executor only. */
import { createJiti } from "jiti";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
const jiti = createJiti(import.meta.url);
const { ManagedHeadroomRuntime } = await jiti.import("../../src/headroom-runtime.ts");
const { resolveWorkbenchPaths } = await jiti.import("../../src/paths.ts");
const [home, version = "0.41.0"] = process.argv.slice(2);
const paths = resolveWorkbenchPaths(home), messages = [];
const runtime = new ManagedHeadroomRuntime({ paths, requiredVersion: version, systemPython: async () => "fixture-python",
  run: async (_command, args) => {
    if (args.includes("venv")) {
      const bin = join(args.at(-1), "bin"); await mkdir(bin, { recursive: true });
      for (const name of ["python", "headroom"]) await writeFile(join(bin, name), "fixture", { mode: 0o700 });
      return "";
    }
    if (args.includes("--report")) {
      await writeFile(args[args.indexOf("--report") + 1], JSON.stringify({ install: ["headroom-ai", "cryptography"].map(name => ({ metadata: { name, version: name === "cryptography" ? "50.0.2" : version }, download_info: { archive_info: { hashes: { sha256: "a".repeat(64) } } } })) })); return "";
    }
    if (args.includes("--version")) return "pip 24.0 from /fixture/pip (python 3)";
    if (args.includes("pip")) {
      await appendFile(join(home, "installs.jsonl"), JSON.stringify({ pid: process.pid, version }) + "\n");
      await new Promise(resolve => setTimeout(resolve, 100)); return "";
    }
    if (args[1]?.includes("distributions")) return JSON.stringify({ version, transport: "50.0.2", inventory: [{ name: "headroom-ai", version }] });
    return "controlled Python fixture";
  } });
const acquired = await runtime.acquire("fixture-role", message => messages.push(message));
if (!acquired) { console.log(JSON.stringify({ ok: false, messages })); process.exitCode = 2; }
else {
  console.log(JSON.stringify({ ok: true, slot: acquired.descriptor.slot }));
  process.stdin.resume(); await new Promise(resolve => process.stdin.once("end", resolve));
  await acquired.lease.release();
}
