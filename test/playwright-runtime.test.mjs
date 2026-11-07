import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createJiti } from "jiti";
import { playwrightFixture } from "./helpers/playwright-fixture.mjs";
const jiti = createJiti(import.meta.url);
const m = await jiti.import("../src/playwright-runtime.ts");
const config = await jiti.import("../src/playwright-config.ts");
const { resolveWorkbenchPaths } = await jiti.import("../src/paths.ts");
const { publishJson, createConsumerLease } = await jiti.import("../src/managed-lifecycle.ts");
const sha = data => createHash("sha256").update(data).digest("hex");
async function fixture(t, changes = {}) {
  const f = await playwrightFixture(t), paths = resolveWorkbenchPaths(f.home), calls = [], progress = [];
  const node = join(f.root, "host-node"), npm = join(f.root, "npm-cli.js");
  await writeFile(node, "synthetic node", { mode: 0o700 }); await writeFile(npm, "synthetic npm", { mode: 0o700 });
  const host = { node: { path: node, version: "22.22.2", sha256: sha("synthetic node") }, npm: { path: npm, version: "10.9.7", sha256: sha("synthetic npm") } };
  const run = async spec => {
    calls.push(spec);
    if (spec.args.includes("ci")) {
      for (const [name, version] of [["@playwright/mcp", config.PLAYWRIGHT_VERSION], ["playwright", config.PLAYWRIGHT_ENGINE_VERSION], ["playwright-core", config.PLAYWRIGHT_ENGINE_VERSION]]) {
        const directory = join(spec.cwd, "node_modules", name);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(join(directory, "package.json"), JSON.stringify({ version }), { mode: 0o600 });
        await writeFile(join(directory, "cli.js"), "// Synthetic, never execute upstream code", { mode: 0o600 });
      }
    }
    const browser = join(spec.cwd, "browsers", "synthetic-chromium", "chrome");
    if (spec.args.includes("install")) {
      await mkdir(join(spec.cwd, "browsers", "synthetic-chromium"), { recursive: true, mode: 0o700 });
      await writeFile(browser, "synthetic browser, never execute", { mode: 0o700 });
    }
    return { exitCode: 0, stdout: spec.args[0] === "-e" ? browser : "", stderr: "" };
  };
  const probe = async options => { calls.push({ probe: options }); return { browserVersion: "synthetic-chromium", tools: [...config.PLAYWRIGHT_REQUIRED_TOOLS] }; };
  const dependencies = { paths, host: async () => host, run, probe, platform: async () => {}, ...changes };
  const runtime = new m.PlaywrightRuntime(dependencies);
  return { ...f, paths, host, calls, progress, run, probe, dependencies, runtime, ensure: signal => runtime.ensure(message => progress.push(message), signal) };
}
async function oldSelection(f) {
  const id = randomUUID(), version = "0.0.83", slot = join(f.paths.playwrightRuntimes, version, id);
  const record = { schema: 1, policy: 1, id, version, engineVersion: "older-pin", manifestSha256: "a".repeat(64), slot, ...f.host,
    entrypoint: join(slot, "node_modules", "@playwright", "mcp", "cli.js"), browser: join(slot, "browsers", "chrome"), browserVersion: "older-browser", tools: ["browser_snapshot"], validatedAt: new Date().toISOString() };
  await publishJson(f.paths.playwrightRoot, join(slot, "ready.json"), record);
  await publishJson(f.paths.playwrightRoot, f.paths.playwrightSelected, { schema: 1, id, version, slot });
  return record;
}

