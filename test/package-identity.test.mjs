import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const packageLock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const license = await readFile(new URL("../LICENSE", import.meta.url), "utf8");

test("package identity: manifest and lockfile use pi-workbench 0.1.0", () => {
  assert.equal(packageJson.name, "pi-workbench");
  assert.equal(packageJson.version, "0.1.0");
  assert.equal(packageJson.license, "Apache-2.0");
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.repository?.url, "git+https://github.com/henrikhimself/Pi-Workbench.git");
  assert.equal(packageJson.bugs?.url, "https://github.com/henrikhimself/Pi-Workbench/issues");
  assert.equal(packageJson.homepage, "https://github.com/henrikhimself/Pi-Workbench#readme");
  assert.equal(packageLock.name, "pi-workbench");
  assert.equal(packageLock.version, "0.1.0");
  assert.equal(packageLock.packages[""].name, "pi-workbench");
  assert.equal(packageLock.packages[""].version, "0.1.0");
  assert.equal(packageLock.packages[""].license, "Apache-2.0");
  assert.match(license, /Apache License\n\s+Version 2\.0, January 2004/);
});
