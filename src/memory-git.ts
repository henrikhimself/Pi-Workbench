import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const START = "# >>> pi-workbench Headroom Memory >>>";
const END = "# <<< pi-workbench Headroom Memory <<<";
const DRIVER = fileURLToPath(new URL("./memory-merge-theirs.mjs", import.meta.url));

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolvePromise(stdout.trim());
    });
  });
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
    try { current = await readFile(attributes, "utf8"); } catch (error: unknown) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
    }
    const block = `${START}\n${pattern.replaceAll("\\", "/")}/** merge=theirs\n${END}\n`;
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
    await writeFile(attributes, current, "utf8");
    try {
      await runGit(root, ["config", "--local", "--get", "merge.theirs.driver"]);
    } catch {
      const command = `"${process.execPath}" "${DRIVER}" %A %B`;
      await runGit(root, ["config", "--local", "merge.theirs.driver", command]);
    }
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Git Memory integration skipped: ${message}`;
  }
}