test("Playwright private assets pin reviewed MCP/engine graph with registry integrity", async () => {
  const assets = await m.playwrightAssets();
  const lock = JSON.parse(assets.lock), manifest = JSON.parse(assets.manifest);
  assert.equal(manifest.dependencies["@playwright/mcp"], "0.0.84");
  assert.equal(lock.packages["node_modules/playwright-core"].version, "1.65.0-alpha-2026-10-30");
  assert.equal(Object.keys(lock.packages).length, 4);
  assert.match(assets.sha256, /^[0-9a-f]{64}$/);
});
test("Playwright platform contract accepts only approved Linux matrix", () => {
  for (const arch of ["x64", "arm64"]) for (const [id, version] of [["debian", "12"], ["debian", "13"], ["ubuntu", "22.04"], ["ubuntu", "24.04"]]) m.validatePlaywrightPlatform("linux", arch, `ID=${id}\nVERSION_ID="${version}"\n`);
  for (const [platform, arch, release] of [["darwin", "arm64", "ID=debian\nVERSION_ID=13"], ["linux", "ia32", "ID=debian\nVERSION_ID=13"], ["linux", "x64", "ID=debian\nVERSION_ID=11"], ["linux", "x64", "ID=alpine\nVERSION_ID=3.22"]]) assert.throws(() => m.validatePlaywrightPlatform(platform, arch, release), /Unsupported/);
});
test("Playwright passive selection and unsupported-host failure create no managed roots", async t => {
  const f = await fixture(t, { platform: async () => { throw new Error("unsupported fixture"); } });
  assert.equal(await f.runtime.selected(), null);
  await assert.rejects(f.ensure(), /unsupported fixture/);
  await assert.rejects(access(f.paths.playwrightRoot), { code: "ENOENT" });
});
test("Playwright provisions permanent immutable slot, emits stages, and reuses matching ready runtime", async t => {
  const f = await fixture(t), ready = await f.ensure();
  assert.equal(ready.version, config.PLAYWRIGHT_VERSION); assert.equal(ready.engineVersion, config.PLAYWRIGHT_ENGINE_VERSION);
  assert.equal(ready.slot, join(f.paths.playwrightRuntimes, ready.version, ready.id));
  assert.equal(f.calls.filter(call => call.probe).length, 1);
  const install = f.calls.find(call => call.args?.includes("ci"));
  assert.ok(install.args.includes("--ignore-scripts")); assert.equal(install.cwd, ready.slot);
  assert.equal(install.env.HOME, join(ready.slot, "setup", "home")); assert.equal(install.env.NPM_CONFIG_CACHE, f.paths.playwrightNpmCache);
  assert.equal(install.env.NODE_OPTIONS, undefined); assert.equal(install.env.PLAYWRIGHT_SKIP_BROWSER_GC, "1");
  assert.ok(f.calls.find(call => call.args?.includes("install")).args.includes("--no-shell"));
  assert.ok(f.progress.some(value => value.includes("waiting"))); assert.ok(f.progress.some(value => value.includes("npm")));
  assert.ok(f.progress.some(value => value.includes("downloading"))); assert.ok(f.progress.some(value => value.includes("readiness"))); assert.match(f.progress.at(-1), /complete/);
  const count = f.calls.length; assert.equal((await f.ensure()).id, ready.id); assert.equal(f.calls.length, count);
  assert.equal((await f.runtime.selected()).id, ready.id);
  await assert.rejects(access(join(f.workspace, "package.json")), { code: "ENOENT" });
});
for (const stage of ["ci", "install", "probe"]) test(`Playwright ${stage} failure never publishes candidate or replaces prior selection`, async t => {
  let f;
  f = await fixture(t, { run: async spec => spec.args.includes(stage) ? { exitCode: 1, stdout: "", stderr: "synthetic failure" } : f.run(spec), probe: async () => { if (stage === "probe") throw new Error("sandbox unavailable"); return f.probe(); } });
  const previous = await oldSelection(f);
  await assert.rejects(f.ensure());
  assert.equal((await f.runtime.selected()).id, previous.id);
  const candidates = await readdir(join(f.paths.playwrightRuntimes, config.PLAYWRIGHT_VERSION)); assert.equal(candidates.length, 1);
  const failure = JSON.parse(await readFile(join(f.paths.playwrightRuntimes, config.PLAYWRIGHT_VERSION, candidates[0], "failed.json"), "utf8")); assert.equal(failure.stage, "preparation");
});
test("Playwright installed dependency mismatch fails before browser provisioning/readiness", async t => {
  let f;
  f = await fixture(t, { run: async spec => {
    const result = await f.run(spec);
    if (spec.args.includes("ci")) await writeFile(join(spec.cwd, "node_modules", "playwright-core", "package.json"), JSON.stringify({ version: "wrong" }));
    return result;
  } });
  await assert.rejects(f.ensure(), /dependency identity/);
  assert.equal(f.calls.some(call => call.args?.includes("install") || call.probe), false);
  assert.equal(await f.runtime.selected(), null);
});
test("Playwright unsafe browser path is rejected before readiness", async t => {
  let f;
  f = await fixture(t, { run: async spec => spec.args[0] === "-e" ? { exitCode: 0, stdout: "/external/chrome", stderr: "" } : f.run(spec) });
  await assert.rejects(f.ensure(), /escapes/); assert.equal(f.calls.some(call => call.probe), false);
});
test("Playwright missing selected browser and changed host identity fail without repairing active slot", async t => {
  const f = await fixture(t), record = await f.ensure();
  await writeFile(record.node.path, "changed host");
  await assert.rejects(f.ensure(), /host executable identity changed/);
  await writeFile(record.node.path, "synthetic node");
  const { rm } = await import("node:fs/promises"); await rm(record.browser);
  const calls = f.calls.length; await assert.rejects(f.ensure()); assert.equal(f.calls.length, calls);
  assert.equal((await f.runtime.selected()).id, record.id);
});
test("Playwright concurrent preparation rechecks selection under shared lock", async t => {
  const f = await fixture(t), other = new m.PlaywrightRuntime(f.dependencies);
  const [a, b] = await Promise.all([f.ensure(), other.ensure()]);
  assert.equal(a.id, b.id); assert.equal(f.calls.filter(call => call.args?.includes("ci")).length, 1);
});
test("Playwright active consumers defer new pin without executing older runtime or installer", async t => {
  const f = await fixture(t), previous = await oldSelection(f);
  const lease = await createConsumerLease(f.paths.playwrightConsumers, `runtime:${previous.id}`);
  try {
    await assert.rejects(f.ensure(), /live consumers/);
    assert.equal(f.calls.length, 0); assert.equal((await f.runtime.selected()).id, previous.id);
  } finally { await lease.release(); }
});
test("Playwright cancellation after readiness fences publication", async t => {
  const controller = new AbortController(); let f;
  f = await fixture(t, { probe: async () => { controller.abort(); return f.probe(); } });
  await assert.rejects(f.ensure(controller.signal)); assert.equal(await f.runtime.selected(), null);
});
test("Playwright selection precommit failure retains prior selection", async t => {
  let fail = false, f;
  f = await fixture(t, { publish: async (root, path, value) => { if (fail && path === f.paths.playwrightSelected) throw new Error("injected precommit failure"); await publishJson(root, path, value); } });
  const previous = await oldSelection(f); fail = true;
  await assert.rejects(f.ensure(), /precommit failure/); assert.equal((await f.runtime.selected()).id, previous.id);
});
test("Playwright postcommit failure restores prior pointer without moving candidate", async t => {
  let failed = false, f;
  f = await fixture(t, { publish: async (root, path, value) => {
    await publishJson(root, path, value);
    if (!failed && path === f.paths.playwrightSelected) { failed = true; throw new Error("injected postcommit failure"); }
  } });
  const previous = await oldSelection(f);
  await assert.rejects(f.ensure(), /postcommit failure/); assert.equal((await f.runtime.selected()).id, previous.id);
  assert.equal((await readdir(join(f.paths.playwrightRuntimes, config.PLAYWRIGHT_VERSION))).length, 1);
});
test("Playwright uncertain restoration retains explicit recovery and refuses later automatic repair", async t => {
  let count = 0, f;
  f = await fixture(t, { publish: async (root, path, value) => {
    if (path === f.paths.playwrightSelected) { count++; if (count === 1) await publishJson(root, path, value); throw new Error("injected publication/restoration failure"); }
    await publishJson(root, path, value);
  } });
  await oldSelection(f);
  await assert.rejects(f.ensure(), /recovery required/);
  const recovery = config.parsePlaywrightRecovery(JSON.parse(await readFile(join(f.paths.playwrightRoot, "recovery.json"), "utf8")));
  assert.equal(recovery.operation, "publication");
  const countBefore = f.calls.length; await assert.rejects(f.ensure(), /recovery required/); assert.equal(f.calls.length, countBefore);
});

