import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { ManagedHeadroomRuntime } = await jiti.import("../src/headroom-runtime.ts");
const { resolveWorkbenchPaths } = await jiti.import("../src/paths.ts");
const { createConsumerLease, publishJson } = await jiti.import("../src/managed-lifecycle.ts");
async function fixture(fn) {
  const home = await mkdtemp(join(tmpdir(), "wb-headroom-slots-")); const paths = resolveWorkbenchPaths(home);
  const calls = [], messages = []; const state = { badDependency: false, tamper: false, failInstall: false, pip: "24.0" };
  const run = async (command, args, options) => {
    calls.push({ command, args, env: options.env });
    if (args.includes("venv")) {
      const slot = args.at(-1), bin = join(slot, process.platform === "win32" ? "Scripts" : "bin");
      await mkdir(bin, { recursive: true });
      for (const name of process.platform === "win32" ? ["python.exe", "headroom.exe"] : ["python", "headroom"]) await writeFile(join(bin, name), "fixture", { mode: 0o700 });
      return "";
    }
    if (args.includes("--version")) return `pip ${state.pip} from /slot/lib/python3/site-packages/pip (python 3)`;
    const version = command.includes("/runtimes/") ? command.split("/runtimes/")[1].split("/")[0] : "0.41.0";
    if (args.includes("--report")) {
      const install = [{ metadata: { name: "headroom-ai", version }, download_info: { archive_info: { hashes: { sha256: "a".repeat(64) } } } }];
      install.push({ ...install[0], metadata: { name: "cryptography", version: "50.0.2" } });
      if (state.badDependency) install.push({ ...install[0], metadata: { name: "torch", version: "9.0" } });
      await writeFile(args[args.indexOf("--report") + 1], JSON.stringify({ install })); return "";
    }
    if (args.includes("pip")) { if (state.failInstall) { await state.beforeFail?.(command); throw new Error("injected pip failure"); } return ""; }
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
  assert.equal(fx.calls.filter(c => c.args.includes("pip") && !c.args.includes("--dry-run") && !c.args.includes("--version")).length, 1);
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


test("a different pin, older or newer, installs its own runtime in a new slot and leaves the old slot untouched", () => fixture(async (fx) => {
  const newer = fx.make({ requiredVersion: "0.42.0" }); const first = await newer.ensure(() => {});
  assert.ok(first); assert.equal(first.version, "0.42.0");
  const venvs = fx.calls.filter(c => c.args.includes("venv")).length;
  const older = await fx.make().ensure(message => fx.messages.push(message));
  assert.ok(older, fx.messages.join("\n")); assert.equal(older.version, "0.41.0");
  assert.notEqual(older.slot, first.slot);
  assert.equal(fx.calls.filter(c => c.args.includes("venv")).length, venvs + 1, "exactly one new slot was built");
  assert.equal(await readFile(first.python, "utf8"), "fixture", "old slot untouched");
  assert.equal((await newer.inspect()).version, "0.41.0", "selection now names the pinned runtime");
  const backups = (await readdir(newer.root)).filter(name => name.startsWith("selected.backup-"));
  assert.equal(backups.length, 1);
  assert.equal(JSON.parse(await readFile(join(newer.root, backups[0]), "utf8")).slot, first.slot, "previous selection retained");
}));

test("a runtime selection or descriptor with the old schema key is refused and left unchanged", () => fixture(async (fx) => {
  const first = await fx.make().ensure(() => {}); assert.ok(first);
  const oldKey = ({ schemaVersion, ...rest }) => ({ schema: schemaVersion, ...rest });
  // selected.json is parsed (version message); ready.json is only compared with it, so it fails as a mismatch.
  for (const [file, expected] of [[join(fx.paths.headroomRoot, "selected.json"), /schemaVersion must be 1/], [join(first.slot, "ready.json"), /readiness identity mismatch/]]) {
    const original = await readFile(file, "utf8"); assert.equal(JSON.parse(original).schemaVersion, 1, file);
    const legacy = JSON.stringify(oldKey(JSON.parse(original))); await writeFile(file, legacy);
    const messages = []; assert.equal(await fx.make().ensure(message => messages.push(message)), null, file);
    assert.match(messages.join("\n"), expected, file);
    assert.equal(await readFile(file, "utf8"), legacy); await writeFile(file, original);
  }
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
  await writeFile(join(selected.slot, "ready.json"), JSON.stringify({ ...selected, schemaVersion: 99 }));
  assert.equal(await runtime.ensure(message => fx.messages.push(message)), null);
  assert.match(fx.messages.join("\n"), /readiness identity mismatch/);
  assert.equal(await readFile(runtime.selectionPath, "utf8"), original);
  assert.equal(fx.calls.length, count);
}));

test("runtime environment passes lowercase proxy variables and still no arbitrary HEADROOM_* tuning", () => fixture(async (fx) => {
  const runtime = fx.make();
  const env = runtime.environment({
    PATH: "/bin", http_proxy: "http://proxy:3128", https_proxy: "http://proxy:3128", no_proxy: "localhost",
    HTTP_PROXY: "http://upper:1", HEADROOM_COMPRESSION_TIMEOUT_SECONDS: "999", HEADROOM_BACKGROUND_COMPRESSION: "1",
  });
  assert.equal(env.http_proxy, "http://proxy:3128"); assert.equal(env.https_proxy, "http://proxy:3128");
  assert.equal(env.no_proxy, "localhost"); assert.equal(env.HTTP_PROXY, "http://upper:1");
  assert.equal(env.HEADROOM_COMPRESSION_TIMEOUT_SECONDS, undefined, "tuning comes only from validated headroom.json");
  assert.equal(env.HEADROOM_BACKGROUND_COMPRESSION, undefined);
}));

test("S2: a slot/digest verified once is not re-verified by later ensure() calls in the same process", () => fixture(async (fx) => {
  const checks = () => fx.calls.filter(c => c.args[1]?.includes("distributions")).length;
  const runtime = fx.make();
  assert.ok(await runtime.ensure(() => {}));
  const afterInstall = checks();
  assert.ok(await runtime.ensure(() => {}));
  const afterFirstReuse = checks();
  assert.equal(afterFirstReuse, afterInstall + 1, "first reuse verifies the installed slot");
  for (let i = 0; i < 3; i++) assert.ok(await fx.make().ensure(() => {}));
  assert.equal(checks(), afterFirstReuse, "later calls, even from another runtime object, skip the Python check");
}));

const slotNames = async fx => (await readdir(join(fx.paths.headroomRoot, "runtimes", "0.41.0")).catch(() => []));

test("LB-01 M17: a venv whose pip is older than 22.2 is refused with both versions and leaves no slot", () => fixture(async (fx) => {
  fx.state.pip = "22.0.2";
  assert.equal(await fx.make().ensure(message => fx.messages.push(message)), null);
  assert.match(fx.messages.join("\n"), /pip 22\.0\.2, but pip 22\.2 or newer is required/);
  assert.ok(fx.calls.every(call => !call.args.includes("--dry-run")), "the dry run is never attempted");
  assert.deepEqual(await slotNames(fx), []);
  fx.state.pip = "22.2";
  assert.ok(await fx.make().ensure(() => {}), "pip 22.2 is accepted");
}));

test("LB-01 L11: a failing install step removes its slot, and a successful install keeps its slot", () => fixture(async (fx) => {
  fx.state.failInstall = true;
  assert.equal(await fx.make().ensure(message => fx.messages.push(message)), null);
  assert.match(fx.messages.join("\n"), /injected pip failure/);
  assert.deepEqual(await slotNames(fx), []);
  fx.state.failInstall = false;
  const ok = await fx.make().ensure(() => {}); assert.ok(ok);
  assert.equal((await slotNames(fx)).length, 1);
  assert.equal(await readFile(ok.python, "utf8"), "fixture");
}));


test("LB-01 L11: a slot whose candidate was published is kept even if the publish call then throws", () => fixture(async (fx) => {
  const runtime = fx.make({ publish: async (root, path, value) => {
    await publishJson(root, path, value);
    if (/candidate-/.test(path)) throw new Error("injected failure after the candidate was written");
  } });
  assert.equal(await runtime.ensure(message => fx.messages.push(message)), null);
  assert.match(fx.messages.join("\n"), /injected failure after the candidate/);
  assert.equal((await slotNames(fx)).length, 1, "the published candidate still has its slot");
}));

test("LB-01 L11: an error from the slot cleanup does not replace the install error", { skip: process.getuid?.() === 0 }, () => fixture(async (fx) => {
  const parent = join(fx.paths.headroomRoot, "runtimes", "0.41.0");
  fx.state.failInstall = true;
  fx.state.beforeFail = async () => { await chmod(parent, 0o500); };
  try {
    assert.equal(await fx.make().ensure(message => fx.messages.push(message)), null);
    assert.match(fx.messages.join("\n"), /injected pip failure/);
    assert.doesNotMatch(fx.messages.join("\n"), /EACCES|EPERM/);
    assert.equal((await readdir(parent)).length, 1, "the cleanup really failed, leaving the slot");
  } finally { await chmod(parent, 0o700); }
}));
