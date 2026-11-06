import { createHash } from "node:crypto";
import { readdir, lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
export async function treeFingerprint(root, directory = root) {
  const result = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name), info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("Unsafe synthetic snapshot symlink");
    if (info.isDirectory()) result.push(...await treeFingerprint(root, path));
    else if (info.isFile()) result.push({ path: path.slice(root.length + 1), bytes: info.size, sha256: createHash("sha256").update(await readFile(path)).digest("hex") });
    else throw new Error("Unsupported synthetic snapshot entry");
  }
  return result;
}