test("Playwright uncertain preparation cleanup blocks later activation with recovery evidence", async t => {
  const f = await fixture(t, { probe: async () => { throw new Error("Playwright process-tree ownership uncertain"); } });
  await assert.rejects(f.ensure(), /ownership uncertain/);
  const marker = config.parsePlaywrightRecovery(JSON.parse(await readFile(join(f.paths.playwrightRoot, "recovery.json"), "utf8")));
  assert.equal(marker.operation, "cleanup");
  await assert.rejects(f.ensure(), /recovery required/);
  assert.equal(await f.runtime.selected(), null);
});
test("Playwright progress renderer failure cannot invalidate successful runtime publication", async t => {
  const f = await fixture(t);
  const record = await f.runtime.ensure(() => { throw new Error("UI already disposed"); });
  assert.equal((await f.runtime.selected()).id, record.id);
});
test("Playwright handshake/tool listing without browser readiness is not publishable", async t => {
  const f = await fixture(t, { probe: async () => ({ tools: ["browser_snapshot"] }) });
  await assert.rejects(f.ensure(), /Incomplete.*readiness/);
  assert.equal(await f.runtime.selected(), null);
});
for (const [nodeVersion, npmVersion, error] of [["21.9.0", "10.9.7", /Node/], ["22.18.0", "10.9.7", /Node/], ["22.19.0", "9.9.0", /npm/], ["22.19.0", "10.0.0", null], ["24.1.0", "11.0.0", null]]) test(`Playwright host prerequisite discovery: Node ${nodeVersion}, npm ${npmVersion}`, async t => {
  const f = await fixture(t), bin = join(f.root, "bin");
  await mkdir(bin, { mode: 0o700 });
  await symlink(f.host.node.path, join(bin, "node")); await symlink(f.host.npm.path, join(bin, "npm"));
  const previous = process.env.PATH; process.env.PATH = bin;
  try {
    const run = async spec => {
      assert.equal(spec.env.NODE_OPTIONS, undefined);
      assert.equal(spec.env.NPM_CONFIG_USERCONFIG, join(f.home, "npmrc"));
      if (spec.args[0] !== "-p") assert.deepEqual(spec.args.slice(1), ["--prefix", f.home, "--version"]);
      return { exitCode: 0, stdout: spec.args[0] === "-p" ? `node:${nodeVersion}\n` : `${npmVersion}\n`, stderr: "" };
    };
    const result = m.discoverPlaywrightHost({ home: f.home, cache: join(f.root, "cache"), tmp: join(f.root, "tmp") }, run);
    if (error) await assert.rejects(result, error);
    else { const host = await result; assert.equal(host.node.path, f.host.node.path); assert.equal(host.node.version, nodeVersion); assert.equal(host.npm.version, npmVersion); }
  } finally { process.env.PATH = previous; }
});
test("Playwright readiness diagnostics keep actionable sandbox hints without raw protocol/private text", async t => {
  const f = await fixture(t), slot = join(f.paths.playwrightRuntimes, config.PLAYWRIGHT_VERSION, randomUUID());
  await assert.rejects(m.probePlaywrightRuntime({ paths: f.paths, slot, host: f.host, browser: join(slot, "browsers", "synthetic", "chrome"), connect: async () => ({
    request: async () => ({ tools: config.PLAYWRIGHT_REQUIRED_TOOLS.map(name => ({ name })) }),
    call: async () => { throw new Error("Synthetic launch failure", { cause: { content: [{ type: "text", text: "Failed to move to new namespace: Operation not permitted\nsynthetic-private-value-must-not-log" }] } }); }, close: async () => {},
  }) }), error => { assert.match(error.message, /Operation not permitted/); assert.doesNotMatch(error.message, /synthetic-private-value/); return true; });
});
for (const failure of [null, "tools", "snapshot", "evaluate", "screenshot"]) test(`Playwright readiness probe checks protocol/DOM/browser/image contract: ${failure ?? "success"}`, async t => {
  const f = await fixture(t), slot = join(f.paths.playwrightRuntimes, config.PLAYWRIGHT_VERSION, randomUUID());
  const browser = join(slot, "browsers", "synthetic", "chrome"), calls = [];
  let closed = 0;
  const options = { paths: f.paths, slot, host: f.host, browser, connect: async spec => {
    assert.equal(spec.env.HOME, join(slot, "probe", "home"));
    const effective = JSON.parse(await readFile(JSON.parse(spec.args[1]).args[2], "utf8"));
    assert.equal(effective.browser.launchOptions.chromiumSandbox, true); assert.equal(effective.webmcp, false);
    return {
      request: async () => ({ tools: (failure === "tools" ? ["browser_snapshot"] : [...config.PLAYWRIGHT_REQUIRED_TOOLS]).map(name => ({ name })) }),
      call: async name => {
        calls.push(name);
        if (name === "browser_snapshot") return { content: [{ type: "text", text: failure === "snapshot" ? "wrong page" : "Workbench readiness" }] };
        if (name === "browser_evaluate") return { content: [{ type: "text", text: failure === "evaluate" ? "wrong browser" : "HeadlessChrome/150.0.1.2" }] };
        if (name === "browser_take_screenshot") return { content: failure === "screenshot" ? [] : [{ type: "image", mimeType: "image/png", data: "synthetic" }] };
        return { content: [] };
      }, close: async () => { closed++; },
    };
  } };
  if (failure) await assert.rejects(m.probePlaywrightRuntime(options), /Sandboxed Chromium readiness failed/);
  else { const result = await m.probePlaywrightRuntime(options); assert.equal(result.browserVersion, "150.0.1.2"); assert.ok(calls.includes("browser_close")); }
  assert.equal(closed, 1);
});
