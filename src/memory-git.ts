import { execText } from "./exec-escalating.js";
import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const START = "# >>> pi-workbench Headroom Memory >>>";
const END = "# <<< pi-workbench Headroom Memory <<<";
const DRIVER = fileURLToPath(new URL("./memory-merge-theirs.mjs", import.meta.url));
/** Workbench-specific name: a user's own `theirs` driver is never reused or overwritten. */
export const MEMORY_MERGE_DRIVER = "pi-workbench-theirs";

function runGit(cwd: string, args: string[]): Promise<string> {
  return execText("git", args, { cwd, timeoutMs: 30_000 });
}

const BUNDLE_MEMBERS = ["manifest.json", "memories/**", "entities/**", "relationships/**"] as const;

/**
 * One `.gitattributes` pattern for a bundle member under `directory` (slash-separated). Glob characters
 * in the directory are escaped, and a path with anything beyond plain characters is double-quoted
 * with C-style escapes. Returns null for a path with control characters, which cannot be written safely.
 */
function attributePattern(directory: string, member: string): string | null {
  if (/[\u0000-\u001f\u007f]/.test(directory)) return null;
  const pattern = `${directory.replace(/[\\*?[\]]/g, "\\$&")}/${member}`;
  if (!/[^A-Za-z0-9._/@+-]/.test(directory)) return pattern;
  return `"${pattern.replace(/[\\"]/g, "\\$&")}"`;
}

/** Temp file plus rename, so a crash never leaves a half-written `.gitattributes`. */
async function writeAttributesAtomically(path: string, content: string, mode: number): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", mode);
    try { await handle.writeFile(content, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/** Warning-only Git integration for an opted-in canonical Memory export. */
export async function configureMemoryGit(projectPath: string, exportDirectory?: string): Promise<string | null> {
  if (!exportDirectory) return null;
  try {
    const root = await runGit(projectPath, ["rev-parse", "--show-toplevel"]);
    const pattern = relative(root, exportDirectory);
    if (!pattern || pattern === ".." || pattern.startsWith(`..${sep}`) || resolve(root, pattern) !== resolve(exportDirectory)) {
      return "Memory export is outside Git worktree; merge attributes were not configured.";
    }
    const attributes = resolve(root, ".gitattributes");
    let current = "";
    let mode = 0o666;
    try {
      const info = await lstat(attributes);
      if (!info.isFile()) return ".gitattributes is not a regular file; merge attributes were not changed.";
      mode = info.mode & 0o777;
      current = await readFile(attributes, "utf8");
    } catch (error: unknown) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
    }
    const directory = pattern.split(sep).join("/");
    const lines = BUNDLE_MEMBERS.map(member => attributePattern(directory, member));
    if (lines.some(line => line === null)) return "Memory export path contains control characters; merge attributes were not configured.";
    const block = `${START}\n${lines.map(line => `${line} merge=${MEMORY_MERGE_DRIVER}`).join("\n")}\n${END}\n`;
    const begin = current.indexOf(START);
    const end = current.indexOf(END);
    if (begin !== -1 && end !== -1 && end >= begin) {
      const after = end + END.length + (current[end + END.length] === "\n" ? 1 : 0);
      current = `${current.slice(0, begin)}${block}${current.slice(after)}`;
    } else if (begin === -1 && end === -1) {
      current = `${current}${current && !current.endsWith("\n") ? "\n" : ""}${block}`;
    } else {
      return "Malformed pi-workbench .gitattributes block; merge attributes were not changed.";
    }
    await writeAttributesAtomically(attributes, current, mode);
    // The path of Node and of this extension is part of the command; refresh it whenever it changed
    // (Node upgrade, nvm switch, extension moved), so the driver never points at a dead path.
    const command = `"${process.execPath}" "${DRIVER}" %A %B`;
    const key = `merge.${MEMORY_MERGE_DRIVER}.driver`;
    let configured: string | null = null;
    try { configured = await runGit(root, ["config", "--local", "--get", key]); } catch { /* not configured yet */ }
    if (configured !== command) {
      await runGit(root, ["config", "--local", key, command]);
      await runGit(root, ["config", "--local", `merge.${MEMORY_MERGE_DRIVER}.name`, "pi-workbench Headroom Memory: keep incoming record"]);
    }
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Git Memory integration skipped: ${message}`;
  }
}
