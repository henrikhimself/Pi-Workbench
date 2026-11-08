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
  const { probeHealth = false, activationUi = { setStatus() {}, notify() {} }, ...extensionOptions } = options;
  const configPath = options.headroomConfigPath ?? paths.headroomConfig;
  if (!options.headroomConfigPath) {
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, port: 8787 }));
  }
  const proxyManager = {
    isManaged: true, baseUrl: "http://127.0.0.1:8787",
    resume() {}, stop: async () => {}, ensureRunning: async () => true, tryRestart: async () => false, processAlive: async () => false,
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
  await commands.get("wb:headroom-proxy").handler("on", { cwd: home, ui: activationUi });
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

test("context: version-mismatched managed proxy remains fail-open and is reported offline", async () => {
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

    // No per-call health pre-check any more (the owned transport authenticates every request);
    // the failed request triggers one health check, which reports the mismatch.
    assert.equal(result, undefined, "context stays unmodified");
    assert.equal(compressionRequests, 1);
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

async function runContext(responseMessages, messages) {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      messages: responseMessages, tokens_before: 100, tokens_after: 10, tokens_saved: 90,
      compression_ratio: 0.1, transforms_applied: ["lossy"], ccr_hashes: [], compressed: true,
    }), { status: 200, headers: { "content-type": "application/json" } });
    const handlers = new Map();
    const pi = { on(event, handler) { handlers.set(event, handler); return () => {}; }, registerCommand() {} };
    await installExtension(await jiti.import("../src/index.ts"), pi);
    const statuses = [];
    const result = await handlers.get("context")({ messages }, {
      model: { id: "test-model" },
      ui: { theme: { fg: (_color, value) => value }, setStatus: (_key, value) => statuses.push(value), notify() {} },
    });
    return { result, statuses };
  } finally { globalThis.fetch = originalFetch; }
}

test("context: unchanged custom and bash messages keep their roles after compression", async () => {
  const bash = { role: "bashExecution", command: "ls", output: "a", exitCode: 0, cancelled: false, truncated: false, timestamp: 1 };
  const custom = { role: "custom", customType: "note", content: "custom text", display: true, timestamp: 2 };
  const user = { role: "user", content: "long text to compress", timestamp: 3 };
  const bashText = "Ran `ls`\n```\na\n```";
  const { result } = await runContext([
    { role: "user", content: bashText }, { role: "user", content: "custom text" }, { role: "user", content: "short" },
  ], [bash, custom, user]);
  assert.ok(result, "compressed context is returned");
  assert.equal(result.messages.length, 3);
  assert.equal(result.messages[0], bash, "bash message untouched (its converted text is unchanged)");
  assert.equal(result.messages[1], custom);
  assert.equal(result.messages[2].role, "user");
  assert.deepEqual(result.messages[2].content, [{ type: "text", text: "short" }]);
});

