/**
 * Regression tests for extension-level context behavior.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, open, rm, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const fixtureHomes = [], fixtureShutdowns = [];
afterEach(async () => {
  for (const shutdown of fixtureShutdowns.splice(0)) await shutdown();
  for (const home of fixtureHomes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function installExtension(mod, pi, options = {}) {
  const home = await mkdtemp(join(tmpdir(), "wb-index-isolated-")); fixtureHomes.push(home);
  const { resolveWorkbenchPaths } = await jiti.import("../src/paths.ts");
  const paths = resolveWorkbenchPaths(home);
  const { probeHealth = false, ...extensionOptions } = options;
  const configPath = options.headroomConfigPath ?? paths.headroomConfig;
  if (!options.headroomConfigPath) {
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, port: 8787 }));
  }
  const proxyManager = {
    isManaged: true, baseUrl: "http://127.0.0.1:8787",
    resume() {}, stop: async () => {}, ensureRunning: async () => true, tryRestart: async () => false,
    requestOwned: async (path, body, method) => {
      const response = await globalThis.fetch("http://127.0.0.1:8787" + path, { method, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    },
    healthCheck: async () => {
      if (!probeHealth) return true;
      try {
        const response = await globalThis.fetch("http://127.0.0.1:8787/health");
        return response.ok && (await response.json()).version === "0.41.0";
      } catch { return false; }
    },
  };
  const commands = new Map(), handlers = new Map();
  mod.default({ ...pi,
    on: (name, handler) => { handlers.set(name, handler); return pi.on?.(name, handler); },
    registerCommand: (name, command) => { commands.set(name, command); pi.registerCommand?.(name, command); },
  }, { workbenchPaths: paths, headroomConfigPath: configPath, proxyManager, ...extensionOptions });
  fixtureShutdowns.push(() => handlers.get("session_shutdown")());
  // Compression-specific tests explicitly opt their isolated workspace in.
  await commands.get("wb:headroom-proxy").handler("on", { cwd: home, ui: { setStatus() {}, notify() {} } });
  return { commands, home, paths };
}

test("context: compression failure marks proxy offline instead of accepting an SDK fallback", async () => {
  const originalFetch = globalThis.fetch;
  const tempDir = await mkdtemp(join(tmpdir(), "pi-headroom-offline-config-"));
  const configPath = join(tempDir, "headroom.json");
  let fetchCalls = 0;

  try {
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, port: 8787 }));
    globalThis.fetch = async () => {
      fetchCalls++;
      throw new Error("connection refused");
    };

    const handlers = new Map();
    const pi = {
      on(event, handler) {
        handlers.set(event, handler);
        return () => {};
      },
      registerCommand() {},
    };

    const mod = await jiti.import("../src/index.ts");
    await installExtension(mod, pi, { headroomConfigPath: configPath, probeHealth: true });

    const statuses = [];
    const statusKeys = [];
    const notifications = [];
    const ctx = {
      model: { id: "test-model" },
      ui: {
        theme: { fg: (_color, value) => value },
        setStatus: (key, value) => {
          statusKeys.push(key);
          statuses.push(value);
        },
        notify: (message, level) => notifications.push({ message, level }),
      },
    };
    const event = {
      messages: [{ role: "user", content: "compress me", timestamp: 1 }],
    };
    const contextHandler = handlers.get("context");

    assert.equal(await contextHandler(event, ctx), undefined);
    assert.ok(fetchCalls > 0, "expected Headroom client to attempt compression");
    assert.ok(
      notifications.some(({ message, level }) => level === "warning" && message.includes("Headroom proxy unavailable")),
    );
    assert.ok(statuses.some((status) => status?.includes("Headroom offline")));
    assert.ok(statusKeys.includes("headroom-proxy"));
    assert.equal(statusKeys.includes("headroom"), false);

    const callsAfterFailure = fetchCalls;
    assert.equal(await contextHandler(event, ctx), undefined);
    assert.equal(fetchCalls, callsAfterFailure, "offline proxy should not be retried each turn");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("context: version-mismatched managed proxy remains fail-open", async () => {
  const originalFetch = globalThis.fetch;
  const tempDir = await mkdtemp(join(tmpdir(), "pi-headroom-mismatch-config-"));
  const configPath = join(tempDir, "headroom.json");
  let compressionRequests = 0;

  try {
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, port: 8787 }));
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/health")) {
        return new Response(JSON.stringify({ version: "0.40.0" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      compressionRequests++;
      throw new Error("compression must not be requested");
    };

    const handlers = new Map();
    const pi = {
      on(event, handler) {
        handlers.set(event, handler);
        return () => {};
      },
      registerCommand() {},
    };
    const mod = await jiti.import("../src/index.ts");
    await installExtension(mod, pi, { headroomConfigPath: configPath, probeHealth: true });
    const notifications = [];
    const result = await handlers.get("context")({ messages: [{ role: "user", content: "keep original", timestamp: 1 }] }, {
      model: { id: "test-model" },
      ui: {
        theme: { fg: (_color, value) => value },
        setStatus() {},
        notify: (message, level) => notifications.push({ message, level }),
      },
    });

    assert.equal(result, undefined);
    assert.equal(compressionRequests, 0);
    assert.ok(notifications.some(({ message }) => message.includes("unavailable")));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("context: forwards configured compression overrides to Headroom", async () => {
  const originalFetch = globalThis.fetch;
  const tempDir = await mkdtemp(join(tmpdir(), "pi-headroom-compression-config-"));
  const configPath = join(tempDir, "headroom.json");
  let requestBody;

  try {
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 1,
      port: 8787,
      compression: {
        mode: "lossless_then_lossy",
        targetRatio: 0.8,
        compressUserMessages: false,
        protectRecent: 8,
        protectAnalysisContext: true,
        frozenMessageCount: 2,
      },
    }));
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith("/health")) {
        return new Response(JSON.stringify({ version: "0.41.0" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        messages: [{ role: "user", content: "compress me" }],
        tokens_before: 2,
        tokens_after: 2,
        tokens_saved: 0,
        compression_ratio: 1,
        transforms_applied: [],
        ccr_hashes: [],
        compressed: false,
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const handlers = new Map();
    const pi = {
      on(event, handler) {
        handlers.set(event, handler);
        return () => {};
      },
      registerCommand() {},
    };
    const mod = await jiti.import("../src/index.ts");
    await installExtension(mod, pi, { headroomConfigPath: configPath });
    await handlers.get("context")({ messages: [{ role: "user", content: "compress me", timestamp: 1 }] }, {
      model: { id: "test-model" },
      ui: {
        theme: { fg: (_color, value) => value },
        setStatus() {},
        notify() {},
      },
    });

    assert.deepEqual(requestBody.config, {
      mode: "lossless_then_lossy",
      target_ratio: 0.8,
      compress_user_messages: false,
      protect_recent: 8,
      protect_analysis_context: true,
      frozen_message_count: 2,
    });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("context: image safety fallback does not report unapplied compression savings", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      messages: [],
      tokens_before: 100,
      tokens_after: 10,
      tokens_saved: 90,
      compression_ratio: 0.1,
      transforms_applied: ["lossy"],
      ccr_hashes: [],
      compressed: true,
    }), { status: 200, headers: { "content-type": "application/json" } });

    const handlers = new Map();
    const pi = {
      on(event, handler) {
        handlers.set(event, handler);
        return () => {};
      },
      registerCommand() {},
    };
    const mod = await jiti.import("../src/index.ts");
    await installExtension(mod, pi);

    const statuses = [];
    const event = {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "keep this image" },
          { type: "image", data: "QUJD", mimeType: "image/png" },
        ],
        timestamp: 1,
      }],
    };
    const result = await handlers.get("context")(event, {
      model: { id: "test-model" },
      ui: {
        theme: { fg: (_color, value) => value },
        setStatus: (_key, value) => statuses.push(value),
        notify() {},
      },
    });

    assert.equal(result, undefined, "original context remains active");
    assert.ok(statuses.some((status) => status.includes("safety fallback")));
    assert.equal(statuses.some((status) => status.includes("saved")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("context: healthy proxy compression failure stays online", async () => {
  const originalFetch = globalThis.fetch;
  const tempDir = await mkdtemp(join(tmpdir(), "pi-headroom-healthy-config-"));
  const configPath = join(tempDir, "headroom.json");
  let compressionRequests = 0;
  let healthChecks = 0;

  try {
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, port: 8787 }));
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/health")) {
        healthChecks++;
        return new Response(JSON.stringify({ version: "0.41.0" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      compressionRequests++;
      throw new Error("upstream compression rejected request");
    };

    const handlers = new Map();
    const pi = {
      on(event, handler) {
        handlers.set(event, handler);
        return () => {};
      },
      registerCommand() {},
    };
    const mod = await jiti.import("../src/index.ts");
    await installExtension(mod, pi, { headroomConfigPath: configPath, probeHealth: true });

    const statuses = [];
    const notifications = [];
    const ctx = {
      model: { id: "test-model" },
      ui: {
        theme: { fg: (_color, value) => value },
        setStatus: (_key, value) => statuses.push(value),
        notify: (message, level) => notifications.push({ message, level }),
      },
    };
    const event = { messages: [{ role: "user", content: "compress me", timestamp: 1 }] };
    const contextHandler = handlers.get("context");

    assert.equal(await contextHandler(event, ctx), undefined);
    assert.ok(compressionRequests >= 1, "expected Headroom client to attempt compression");
    assert.equal(healthChecks, 2);
    const firstCompressionRequestCount = compressionRequests;
    assert.ok(
      notifications.some(({ message, level }) =>
        level === "warning" && message.includes("Headroom compression request failed"),
      ),
    );
    assert.equal(notifications.some(({ message }) => message.includes("Headroom proxy unavailable")), false);
    assert.ok(statuses.some((status) => status.includes("Headroom request failed")));
    assert.equal(statuses.some((status) => status.includes("Headroom offline")), false);

    await contextHandler(event, ctx);
    assert.ok(compressionRequests > firstCompressionRequestCount, "healthy proxy should accept later compression attempts");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("commands: managed proxy status reports attested health version", async () => {
  const originalFetch = globalThis.fetch;
  const tempDir = await mkdtemp(join(tmpdir(), "pi-headroom-status-config-"));
  const configPath = join(tempDir, "headroom.json");

  try {
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, port: 8787 }));
    globalThis.fetch = async () => new Response(JSON.stringify({ version: "0.41.0" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const commands = new Map();
    const pi = {
      on() {
        return () => {};
      },
      registerCommand(name, options) {
        commands.set(name, options);
      },
    };
    const mod = await jiti.import("../src/index.ts");
    await installExtension(mod, pi, { headroomConfigPath: configPath, probeHealth: true });
    const notifications = [];
    await commands.get("wb:headroom-proxy").handler("status", {
      ui: { notify: (message, level) => notifications.push({ message, level }) },
    });

    assert.ok(notifications.some(({ message }) =>
      message.includes("Version: 0.41.0 (managed /health)") && message.includes("Expected: 0.41.0 (extension)"),
    ));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("commands: registers only current Workbench commands", async () => {
  const commands = new Map();
  const pi = {
    on() {
      return () => {};
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    registerMcpServer() {},
    unregisterMcpServer() {},
  };

  const mod = await jiti.import("../src/index.ts");
  await installExtension(mod, pi);

  assert.deepEqual([...commands.keys()].sort(), [
    "wb:code-graph",
    "wb:headroom-health",
    "wb:headroom-memory",
    "wb:headroom-proxy",
    "wb:show-system-prompt",
    "wb:study-mode",
  ]);
  assert.match(commands.get("wb:headroom-proxy").description, /\/wb:headroom-proxy/);
  assert.match(commands.get("wb:headroom-memory").description, /\/wb:headroom-memory/);
});

test("Memory off: refuses noninteractive deletion without explicit confirmation", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-headroom-memory-command-"));
  const root = join(tempDir, "memory-root");
  const configPath = join(tempDir, "headroom.json");
  const project = join(tempDir, "project");

  try {
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, memory: { root, namespace: "tester" } }));
    await mkdir(project);
    const memoryConfig = await jiti.import("../src/memory-config.ts");
    const store = memoryConfig.resolveMemoryStore({ cwd: project, root, userId: "tester" });
    const { MemoryManager } = await jiti.import("../src/memory-manager.ts");
    await new MemoryManager({ cwd: project, root, userId: "tester", ensurePython: async () => "/fixture/python" }).createStore();
    const deleteStore = MemoryManager.prototype.deleteStore;
    let observedNamespace;
    MemoryManager.prototype.deleteStore = async function () {
      observedNamespace = this.store.userId;
      return deleteStore.call(this);
    };
    t.after(() => { MemoryManager.prototype.deleteStore = deleteStore; });

    const commands = new Map();
    const notifications = [];
    const pi = {
      on() {
        return () => {};
      },
      registerCommand(name, options) {
        commands.set(name, options);
      },
      registerMcpServer() {},
      unregisterMcpServer() {},
    };
    const mod = await jiti.import("../src/index.ts");
    await installExtension(mod, pi, { headroomConfigPath: configPath });

    const ctx = {
      cwd: project,
      hasUI: false,
      ui: {
        theme: { fg: (_color, value) => value },
        setStatus() {},
        notify: (message, level) => notifications.push({ message, level }),
      },
    };
    const command = commands.get("wb:headroom-memory");
    await command.handler("off", ctx);
    assert.equal(existsSync(store.databasePath), true);
    assert.ok(notifications.some(({ message }) => message.includes("needs confirmation")));

    await command.handler("off --confirm-delete", ctx);
    assert.equal(existsSync(store.directory), false);
    assert.equal(observedNamespace, "tester", "extension must pass memory.namespace into MemoryManager");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Memory status: warns once when configured Memory root resolves inside project", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-headroom-memory-warning-"));
  const project = join(tempDir, "project");
  const root = join(project, "memory-root");
  const configPath = join(tempDir, "headroom.json");

  try {
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, memory: { root } }));
    await mkdir(project);
    const commands = new Map();
    const notifications = [];
    const pi = {
      on() {
        return () => {};
      },
      registerCommand(name, options) {
        commands.set(name, options);
      },
      registerMcpServer() {},
      unregisterMcpServer() {},
    };
    const mod = await jiti.import("../src/index.ts");
    await installExtension(mod, pi, { headroomConfigPath: configPath });
    const ctx = {
      cwd: project,
      hasUI: false,
      ui: {
        theme: { fg: (_color, value) => value },
        setStatus() {},
        notify: (message, level) => notifications.push({ message, level }),
      },
    };

    const command = commands.get("wb:headroom-memory");
    await command.handler("status", ctx);
    await command.handler("status", ctx);

    const rootWarnings = notifications.filter(({ message }) => message.includes("headroom.json memory.root resolves inside this project"));
    assert.equal(rootWarnings.length, 1);
    assert.equal(rootWarnings[0].level, "warning");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("session_start: invalid headroom.json compression disables compression with diagnostics", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-headroom-config-invalid-"));
  const configPath = join(tempDir, "headroom.json");

  try {
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, compression: { mode: "token" } }));

    const handlers = new Map();
    const pi = {
      on(event, handler) {
        handlers.set(event, handler);
        return () => {};
      },
      registerCommand() {},
    };

    const mod = await jiti.import("../src/index.ts");
    const fixture = await installExtension(mod, pi, { headroomConfigPath: configPath });

    const statuses = [];
    const notifications = [];
    const ctx = {
      cwd: fixture.home,
      sessionManager: {
        getBranch: () => [
          {
            type: "custom",
            customType: "pi-workbench-study-mode",
            data: { enabled: true },
          },
        ],
      },
      ui: {
        theme: { fg: (_color, value) => value },
        setStatus: (_key, value) => statuses.push(value),
        notify: (message, level) => notifications.push({ message, level }),
      },
    };

    await handlers.get("session_start")({}, ctx);
    for (let attempt = 0; attempt < 100 && !notifications.length; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(statuses.some((status) => status?.includes("Headroom offline")));
    assert.ok(statuses.some((status) => status?.includes("✓ Study")));
    assert.ok(
      notifications.some(({ message, level }) =>
        level === "error" && message.includes("headroom.json compression.mode must be ccr, lossy_inline, or lossless_then_lossy"),
      ),
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


test("context: unsupported URL config sends no context and never rewrites existing file", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "wb-config-clean-break-"));
  const configPath = join(tempDir, "headroom.json");
  const originalFetch = globalThis.fetch;
  try {
    const original = JSON.stringify({ url: "http://127.0.0.1:8787", memoryRoot: "/old-store" });
    await writeFile(configPath, original);
    let requests = 0; globalThis.fetch = async () => { requests++; throw new Error("must not contact URL"); };
    const handlers = new Map(), notifications = [];
    const mod = await jiti.import("../src/index.ts");
    const fixture = await installExtension(mod, { on: (name, handler) => handlers.set(name, handler), registerCommand() {} }, { headroomConfigPath: configPath });
    const ctx = { cwd: fixture.home, ui: { theme: { fg: (_color, text) => text }, setStatus() {}, notify: message => notifications.push(message) } };
    await fixture.commands.get("wb:headroom-proxy").handler("on", ctx);
    const result = await handlers.get("context")({ messages: [{ role: "user", content: "private synthetic context", timestamp: 1 }] }, ctx);
    assert.equal(result, undefined); assert.equal(requests, 0);
    assert.ok(notifications.some(message => message.includes("url is unsupported")));
    assert.equal(await (await import("node:fs/promises")).readFile(configPath, "utf8"), original);
  } finally { globalThis.fetch = originalFetch; await rm(tempDir, { recursive: true, force: true }); }
});
