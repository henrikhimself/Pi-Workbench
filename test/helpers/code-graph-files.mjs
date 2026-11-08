import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { codeGraphIdentity } = await jiti.import("../../src/code-graph-config.ts");
const { writeOptIn } = await jiti.import("../../src/project-opt-in.ts");

/** The files `/wb:code-graph on` leaves behind: identity first, CBM data, opt-in last. */
export async function writeCodeGraphFiles(project, asset, { optIn = true, index = false } = {}) {
  await mkdir(project.directory, { recursive: true });
  await writeFile(project.identityPath, JSON.stringify(codeGraphIdentity(asset)), { mode: 0o600 });
  await writeFile(join(project.directory, "_config.db"), "auto_index = true\n");
  if (index) await writeFile(join(project.directory, "derived-project.db"), "INDEX");
  if (optIn) await writeOptIn(project, project.directory);
}