test("context: unmatched tool metadata after a count change keeps the original context", async () => {
  const assistant = { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: {} }],
    api: "openai-completions", provider: "openai", model: "m", usage: {}, stopReason: "toolUse", timestamp: 2 };
  const { result, statuses } = await runContext([
    { role: "tool", content: "x", tool_call_id: "other" },
  ], [{ role: "user", content: "q", timestamp: 1 }, assistant]);
  assert.equal(result, undefined);
  assert.ok(statuses.some((status) => status.includes("safety fallback (message count changed)")));
  assert.equal(statuses.some((status) => status.includes("saved")), false);
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
    assert.equal(healthChecks, 1, "one health check, after the failure only");
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
    await installExtension(mod, pi, { headroomConfigPath: configPath, probeHealth: true, headroomRuntime: { inspect: async () => ({ version: "0.41.0" }) } });
    const notifications = [];
    await commands.get("wb:headroom-proxy").handler("status", {
      ui: { notify: (message, level) => notifications.push({ message, level }) },
    });

    assert.ok(notifications.some(({ message }) =>
      /^Headroom compression\n {2}State: {4}off\n {2}Project: {2}\S+ {2}\(\S+\)\n {2}Data: /.test(message)
        && /Details:\n {4}This session: on\./.test(message) && /Link:\s+running/.test(message) && /Version:\s+0\.41\.0 \(expected 0\.41\.0\)/.test(message),
    ));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("S8: proxy status reports the managed runtime version (replaces /wb:headroom-health)", async () => {
  const originalFetch = globalThis.fetch;
  const tempDir = await mkdtemp(join(tmpdir(), "pi-headroom-runtime-status-"));
  const configPath = join(tempDir, "headroom.json");
  try {
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, port: 8787 }));
    globalThis.fetch = async () => new Response(JSON.stringify({ version: "0.41.0" }), { status: 200, headers: { "content-type": "application/json" } });
    for (const [inspected, expected] of [[async () => ({ version: "0.40.9" }), "Version:  0.40.9 (expected 0.41.0)"], [async () => null, "Version:  not installed"], [async () => { throw new Error("broken"); }, "Version:  not installed"]]) {
      const commands = new Map();
      const pi = { on() { return () => {}; }, registerCommand(name, options) { commands.set(name, options); } };
      const mod = await jiti.import("../src/index.ts");
      await installExtension(mod, pi, { headroomConfigPath: configPath, probeHealth: true, headroomRuntime: { inspect: inspected } });
      const notifications = [];
      await commands.get("wb:headroom-proxy").handler("status", { ui: { notify: (message, level) => notifications.push({ message, level }) } });
      assert.ok(notifications.some(({ message }) => message.includes(expected)), `${expected}: ${JSON.stringify(notifications)}`);
      assert.equal(commands.has("wb:headroom-health"), false);
    }
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("S3: option-taking /wb: commands register argument completions", async () => {
  const commands = new Map();
  const pi = { on() { return () => {}; }, registerCommand(name, options) { commands.set(name, options); } };
  const mod = await jiti.import("../src/index.ts");
  await installExtension(mod, pi);
  const complete = (name, prefix) => commands.get(name).getArgumentCompletions?.(prefix)?.map((item) => item.value);
  assert.deepEqual(complete("wb:headroom-proxy", "st"), ["status"]);
  assert.deepEqual(complete("wb:study-mode", ""), ["on", "off"]);
  assert.deepEqual(complete("wb:headroom-memory", "import "), ["import --confirm-replace"]);
  assert.deepEqual(complete("wb:code-graph", "off "), ["off --confirm-delete"]);
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
    "wb:headroom-memory",
    "wb:headroom-proxy",
    "wb:playwright",
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
    assert.ok(notifications.some(({ message }) => message === "Headroom Memory data deleted for this project"));
    await command.handler("off", ctx);
    assert.ok(notifications.some(({ message }) => message === "Headroom Memory already off for this project"));
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

// ─── Busy proxies are not dead proxies (watchdog, back-off, abort) ────

const COMPRESSED = { messages: [{ role: "user", content: "short" }], tokens_before: 100, tokens_after: 10, tokens_saved: 90,
  compression_ratio: 0.1, transforms_applied: ["lossy"], ccr_hashes: [], compressed: true };

async function stabilityFixture(t, { timers = ["setInterval", "Date"], alive = true } = {}) {
  const state = { healthOk: true, alive, compressOk: true, restarts: 0, restartOk: true, healthCalls: [], requests: 0 };
  const statuses = [], notifications = [];
  const ui = { theme: { fg: (_color, value) => value }, setStatus: (_key, value) => statuses.push(value),
    notify: (message, level) => notifications.push({ message, level }) };
  const proxyManager = {
    isManaged: true, baseUrl: "http://127.0.0.1:8787", resume() {}, stop: async () => {}, ensureRunning: async () => true,
    tryRestart: async () => { state.restarts++; return state.restartOk; },
    processAlive: async () => state.alive,
    healthCheck: async (timeoutMs) => { state.healthCalls.push(timeoutMs); return state.healthOk; },
    requestOwned: async (_path, _body, _method, signal) => {
      state.requests++;
      if (state.hang) await new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted"))));
      if (!state.compressOk) throw new Error("compression failed");
      return COMPRESSED;
    },
  };
  t.mock.timers.enable({ apis: timers });
  const handlers = new Map();
  const pi = { on(event, handler) { handlers.set(event, handler); return () => {}; }, registerCommand() {} };
  await installExtension(await jiti.import("../src/index.ts"), pi, { proxyManager, activationUi: ui });
  const event = { messages: [{ role: "user", content: "compress me", timestamp: 1 }] };
  const context = (extra = {}) => handlers.get("context")(event, { model: { id: "test-model" }, ui, ...extra });
  const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve)); };
  const tickWatchdog = async () => { t.mock.timers.tick(30_000); await flush(); };
  return { state, statuses, notifications, context, tickWatchdog, flush };
}

