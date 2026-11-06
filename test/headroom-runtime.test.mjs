import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { ManagedHeadroomRuntime } = await jiti.import("../src/headroom-runtime.ts");
const { resolveWorkbenchPaths } = await jiti.import("../src/paths.ts");
const { createConsumerLease, publishJson } = await jiti.import("../src/managed-lifecycle.ts");
async function fixture(fn) {
  const home = await mkdtemp(join(tmpdir(), "wb-headroom-slots-")); const paths = resolveWorkbenchPaths(home);
  const calls = [], messages = []; const state = { badDependency: false, tamper: false, failInstall: false };
  const run = async (command, args, options) => {
    calls.push({ command, args, env: options.env });
    if (args.includes("venv")) {
      const slot = args.at(-1), bin = join(slot, process.platform === "win32" ? "Scripts" : "bin");
      await mkdir(bin, { recursive: true });
      for (const name of process.platform === "win32" ? ["python.exe", "headroom.exe"] : ["python", "headroom"]) await writeFile(join(bin, name), "fixture", { mode: 0o700 });
      return "";
    }
    const version = command.includes("/runtimes/") ? command.split("/runtimes/")[1].split("/")[0] : "0.41.0";
    if (args.includes("--report")) {
      const install = [{ metadata: { name: "headroom-ai", version }, download_info: { archive_info: { hashes: { sha256: "a".repeat(64) } } } }];
      install.push({ ...install[0], metadata: { name: "cryptography", version: "50.0.2" } });
      if (state.badDependency) install.push({ ...install[0], metadata: { name: "torch", version: "9.0" } });
      await writeFile(args[args.indexOf("--report") + 1], JSON.stringify({ install })); return "";
    }
    if (args.includes("pip")) { if (state.failInstall) throw new Error("injected pip failure"); return ""; }
    if (args[1]?.includes("distributions")) return JSON.stringify({ version, transport: "50.0.2",
      inventory: [{ name: "headroom-ai", version }, { name: "onnxruntime", version: state.tamper ? "changed" : "1.31.1" }] });
    return "Python 3.13 fixture|Linux AMD64";
  };
  const make = options => new ManagedHeadroomRuntime({ paths, run, systemPython: async () => "system-python", ...options });
  try { await fn({ home, paths, calls, state, messages, make }); }
  finally { await rm(home, { recursive: true, force: true }); }
}

test("shared runtime prepares one immutable permanent slot and reuses without pip mutation", () => fixture(async (fx) => {
  const runtime = fx.make();
  const one = await runtime.ensure(message => fx.messages.push(message)); assert.ok(one, fx.messages.join("\n"));
  const two = await runtime.ensure(message => fx.messages.push(message));
  assert.deepEqual(one, two); assert.ok(one.slot.startsWith(join(fx.paths.root, "headroom", "runtimes")));
  assert.equal(fx.calls.filter(c => c.args.includes("venv")).length, 1);
  assert.equal(fx.calls.filter(c => c.args.includes("pip") && !c.args.includes("--dry-run")).length, 1);
  assert.ok(fx.calls.some(c => c.args.includes("--copies")), "entrypoint paths are never relocated");
  assert.ok(fx.calls.some(c => c.args.includes("--require-hashes")));
  assert.equal(one.embedding.provider, "CPUExecutionProvider");
}));

