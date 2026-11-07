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
  ["Node npm installer entry", 'import { execFileSync } from "node:child_process"; try { execFileSync(process.execPath, ["/fixture/node_modules/npm/bin/npm-cli.js", "ci"]); } catch {}', /Node package.backend entrypoint/],
  ["Node npx entry", 'import { spawnSync } from "node:child_process"; try { spawnSync(process.execPath, ["/fixture/npm/bin/npx-cli.js", "@playwright/mcp"]); } catch {}', /Node package.backend entrypoint/],
  ["Node Playwright MCP entry", 'import { execFileSync } from "node:child_process"; try { execFileSync(process.execPath, ["/fixture/node_modules/@playwright/mcp/cli.js"]); } catch {}', /Node package.backend entrypoint/],
  ["Node Playwright downloader", 'import { execFileSync } from "node:child_process"; try { execFileSync(process.execPath, ["/fixture/node_modules/playwright/cli.js", "install", "chromium"]); } catch {}', /Node package.backend entrypoint/],
  ["Node core browser downloader", 'import { execFileSync } from "node:child_process"; try { execFileSync(process.execPath, ["/fixture/playwright-core/cli.js", "install"]); } catch {}', /Node package.backend entrypoint/],
  ["forked MCP entry", 'import { fork } from "node:child_process"; try { fork(new URL("file:///fixture/node_modules/@playwright/mcp/cli.js")); } catch {}', /Node package.backend entrypoint/],
  ["promisified Node npm installer", 'import { execFile } from "node:child_process"; import { promisify } from "node:util"; try { await promisify(execFile)(process.execPath, ["/fixture/npm/bin/npm-cli.js", "ci"]); } catch {}', /Node package.backend entrypoint/],
  ["Chromium executable", 'import { execFileSync } from "node:child_process"; try { execFileSync("/fixture/chrome", ["--headless"]); } catch {}', /browser execution/],
  ["Chromium headless shell", 'import { execFileSync } from "node:child_process"; try { execFileSync("/fixture/chrome-headless-shell"); } catch {}', /browser execution/],
  ["Playwright binary", 'import { execFileSync } from "node:child_process"; try { execFileSync("playwright", ["install"]); } catch {}', /Playwright backend/],
  ["managed launcher JSON Node backend", 'import { execFileSync } from "node:child_process"; try { execFileSync(process.execPath, ["/fixture/launcher.mjs", JSON.stringify({schema:1,command:process.execPath,args:["/fixture/@playwright/mcp/cli.js"]})]); } catch {}', /Node package.backend entrypoint/],
  ["external DNS", 'import dns from "node:dns"; try { dns.lookup("example.invalid", () => {}); } catch {}', /DNS example.invalid/],
  ["shell installer", 'import { execSync } from "node:child_process"; try { execSync("pip install fixture"); } catch {}', /unexpected shell execution/],
  ["external socket", 'import net from "node:net"; try { net.connect({host:"example.invalid",port:443}); } catch {}', /network example.invalid:443/],
]) test(`offline policy fails process for ${label}`, () => {
  const child = spawnSync(process.execPath, ["--import", guard, "--input-type=module", "-e", code], { env: { ...process.env, NODE_OPTIONS: "" }, encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 1, child.stderr); assert.match(child.stderr, /Offline policy violation/); assert.match(child.stderr, pattern);
  assert.doesNotMatch(child.stderr, /Cannot find|SyntaxError/);
});


for (const [file, variables, expected] of [
  ["runtime-playwright.mjs", { WORKBENCH_RUNTIME_TESTS: "" }, /Set WORKBENCH_RUNTIME_TESTS=1/],
  ["live-playwright.mjs", { WORKBENCH_LIVE_TESTS: "1", WORKBENCH_PLAYWRIGHT_LIVE_TESTS: "" }, /obtain live Pi\/model approval first/],
  ["live-playwright.mjs", { WORKBENCH_LIVE_TESTS: "", WORKBENCH_PLAYWRIGHT_LIVE_TESTS: "1" }, /obtain live Pi\/model approval first/],
  ["helpers/live-playwright-worker.mjs", { WORKBENCH_LIVE_TESTS: "", WORKBENCH_PLAYWRIGHT_LIVE_TESTS: "" }, /Explicit Playwright live approval gates required/],
]) test(`Playwright gated harness refuses unauthorized execution: ${file} ${JSON.stringify(variables)}`, () => {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL(`./${file}`, import.meta.url))], { env: { ...process.env, ...variables }, encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 1, child.stderr); assert.match(child.stderr, expected);
  assert.doesNotMatch(child.stderr, /Offline policy violation|Cannot find|SyntaxError/);
});
test("real runtime acceptance refuses an unset opt-in instead of silently skipping", () => {
  const script = fileURLToPath(new URL("./runtime-headroom.mjs", import.meta.url));
  const child = spawnSync(process.execPath, [script], { env: { ...process.env, WORKBENCH_RUNTIME_TESTS: "" }, encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stderr, /Set WORKBENCH_RUNTIME_TESTS=1/);
  assert.doesNotMatch(child.stderr, /Offline policy violation|Cannot find/);
});