test("watchdog: one or two failed probes do not restart a live proxy, the third does", async (t) => {
  const fx = await stabilityFixture(t);
  fx.state.healthOk = false;
  await fx.tickWatchdog(); await fx.tickWatchdog();
  assert.equal(fx.state.restarts, 0);
  assert.equal(fx.statuses.some((status) => status.includes("restarting")), false, "no restart notice for a busy proxy");
  assert.ok(fx.state.healthCalls.length >= 2 && fx.state.healthCalls.every((timeout) => timeout === 10_000), "watchdog probes use the long timeout");
  await fx.tickWatchdog();
  assert.equal(fx.state.restarts, 1);
});

test("watchdog: a passing probe resets the failure count", async (t) => {
  const fx = await stabilityFixture(t);
  fx.state.healthOk = false; await fx.tickWatchdog(); await fx.tickWatchdog();
  fx.state.healthOk = true; await fx.tickWatchdog();
  fx.state.healthOk = false; await fx.tickWatchdog(); await fx.tickWatchdog();
  assert.equal(fx.state.restarts, 0);
});

test("watchdog: restarts at once when the proxy process is gone", async (t) => {
  const fx = await stabilityFixture(t, { alive: false });
  fx.state.healthOk = false;
  await fx.tickWatchdog();
  assert.equal(fx.state.restarts, 1);
});

test("context: makes no health request before a successful compression", async (t) => {
  const fx = await stabilityFixture(t, { timers: ["Date"] });
  const result = await fx.context();
  assert.ok(result?.messages, "compressed");
  assert.equal(fx.state.requests, 1);
  assert.deepEqual(fx.state.healthCalls, []);
});

test("context: after a failure compression is skipped during the back-off, then retried", async (t) => {
  const fx = await stabilityFixture(t, { timers: ["Date"] });
  fx.state.compressOk = false; fx.state.healthOk = false;
  assert.equal(await fx.context(), undefined);
  assert.ok(fx.notifications.some(({ message }) => message.includes("Headroom proxy unavailable")));
  const requestsAfterFailure = fx.state.requests;
  assert.equal(await fx.context(), undefined);
  assert.equal(fx.state.requests, requestsAfterFailure, "no request during the back-off");
  fx.state.compressOk = true; fx.state.healthOk = true;
  t.mock.timers.tick(31_000);
  const result = await fx.context();
  assert.ok(result?.messages, "compression is back after the back-off");
  assert.ok(fx.statuses.some((status) => status === "✓ Headroom"), "footer shows the recovery");
});

test("context: a failed probe after the back-off extends it instead of sending context", async (t) => {
  const fx = await stabilityFixture(t, { timers: ["Date"] });
  fx.state.compressOk = false; fx.state.healthOk = false;
  await fx.context();
  const requests = fx.state.requests;
  t.mock.timers.tick(31_000);
  assert.equal(await fx.context(), undefined);
  assert.equal(fx.state.requests, requests, "still unhealthy: nothing sent");
  fx.state.compressOk = true; fx.state.healthOk = true;
  assert.equal(await fx.context(), undefined, "new back-off window");
  t.mock.timers.tick(31_000);
  assert.ok((await fx.context())?.messages);
});