test("runtime ignores pre-refactor installation files and inherited state/embedding overrides", () => fixture(async (fx) => {
  const oldVenv = join(fx.paths.root, "headroom-venv");
  await mkdir(oldVenv, { recursive: true }); const sentinel = join(oldVenv, "sentinel"); await writeFile(sentinel, "untouched");
  const runtime = fx.make(); const descriptor = await runtime.ensure(() => {}); assert.ok(descriptor);
  assert.equal(await readFile(sentinel, "utf8"), "untouched");
  assert.ok(fx.calls.every(c => c.command !== oldVenv && !c.args.includes(oldVenv)));
  const env = runtime.environment({ PATH: "/bin", PYTHONPATH: "/untrusted", HEADROOM_CCR_SQLITE_PATH: "/external/data", HEADROOM_WORKSPACE_DIR: "/elsewhere", HEADROOM_EMBEDDER_RUNTIME: "torch", HEADROOM_OFFLINE: "1", OPENAI_API_KEY: "not-for-compression" });
  assert.equal(env.HEADROOM_WORKSPACE_DIR, join(runtime.root, "proxy-state"));
  assert.equal(env.HEADROOM_CCR_SQLITE_PATH, join(runtime.root, "proxy-state", "ccr_store.db"));
  assert.equal(env.PYTHONPATH, undefined); assert.equal(env.HEADROOM_EMBEDDER_RUNTIME, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.HEADROOM_OFFLINE, "1");
}));

test("forbidden dependency is rejected before installation or publication", () => fixture(async (fx) => {
  fx.state.badDependency = true; const runtime = fx.make();
  assert.equal(await runtime.ensure(message => fx.messages.push(message)), null);
  assert.match(fx.messages.join("\n"), /Unapproved\/unhashed runtime dependency: torch/);
  assert.equal(fx.calls.some(c => c.args.includes("--require-hashes")), false);
  assert.equal(await runtime.inspect(), null);
}));

test("inventory tampering never repairs a live immutable slot with pip", () => fixture(async (fx) => {
  const runtime = fx.make(); const old = await runtime.ensure(() => {}); assert.ok(old);
  const before = await readFile(runtime.selectionPath, "utf8"); const count = fx.calls.length;
  fx.state.tamper = true;
  assert.equal(await runtime.ensure(message => fx.messages.push(message)), null);
  assert.match(fx.messages.join("\n"), /inventory changed/);
  assert.equal(await readFile(runtime.selectionPath, "utf8"), before);
  assert.ok(fx.calls.slice(count).every(c => !c.args.includes("pip")));
}));

test("future generation waits for consumers then publishes without moving either venv", () => fixture(async (fx) => {
  const old = await fx.make().ensure(() => {}); assert.ok(old);
  const next = fx.make({ requiredVersion: "0.42.0" });
  const lease = await createConsumerLease(next.leaseRoot, "proxy");
  try {
    assert.equal(await next.ensure(message => fx.messages.push(message)), null);
    assert.match(fx.messages.join("\n"), /consumers still use prior selection/);
    assert.equal((await next.inspect()).version, "0.41.0");
  } finally { await lease.release(); }
  const installs = fx.calls.filter(c => c.args.includes("venv")).length;
  const selected = await next.ensure(() => {}); assert.equal(selected.version, "0.42.0");
  assert.equal(fx.calls.filter(c => c.args.includes("venv")).length, installs, "ready candidate reused after deferral");
  assert.equal(await readFile(old.python, "utf8"), "fixture");
  assert.ok((await readdir(next.root)).some(name => name.startsWith("selected.backup-")));
}));

test("failed selection publication preserves prior metadata and ready runtime for retry", () => fixture(async (fx) => {
  const first = fx.make(); const old = await first.ensure(() => {}); assert.ok(old);
  const before = await readFile(first.selectionPath, "utf8");
  const next = fx.make({ requiredVersion: "0.42.0", publish: async (root, path, value) => {
    if (path === first.selectionPath) throw new Error("injected selection failure");
    await publishJson(root, path, value);
  } });
  assert.equal(await next.ensure(message => fx.messages.push(message)), null);
  assert.equal(await readFile(first.selectionPath, "utf8"), before);
  assert.equal(await readFile(old.python, "utf8"), "fixture");
  const retried = await fx.make({ requiredVersion: "0.42.0" }).ensure(() => {}); assert.equal(retried.version, "0.42.0");
}));


