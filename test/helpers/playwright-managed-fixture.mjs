import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createJiti } from "jiti";
import { playwrightFixture } from "./playwright-fixture.mjs";
const jiti = createJiti(import.meta.url);
const config = await jiti.import("../../src/playwright-config.ts");
const runtimeModule = await jiti.import("../../src/playwright-runtime.ts");
const { resolveWorkbenchPaths } = await jiti.import("../../src/paths.ts");
const { publishJson } = await jiti.import("../../src/managed-lifecycle.ts");
const sha = data => createHash("sha256").update(data).digest("hex");
export const nodePath = await realpath(process.execPath), nodeSha = sha(await readFile(nodePath));
export async function managedPlaywrightFixture(t) {
  const f = await playwrightFixture(t), paths = resolveWorkbenchPaths(f.home), project = config.resolvePlaywrightProject(f.workspace, paths), id = randomUUID();
  const slot = join(paths.playwrightRuntimes, config.PLAYWRIGHT_VERSION, id), assets = await runtimeModule.playwrightAssets();
  await mkdir(slot, { recursive: true, mode: 0o700 });
  await writeFile(join(slot, "package.json"), assets.manifest, { mode: 0o600 }); await writeFile(join(slot, "package-lock.json"), assets.lock, { mode: 0o600 });
  for (const [name, version] of [["@playwright/mcp", config.PLAYWRIGHT_VERSION], ["playwright", config.PLAYWRIGHT_ENGINE_VERSION], ["playwright-core", config.PLAYWRIGHT_ENGINE_VERSION]]) {
    const directory = join(slot, "node_modules", name); await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "package.json"), JSON.stringify({ version, type: "module" }), { mode: 0o600 });
    await writeFile(join(directory, "cli.js"), name === "@playwright/mcp" ? await readFile(new URL("./fake-playwright-mcp.mjs", import.meta.url)) : "// never execute", { mode: 0o600 });
    if (name === "@playwright/mcp") await writeFile(join(directory, "fake-playwright-browser.mjs"), await readFile(new URL("./fake-playwright-browser.mjs", import.meta.url)), { mode: 0o600 });
  }
  const browser = join(slot, "browsers", "synthetic", "chrome"), npm = join(f.root, "npm-cli.js");
  await mkdir(join(slot, "browsers", "synthetic"), { recursive: true, mode: 0o700 });
  await writeFile(browser, "never execute a real browser", { mode: 0o700 }); await writeFile(npm, "synthetic npm, never execute", { mode: 0o700 });
  const record = { schema: 1, policy: 1, id, version: config.PLAYWRIGHT_VERSION, engineVersion: config.PLAYWRIGHT_ENGINE_VERSION, manifestSha256: assets.sha256, slot,
    node: { path: nodePath, version: process.versions.node, sha256: nodeSha }, npm: { path: npm, version: "10.9.7", sha256: sha("synthetic npm, never execute") },
    entrypoint: join(slot, "node_modules", "@playwright", "mcp", "cli.js"), browser, browserVersion: "synthetic", tools: [...config.PLAYWRIGHT_REQUIRED_TOOLS], validatedAt: new Date().toISOString() };
  await publishJson(paths.playwrightRoot, join(slot, "ready.json"), record);
  await publishJson(paths.playwrightRoot, paths.playwrightSelected, { schema: 1, id, version: record.version, slot });
  await config.setPlaywrightOptIn(project, true);
  async function session() {
    const session = config.resolvePlaywrightSession(project); await config.preparePlaywrightSession(session, record);
    const spec = { schema: 1, home: f.home, workspace: f.workspace, sessionId: session.id, runtimeId: id, command: nodePath, args: [record.entrypoint, "--config", session.configPath] };
    const env = config.playwrightPiEnvironment(config.playwrightChildEnvironment(session, record, paths.playwrightNpmCache));
    return { session, spec, env };
  }
  return { ...f, paths, project, record, session };
}
