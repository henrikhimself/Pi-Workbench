import { basename, dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { assertNoSymlink, assertWithin, identityLive } from "./managed-lifecycle.js";
import { WORKBENCH_PATHS } from "./paths.js";
import { PLAYWRIGHT_VERSION, assertPlaywrightId, inspectPlaywrightPath, parsePlaywrightSession, playwrightPolicyConfiguration, readPlaywrightJson, resolvePlaywrightProject, resolvePlaywrightSession } from "./playwright-config.js";
import { playwrightAssets, verifyPlaywrightPackages } from "./playwright-runtime.js";
import { installPlaywrightTempRouting } from "./playwright-temp.js";

export interface PlaywrightMcpBootstrapSpec { schema: 1; command: string; args: string[]; root: string; browser: string; home: string; tmp: string }
/** Load the unmodified official CLI in its actual stdio process. The only adapter
 * preserves managed temporary placement despite Linux UNIX-socket name limits.
 */
export async function bootstrapPlaywrightMcp(raw: unknown): Promise<void> {
  const fields = ["schema", "command", "args", "root", "browser", "home", "tmp"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(raw, key))) throw new Error("Invalid Playwright MCP bootstrap");
  const spec = raw as PlaywrightMcpBootstrapSpec;
  if (spec.schema !== 1 || spec.command !== process.execPath || ![spec.root, spec.browser, spec.home, spec.tmp].every(value => typeof value === "string" && isAbsolute(value) && !value.includes("\0")) || !Array.isArray(spec.args) || spec.args.length !== 3 || spec.args[1] !== "--config" || spec.args.some(value => typeof value !== "string")) throw new Error("Invalid Playwright MCP bootstrap paths/arguments");
  const entrypoint = spec.args[0], slot = dirname(dirname(dirname(dirname(entrypoint)))), id = basename(slot);
  assertPlaywrightId(id); assertPlaywrightId(process.env.WB_PLAYWRIGHT_SESSION_ID ?? "");
  if (slot !== join(spec.root, "runtimes", PLAYWRIGHT_VERSION, id) || entrypoint !== join(slot, "node_modules", "@playwright", "mcp", "cli.js") || process.env.WB_PLAYWRIGHT_RUNTIME_ID !== id) throw new Error("Playwright MCP bootstrap package identity mismatch");
  assertWithin(join(slot, "browsers"), spec.browser); await assertNoSymlink(spec.browser);
  const directory = dirname(spec.home);
  if (spec.home !== join(directory, "home") || spec.tmp !== join(directory, "tmp") || spec.args[2] !== join(directory, "config.json")) throw new Error("Playwright MCP bootstrap session paths mismatch");
  if (directory === join(slot, "probe")) {
    if (process.cwd() !== directory) throw new Error("Playwright readiness workspace mismatch");
  } else {
    const project = resolvePlaywrightProject(process.cwd(), { ...WORKBENCH_PATHS, playwrightRoot: spec.root, playwrightProjects: join(spec.root, "projects") });
    const session = resolvePlaywrightSession(project, process.env.WB_PLAYWRIGHT_SESSION_ID!);
    if (session.directory !== directory) throw new Error("Playwright MCP bootstrap workspace/session mismatch");
    const marker = parsePlaywrightSession(await readPlaywrightJson(spec.root, session.markerPath));
    if (marker.runtimeId !== id || marker.sessionId !== session.id || marker.workspace !== project.projectPath || marker.identifier !== project.identifier || !await identityLive(marker.owner)) throw new Error("Playwright MCP bootstrap owner mismatch");
  }
  for (const [key, expected] of Object.entries({ HOME: spec.home, USERPROFILE: spec.home, TMPDIR: spec.tmp, TMP: spec.tmp, TEMP: spec.tmp, XDG_RUNTIME_DIR: join(spec.tmp, "run") })) if (process.env[key] !== expected) throw new Error("Playwright MCP bootstrap private environment mismatch");
  await inspectPlaywrightPath(spec.root, spec.args[2]);
  if (!isDeepStrictEqual(await readPlaywrightJson(spec.root, spec.args[2]), playwrightPolicyConfiguration(join(directory, "artifacts"), spec.browser))) throw new Error("Playwright MCP bootstrap fixed policy mismatch");
  await verifyPlaywrightPackages(slot, await playwrightAssets());
  const routing = await installPlaywrightTempRouting({ root: spec.root, directory: spec.tmp, home: spec.home, browser: spec.browser });
  try { process.argv = [process.execPath, ...spec.args]; await import(pathToFileURL(entrypoint).href); }
  catch (error) { await routing.close(); throw error; }
  // The installed adapter retains its descriptor until this MCP process exits.
}
