import { test } from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import { mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createJiti } from "jiti";
import { playwrightFixture } from "./helpers/playwright-fixture.mjs";
const jiti = createJiti(import.meta.url);
const { installPlaywrightTempRouting } = await jiti.import("../src/playwright-temp.ts");
const { ensurePrivateDirectory } = await jiti.import("../src/managed-lifecycle.ts");

test("Playwright short socket routing keeps physical storage private and browser standard FDs unchanged", async t => {
  const f = await playwrightFixture(t), directory = join(f.root, "managed", "deep-".repeat(30), "tmp"), runtime = join(directory, "run");
  await ensurePrivateDirectory(f.root, runtime);
  const previous = process.env.XDG_RUNTIME_DIR, routing = await installPlaywrightTempRouting({ root: f.root, directory, home: f.home, browser: process.execPath });
  try {
    assert.equal(await realpath(routing.runtimeAlias), runtime);
    const script = `const fs=require('node:fs'),net=require('node:net');
      fs.writeFileSync(process.env.TMPDIR+'/written.txt','synthetic');
      const server=net.createServer();server.listen(process.env.TMPDIR+'/fixture.sock',()=>{
      const dirs=fs.readdirSync('/proc/self/fd').flatMap(fd=>{try {const path=fs.readlinkSync('/proc/self/fd/'+fd);return path.startsWith(process.cwd())?[path]:[]}catch{return[]}});
      console.log(JSON.stringify({cwd:process.cwd(),tmp:fs.realpathSync(process.env.TMPDIR),runtime:process.env.XDG_RUNTIME_DIR,stdin:fs.readlinkSync('/proc/self/fd/0'),dirs}));server.close();});`;
    const child = cp.spawn(process.execPath, ["-e", script], { env: { PATH: process.env.PATH, HOME: f.home, TMPDIR: directory, XDG_RUNTIME_DIR: routing.runtimeAlias }, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
    let output = "", errors = ""; child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { errors += data; });
    assert.equal(await new Promise(resolve => child.once("close", resolve)), 0, errors);
    const result = JSON.parse(output); assert.equal(result.cwd, directory); assert.equal(result.tmp, directory); assert.equal(result.runtime, runtime); assert.equal(result.stdin, "/dev/null"); assert.deepEqual(result.dirs, []);
    assert.equal(await readFile(join(directory, "written.txt"), "utf8"), "synthetic");
  } finally { await routing.close(); await routing.close(); }
  assert.equal(process.env.XDG_RUNTIME_DIR, previous);
});
test("Playwright short socket routing refuses unexpected Chromium stream/environment contracts", async t => {
  const f = await playwrightFixture(t), directory = join(f.root, "tmp"); await ensurePrivateDirectory(f.root, join(directory, "run"));
  const routing = await installPlaywrightTempRouting({ root: f.root, directory, home: f.home, browser: process.execPath });
  try {
    assert.throws(() => cp.spawn(process.execPath, ["-e", "throw Error('must not execute')"], { env: { HOME: f.home, TMPDIR: directory, XDG_RUNTIME_DIR: routing.runtimeAlias }, stdio: ["pipe", "pipe", "pipe"] }), /spawn\/environment contract/);
    assert.throws(() => cp.spawn(process.execPath, ["-e", "throw Error('must not execute')"], { env: { HOME: "/unowned", TMPDIR: directory, XDG_RUNTIME_DIR: routing.runtimeAlias }, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] }), /spawn\/environment contract/);
  } finally { await routing.close(); }
});
test("Playwright short socket routing never adopts symlink storage", async t => {
  const f = await playwrightFixture(t), outside = join(f.root, "outside"), target = join(f.root, "link"); await mkdir(outside, { mode: 0o700 }); await symlink(outside, target);
  await assert.rejects(installPlaywrightTempRouting({ root: f.root, directory: target, home: f.home, browser: process.execPath }), /symlink|Unsafe/i);
});
