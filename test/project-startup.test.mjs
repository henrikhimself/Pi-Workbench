import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { default: extension } = await jiti.import("../src/index.ts");
const { resolveWorkbenchPaths } = await jiti.import("../src/paths.ts");
const { MemoryManager } = await jiti.import("../src/memory-manager.ts");
const { STORE_MARKER } = await jiti.import("../src/store-identity.ts");
const { compressionOptedIn, resolveCompressionProject, setCompressionOptIn } = await jiti.import("../src/headroom-project.ts");

async function wait(condition) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for fixture state");
}
function session(paths, cwd, overrides = {}) {
  const handlers = new Map(), commands = new Map(), statuses = [], notices = [], calls = { start: 0, resume: 0, health: 0, stop: 0 };
  const proxy = { isManaged: true,
    resume: async () => { calls.resume++; },
    ensureRunning: async () => { calls.start++; return true; },
    healthCheck: async () => { calls.health++; return true; },
    stop: async () => { calls.stop++; }, tryRestart: async () => false, ...overrides };
  const pi = { on: (name, handler) => handlers.set(name, handler), registerCommand: (name, command) => commands.set(name, command),
    getActiveTools: () => [], appendEntry() {}, registerMcpServer() { assert.fail("fixture must not start real MCP"); }, unregisterMcpServer() {} };
  const ctx = { cwd, model: { id: "fixture" }, sessionManager: { getBranch: () => [] },
    ui: { setStatus: (...args) => statuses.push(args), notify: (message, level) => notices.push({ message, level }) } };
  extension(pi, { workbenchPaths: paths, proxyManager: proxy });
  return { ctx, calls, notices, statuses, handlers, commands,
    start: () => handlers.get("session_start")({}, ctx),
    command: action => commands.get("wb:headroom-proxy").handler(action, ctx),
    close: () => handlers.get("session_shutdown")() };
}
async function fixture(action) {
  const home = await mkdtemp(join(tmpdir(), "wb-project-startup-")), sessions = [];
  const paths = resolveWorkbenchPaths(home);
  try { await action({ home, paths, make: (cwd = home, overrides) => { const s = session(paths, cwd, overrides); sessions.push(s); return s; } }); }
  finally { for (const s of sessions) await s.close(); await rm(home, { recursive: true, force: true }); }
}

test("opted-out startup never prepares Memory or compression, creates config, or warns on symlinked root", async () => fixture(async ({ home, paths, make }) => {
  const target = join(home, "owned-target"); await mkdir(target);
  await mkdir(dirname(paths.root), { recursive: true }); await symlink(target, paths.root, "dir");
  const original = MemoryManager.prototype.ensureRoot;
  let memoryRoots = 0;
  MemoryManager.prototype.ensureRoot = async () => { memoryRoots++; throw new Error("must not prepare off Memory root"); };
  try {
    const s = make(); await s.start(); await new Promise(resolve => setTimeout(resolve, 40));
    const event = { messages: [{ role: "user", content: "keep original", timestamp: 1 }] };
    assert.equal(await s.handlers.get("context")(event, s.ctx), undefined);
    assert.equal(memoryRoots, 0, "off Memory must be gated before ensureRoot");
    assert.equal(s.calls.start, 0, "off compression must not start proxy");
    assert.equal(s.calls.resume, 0); assert.equal(s.calls.health, 0);
    assert.equal(existsSync(paths.headroomConfig), false, "off startup must not create configuration");
    assert.equal(existsSync(paths.headroomRoot), false);
    assert.deepEqual(s.notices, [], "off features must not emit Headroom root/runtime warnings");
  } finally { MemoryManager.prototype.ensureRoot = original; }
}));

test("Memory store opt-in still validates root and warns independently of off compression", async () => fixture(async ({ home, paths, make }) => {
  const manager = new MemoryManager({ cwd: home, defaultRoot: paths.headroomMemory });
  await mkdir(manager.store.directory, { recursive: true, mode: 0o700 });
  await writeFile(manager.store.databasePath, "fixture"); await writeFile(join(manager.store.directory, STORE_MARKER), "{}");
  const original = MemoryManager.prototype.ensureRoot;
  let checks = 0;
  MemoryManager.prototype.ensureRoot = async () => { checks++; throw new Error("fixture unsafe opted-in root"); };
  try {
    const s = make(); await s.start(); await wait(() => s.notices.length);
    assert.equal(checks, 1);
    assert.ok(s.notices.some(item => item.message.includes("Headroom Memory root unavailable: fixture unsafe opted-in root")));
    assert.equal(s.calls.start, 0);
  } finally { MemoryManager.prototype.ensureRoot = original; }
}));

