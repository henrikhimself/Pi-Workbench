/** Default test entry: isolated user roots, no runtime downloads/services/inference. */
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = await mkdtemp(join(tmpdir(), "wb-offline-suite-"));
try {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(HEADROOM_|HF_|PYTHON|PIP_|PI_|XDG_|NODE_OPTIONS|WORKBENCH_RUNTIME_TESTS)/.test(key) && !/(API_KEY|TOKEN|PASSWORD|SECRET)$/.test(key)));
  for (const dir of ["agent", "cache", "config", "data"]) await mkdir(join(root, dir), { mode: 0o700 });
  Object.assign(env, { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: join(root, "agent"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    NODE_OPTIONS: `--import=${fileURLToPath(new URL("./helpers/offline-guard.mjs", import.meta.url))}`, PYTHONDONTWRITEBYTECODE: "1" });
  const files = (await readdir(new URL("./", import.meta.url))).filter(name => name.endsWith(".test.mjs")).sort().map(name => fileURLToPath(new URL(name, import.meta.url)));
  if (!files.length) throw new Error("No offline tests discovered");
  const child = spawn(process.execPath, ["--test", ...process.argv.slice(2), ...files], { env, stdio: "inherit" });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve(code)); });
  process.exitCode = code ?? 1;
} finally { await rm(root, { recursive: true, force: true }); }