test("watchdog: a passing probe re-enables compression after a failed request", async (t) => {
  const fx = await stabilityFixture(t);
  fx.state.compressOk = false; fx.state.healthOk = false;
  assert.equal(await fx.context(), undefined);
  assert.equal(fx.state.restarts, 0, "live proxy is not restarted by a failed request");
  fx.state.compressOk = true; fx.state.healthOk = true;
  await fx.tickWatchdog();
  assert.ok(fx.statuses.at(-1).includes("✓ Headroom"));
  assert.ok((await fx.context())?.messages, "compression resumed without waiting for the back-off");
});

test("context: a failed request restarts the proxy only when its process is gone", async (t) => {
  const gone = await stabilityFixture(t, { timers: ["Date"], alive: false });
  gone.state.compressOk = false; gone.state.healthOk = false;
  await gone.context();
  assert.equal(gone.state.restarts, 1);
});

test("context: an aborted run returns the original context and is not a proxy failure", async (t) => {
  const fx = await stabilityFixture(t, { timers: ["Date"] });
  fx.state.hang = true;
  const controller = new AbortController();
  const pending = fx.context({ signal: controller.signal });
  await fx.flush();
  controller.abort();
  const started = Date.now();
  assert.equal(await pending, undefined);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(fx.state.healthCalls, [], "an abort is not followed by a health check");
  assert.equal(fx.notifications.some(({ message }) => message.includes("unavailable")), false);
  fx.state.hang = false;
  assert.ok((await fx.context())?.messages, "proxy still considered available");
});

// ── WB-06: Memory registration conflicts (M7) and restoring after a failed command (L5) ──
async function memoryFixture(t, { servers = () => [], agentFile } = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-headroom-memory-wb06-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const root = join(tempDir, "memory-root"), project = join(tempDir, "project"), configPath = join(tempDir, "headroom.json"), agent = join(tempDir, "agent");
  await mkdir(project); await mkdir(agent);
  await writeFile(configPath, JSON.stringify({ schemaVersion: 1, memory: { root, namespace: "tester" } }));
  if (agentFile) await writeFile(join(agent, "mcp.json"), agentFile);
  const { MemoryManager } = await jiti.import("../src/memory-manager.ts");
  const saved = { prepare: MemoryManager.prototype.prepare, ensureRuntime: MemoryManager.prototype.ensureRuntime, getMcpConfig: MemoryManager.prototype.getMcpConfig, showBundle: MemoryManager.prototype.showBundle };
  MemoryManager.prototype.prepare = async () => "/fixture/python";
  MemoryManager.prototype.ensureRuntime = async () => "/fixture/python";
  MemoryManager.prototype.getMcpConfig = () => ({ command: "/fixture/launcher", args: [] });
  t.after(() => Object.assign(MemoryManager.prototype, saved));
  const commands = new Map(), notifications = [], statuses = [], registered = [], unregistered = [];
  const pi = {
    on() { return () => {}; }, registerCommand(name, options) { commands.set(name, options); },
    registerMcpServer: (name, config) => registered.push({ name, config }), unregisterMcpServer: (name) => unregistered.push(name),
    getMcpServers: servers, getAllTools: () => [], getActiveTools: () => [],
  };
  const mod = await jiti.import("../src/index.ts");
  await installExtension(mod, pi, { headroomConfigPath: configPath, agentDir: () => agent });
  const ctx = { cwd: project, hasUI: false, isProjectTrusted: () => true,
    ui: { theme: { fg: (_color, value) => value }, setStatus: (key, text) => statuses.push({ key, text }), notify: (message, level) => notifications.push({ message, level }) } };
  return { MemoryManager, command: commands.get("wb:headroom-memory"), ctx, notifications, statuses, registered, unregistered };
}

