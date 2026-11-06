import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const guard = fileURLToPath(new URL("./helpers/offline-guard.mjs", import.meta.url));
for (const [label, code, pattern] of [
  ["external fetch swallowed by fail-open", 'try { await fetch("https://example.invalid"); } catch {}', /network example.invalid:443/],
  ["real default proxy access", 'try { await fetch("http://127.0.0.1:8787/health"); } catch {}', /network 127.0.0.1:8787/],
  ["pip installer", 'import { execFileSync } from "node:child_process"; try { execFileSync("python3", ["-m", "pip", "install", "fixture-package"]); } catch {}', /Python package\/service operation/],
  ["promisified installer", 'import { execFile } from "node:child_process"; import { promisify } from "node:util"; try { await promisify(execFile)("python3", ["-m", "venv", "unused"]); } catch {}', /Python package\/service operation/],
  ["external DNS", 'import dns from "node:dns"; try { dns.lookup("example.invalid", () => {}); } catch {}', /DNS example.invalid/],
  ["shell installer", 'import { execSync } from "node:child_process"; try { execSync("pip install fixture"); } catch {}', /unexpected shell execution/],
  ["external socket", 'import net from "node:net"; try { net.connect({host:"example.invalid",port:443}); } catch {}', /network example.invalid:443/],
]) test(`offline policy fails process for ${label}`, () => {
  const child = spawnSync(process.execPath, ["--import", guard, "--input-type=module", "-e", code], { env: { ...process.env, NODE_OPTIONS: "" }, encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 1, child.stderr); assert.match(child.stderr, /Offline policy violation/); assert.match(child.stderr, pattern);
  assert.doesNotMatch(child.stderr, /Cannot find|SyntaxError/);
});


test("real runtime acceptance refuses an unset opt-in instead of silently skipping", () => {
  const script = fileURLToPath(new URL("./runtime-headroom.mjs", import.meta.url));
  const child = spawnSync(process.execPath, [script], { env: { ...process.env, WORKBENCH_RUNTIME_TESTS: "" }, encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stderr, /Set WORKBENCH_RUNTIME_TESTS=1/);
  assert.doesNotMatch(child.stderr, /Offline policy violation|Cannot find/);
});