test("compression commands persist project choice; restart restores it, other projects stay off, peers stay active", async () => fixture(async ({ home, paths, make }) => {
  const project = resolveCompressionProject(home, paths);
  const first = make(); await first.start(); await first.command("on");
  assert.equal(first.calls.start, 1);
  assert.equal(await compressionOptedIn(project), true);
  assert.equal(existsSync(paths.headroomConfig), true);
  const peer = make(); await peer.start(); await wait(() => peer.calls.start === 1);
  const other = make(join(home, "other")); await other.start(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(other.calls.start, 0, "another project must not inherit compression");
  await first.command("off");
  assert.equal(await compressionOptedIn(project), false);
  assert.equal(peer.calls.stop, 0, "off must not stop already-active peer");
  const restart = make(); await restart.start(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(restart.calls.start, 0, "off persists across sessions");
  assert.ok(first.notices.some(item => item.message === "Headroom compression disabled for this project"));
  await first.command("off");
  assert.ok(first.notices.some(item => item.message === "Headroom compression already off for this project"), "a second off has nothing to do");
}));

test("X-2b: unknown proxy arguments print usage and change nothing", async () => fixture(async ({ home, paths, make }) => {
  const s = make(); await s.start(); await s.command("on");
  for (const args of ["off now", "foo"]) {
    const before = s.notices.length;
    await s.command(args);
    assert.deepEqual(s.notices.slice(before), [{ message: "Usage: /wb:headroom-proxy [on|off|status]", level: "error" }], args);
  }
  assert.equal(await compressionOptedIn(resolveCompressionProject(home, paths)), true);
  assert.equal(s.calls.stop, 0);
}));

test("failed compression activation retains explicit opt-in for later startup retry", async () => fixture(async ({ home, paths, make }) => {
  const s = make(home, { ensureRunning: async () => false });
  await s.start(); await s.command("on");
  assert.equal(await compressionOptedIn(resolveCompressionProject(home, paths)), true);
  assert.ok(s.notices.some(item => item.message.includes("project opt-in retained")));
  const retry = make(); await retry.start(); await wait(() => retry.calls.start === 1);
}));

test("explicit compression on still rejects symlinked root without creating config or starting backend", async () => fixture(async ({ home, paths, make }) => {
  const target = join(home, "owned-target"); await mkdir(target);
  await mkdir(dirname(paths.root), { recursive: true }); await symlink(target, paths.root, "dir");
  const s = make(); await s.start(); await s.command("on");
  assert.equal(s.calls.start, 0); assert.equal(existsSync(paths.headroomConfig), false);
  assert.ok(s.notices.some(item => item.message.includes("Symlink in managed path")));
}));

test("failed project opt-out disables this session but preserves unsafe marker and reports unsaved choice", async () => fixture(async ({ home, paths, make }) => {
  const s = make(); await s.start(); await s.command("on");
  const project = resolveCompressionProject(home, paths), before = await readFile(project.optInPath, "utf8");
  await chmod(project.optInPath, 0o644);
  await s.command("off");
  assert.equal(await readFile(project.optInPath, "utf8"), before);
  assert.ok(s.notices.some(item => item.message.includes("project opt-out could not be saved")));
  assert.equal(await s.handlers.get("context")({ messages: [] }, s.ctx), undefined);
}));

test("explicit off fences pending startup and late compression readiness", async () => fixture(async ({ home, paths, make }) => {
  await setCompressionOptIn(resolveCompressionProject(home, paths), true);
  const fast = make();
  const startup = fast.start(), off = fast.command("off");
  await Promise.all([startup, off]); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(fast.calls.start, 0, "off must win pending startup opt-in read");
  await setCompressionOptIn(resolveCompressionProject(home, paths), true);
  let finish, started = false;
  const waiting = new Promise(resolve => { finish = resolve; });
  const slow = make(home, { ensureRunning: async () => { started = true; return waiting; } });
  try {
    await slow.start(); await wait(() => started); await slow.command("off");
    const count = slow.statuses.length; finish(true); await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(slow.statuses.length, count, "late readiness must not revive disabled compression");
    assert.equal(await compressionOptedIn(resolveCompressionProject(home, paths)), false);
  } finally { finish(false); }
}));

test("off fences in-flight compressed output without replacing original context", async () => fixture(async ({ home, make }) => {
  let finish, requested = false;
  const pending = new Promise(resolve => { finish = resolve; });
  const s = make(home, { requestOwned: async () => { requested = true; return pending; } });
  await s.start(); await s.command("on");
  const event = { messages: [{ role: "user", content: "keep original context", timestamp: 1 }] };
  const compression = s.handlers.get("context")(event, s.ctx);
  try {
    await wait(() => requested); await s.command("off"); const count = s.statuses.length;
    finish({ messages: [{ role: "user", content: "compressed" }], compressed: true, tokens_before: 100, tokens_after: 10,
      tokens_saved: 90, compression_ratio: 0.1, transforms_applied: ["fixture"], ccr_hashes: [] });
    assert.equal(await compression, undefined);
    assert.equal(s.statuses.length, count);
    assert.equal(event.messages[0].content, "keep original context");
  } finally { finish({ compressed: false }); await compression; }
}));