test("M7: Memory does not register over a same-name mcp.json server and status says why", async (t) => {
  const f = await memoryFixture(t, { agentFile: JSON.stringify({ mcpServers: { "headroom_memory": { command: "/the/users/own/server" } } }) });
  await f.command.handler("on", f.ctx);
  assert.equal(f.registered.length, 0, "nothing is registered under a shadowed name");
  assert.ok(f.notifications.some(({ message }) => /Headroom Memory not registered: same-name MCP declaration "headroom_memory" in .*mcp\.json/.test(message)), JSON.stringify(f.notifications));
  assert.match(f.statuses.filter(({ key }) => key === "headroom-memory").at(-1).text, /offline/);
  await f.command.handler("status", f.ctx);
  assert.match(f.notifications.at(-1).message, /not registered \(same-name MCP declaration/);
});

test("M7: Memory registers normally when nothing conflicts", async (t) => {
  const f = await memoryFixture(t);
  await f.command.handler("on", f.ctx);
  assert.equal(f.registered.length, 1);
  assert.equal(f.registered[0].name, "headroom-memory");
  assert.ok(f.notifications.some(({ message }) => message === "Headroom Memory enabled for this project"));
  await f.command.handler("status", f.ctx);
  const status = f.notifications.at(-1).message;
  assert.match(status, /^Headroom Memory\n {2}State: {4}on\n {2}Project: {2}\S+ {2}\(\S+\)\n {2}Data: /);
  assert.match(status, /Link: {5}registered/); assert.match(status, /Details:\n {4}Backend: ONNX Runtime CPU/);
});

test("L5: a failing show leaves Memory registered", async (t) => {
  const f = await memoryFixture(t);
  await f.command.handler("on", f.ctx);
  assert.equal(f.registered.length, 1);
  f.MemoryManager.prototype.showBundle = async () => { throw new Error("show exploded"); };
  await f.command.handler("show", f.ctx);
  assert.ok(f.notifications.some(({ message }) => /Headroom Memory show failed: show exploded/.test(message)));
  assert.deepEqual(f.unregistered, ["headroom-memory"], "unregistered for the direct-store work");
  assert.equal(f.registered.length, 2, "and registered again after the failure");
  assert.match(f.statuses.filter(({ key }) => key === "headroom-memory").at(-1).text, /✓ Headroom Memory/);
});

test("M13: a long show result is truncated for display and points at export", async (t) => {
  const f = await memoryFixture(t);
  await f.command.handler("on", f.ctx);
  f.MemoryManager.prototype.showBundle = async () => "m".repeat(300_000);
  await f.command.handler("show", f.ctx);
  const shown = f.notifications.at(-1).message;
  assert.ok(shown.length < 101_000);
  assert.match(shown, /output truncated \(300000 characters in total\).*\/wb:headroom-memory export/);
});

// ── M5: only a real quit terminates the proxy; session replacements hand it over ──
test("M5: session_shutdown terminates the proxy on quit and hands it over for every replacement reason", async () => {
  const { resolveWorkbenchPaths } = await jiti.import("../src/paths.ts");
  const mod = await jiti.import("../src/index.ts");
  const outcomes = {};
  for (const reason of ["quit", "reload", "new", "resume", "fork", undefined]) {
    const home = await mkdtemp(join(tmpdir(), "wb-shutdown-reason-")); fixtureHomes.push(home);
    const paths = resolveWorkbenchPaths(home); await mkdir(paths.root, { recursive: true, mode: 0o700 });
    await writeFile(paths.headroomConfig, JSON.stringify({ schemaVersion: 1, port: 8787 }));
    const stops = [], handlers = new Map();
    const proxyManager = { isManaged: false, resume() {}, stop: async (...args) => { stops.push(args); }, ensureRunning: async () => false, tryRestart: async () => false, processAlive: async () => false, healthCheck: async () => false };
    mod.default({ on: (name, handler) => { handlers.set(name, handler); }, registerCommand() {}, registerMcpServer() {}, unregisterMcpServer() {} },
      { workbenchPaths: paths, headroomConfigPath: paths.headroomConfig, proxyManager });
    await handlers.get("session_shutdown")(reason === undefined ? undefined : { type: "session_shutdown", reason });
    outcomes[String(reason)] = stops;
  }
  assert.deepEqual(outcomes.quit, [[undefined]], "quit: full stop");
  assert.deepEqual(outcomes.undefined, [[undefined]], "unknown reason: full stop (safe default)");
  for (const reason of ["reload", "new", "resume", "fork"]) assert.deepEqual(outcomes[reason], [[{ terminate: false }]], reason);
});
