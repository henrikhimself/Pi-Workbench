/** Synthetic Playwright fixtures. Never import upstream code or launch a browser. */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const PINNED_PLAYWRIGHT_METADATA = Object.freeze({
  mcp: "0.0.84", playwright: "1.65.0-alpha-2026-10-30", core: "1.65.0-alpha-2026-10-30",
});

export async function playwrightFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "wb-playwright-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home"), workspace = join(root, "workspace");
  const managed = join(home, ".pi", "pi-workbench", "playwright");
  for (const dir of [home, workspace, "agent", "cache", "config", "data", "tmp"].map(path => path.startsWith(root) ? path : join(root, path))) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  const workspaceId = createHash("sha256").update(workspace).digest("hex");
  const sessionId = randomUUID();
  const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(root, "agent"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    TMPDIR: join(root, "tmp"), WORKBENCH_RUNTIME_TESTS: "", WORKBENCH_LIVE_TESTS: "", WORKBENCH_PLAYWRIGHT_LIVE_TESTS: "" };
  return { root, home, workspace, managed, workspaceId, sessionId, env };
}

/** Deliberately synthetic: these records do not claim a live process identity. */
export async function syntheticPlaywrightOwnership(directory, resource, overrides = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const record = { schema: 1, token, resource, pid: process.pid, start: "synthetic-not-live", host: "fixture-only", ...overrides };
  const path = join(directory, `${token}.json`);
  await writeFile(path, JSON.stringify(record), { flag: "wx", mode: 0o600 });
  return { path, record };
}

/** Injectable boundaries for metadata/install/browser/spawn/publication tests. */
export function fakePlaywrightServices(overrides = {}) {
  const calls = [];
  function operation(name, result) {
    return async (...args) => {
      calls.push({ name, args });
      for (const arg of args) {
        if (arg?.signal?.aborted) throw new Error("Synthetic Playwright operation cancelled");
      }
      if (overrides[name]) return overrides[name](...args);
      return structuredClone(result);
    };
  }
  return {
    calls,
    metadata: operation("metadata", PINNED_PLAYWRIGHT_METADATA),
    install: operation("install", { exitCode: 0, stdout: "", stderr: "" }),
    provisionBrowser: operation("provisionBrowser", { exitCode: 0, stdout: "", stderr: "" }),
    readiness: operation("readiness", { ok: true, browserVersion: "synthetic-chromium", tools: ["browser_snapshot", "browser_take_screenshot", "browser_evaluate"] }),
    spawn: operation("spawn", { synthetic: true }),
    publish: operation("publish", undefined),
  };
}