test("manual extension downgrade cannot select an older runtime automatically", () => fixture(async (fx) => {
  const newer = fx.make({ requiredVersion: "0.42.0" }); const selected = await newer.ensure(() => {});
  assert.ok(selected);
  const bytes = await readFile(newer.selectionPath, "utf8"), count = fx.calls.length;
  assert.equal(await fx.make().ensure(message => fx.messages.push(message)), null);
  assert.match(fx.messages.join("\n"), /Automatic runtime downgrade refused/);
  assert.equal(await readFile(newer.selectionPath, "utf8"), bytes);
  assert.equal(fx.calls.length, count, "no old interpreter installation/execution");
}));

test("failed hashed install preserves previous selection and immutable slot", () => fixture(async (fx) => {
  const previous = await fx.make().ensure(() => {}); assert.ok(previous);
  const bytes = await readFile(join(fx.paths.headroomRoot, "selected.json"), "utf8");
  fx.state.failInstall = true;
  assert.equal(await fx.make({ requiredVersion: "0.42.0" }).ensure(message => fx.messages.push(message)), null);
  assert.match(fx.messages.join("\n"), /injected pip failure/);
  assert.equal(await readFile(join(fx.paths.headroomRoot, "selected.json"), "utf8"), bytes);
  assert.equal(await readFile(previous.python, "utf8"), "fixture");
}));


test("post-rename selection failure restores prior pointer before later activation", () => fixture(async (fx) => {
  const previous = await fx.make().ensure(() => {}); const original = await readFile(join(fx.paths.headroomRoot, "selected.json"), "utf8");
  const next = fx.make({ requiredVersion: "0.42.0", publish: async (root, path, value) => {
    await publishJson(root, path, value);
    if (path.endsWith("/selected.json") && value.version === "0.42.0") throw new Error("injected post-rename sync failure");
  } });
  assert.equal(await next.ensure(message => fx.messages.push(message)), null);
  assert.match(fx.messages.join("\n"), /original selection restored/);
  assert.equal(await readFile(next.selectionPath, "utf8"), original);
  assert.equal(await readFile(previous.python, "utf8"), "fixture");
  assert.equal((await fx.make({ requiredVersion: "0.42.0" }).ensure(() => {})).version, "0.42.0");
}));

test("failed pointer restoration retains recovery intent and blocks apparently valid selection", () => fixture(async (fx) => {
  const previous = await fx.make().ensure(() => {}); let activated = false;
  const next = fx.make({ requiredVersion: "0.42.0", publish: async (root, path, value) => {
    if (path.endsWith("/selected.json") && activated) throw new Error("injected pointer restore failure");
    await publishJson(root, path, value);
    if (path.endsWith("/selected.json")) { activated = true; throw new Error("injected post-rename failure"); }
  } });
  assert.equal(await next.ensure(message => fx.messages.push(message)), null);
  assert.match(fx.messages.join("\n"), /publication\/restoration uncertain/);
  const intent = JSON.parse(await readFile(join(next.root, "selection.pending.json"), "utf8"));
  assert.equal(intent.previous.slot, previous.slot);
  const count = fx.calls.length;
  assert.equal(await fx.make({ requiredVersion: "0.42.0" }).ensure(message => fx.messages.push(message)), null);
  assert.match(fx.messages.join("\n"), /Incomplete runtime publication/);
  assert.equal(fx.calls.length, count, "no backend may run while recovery is uncertain");
}));

test("invalid saved readiness cannot be overwritten by fresh installation", () => fixture(async (fx) => {
  const runtime = fx.make(), selected = await runtime.ensure(() => {});
  const original = await readFile(runtime.selectionPath, "utf8"), count = fx.calls.length;
  await writeFile(join(selected.slot, "ready.json"), JSON.stringify({ ...selected, schema: 99 }));
  assert.equal(await runtime.ensure(message => fx.messages.push(message)), null);
  assert.match(fx.messages.join("\n"), /readiness identity mismatch/);
  assert.equal(await readFile(runtime.selectionPath, "utf8"), original);
  assert.equal(fx.calls.length, count);
}));
