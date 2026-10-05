/**
 * Regression tests for extension-level context behavior.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, open, rm, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

test("context: compression failure marks proxy offline instead of accepting an SDK fallback", async () => {
  const priorUrl = process.env.HEADROOM_URL;
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;

  try {
    process.env.HEADROOM_URL = "http://127.0.0.1:1";
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
    mod.default(pi);

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
    if (priorUrl === undefined) {
      delete process.env.HEADROOM_URL;
    } else {
      process.env.HEADROOM_URL = priorUrl;
    }
  }
});

test("context: forwards configured compression overrides to Headroom", async () => {
  const originalFetch = globalThis.fetch;
  const tempDir = await mkdtemp(join(tmpdir(), "pi-headroom-compression-config-"));
  const configPath = join(tempDir, "headroom.json");
  let requestBody;

  try {
    await writeFile(configPath, JSON.stringify({
      url: "http://127.0.0.1:8787",
      compression: {
        mode: "lossless_then_lossy",
        targetRatio: 0.8,
        compressUserMessages: false,
        protectRecent: 8,
        protectAnalysisContext: true,
        frozenMessageCount: 2,
      },
    }));
    globalThis.fetch = async (_url, init) => {
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
    mod.default(pi, { headroomConfigPath: configPath });
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
    mod.default(pi);

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
  const priorUrl = process.env.HEADROOM_URL;
  const originalFetch = globalThis.fetch;
  let compressionRequests = 0;
  let healthChecks = 0;

  try {
    process.env.HEADROOM_URL = "http://127.0.0.1:8787";
    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/health")) {
        healthChecks++;
        return { ok: true };
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
    mod.default(pi);

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
    assert.equal(healthChecks, 1);
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
    if (priorUrl === undefined) delete process.env.HEADROOM_URL;
    else process.env.HEADROOM_URL = priorUrl;
  }
});

test("commands: registers wb proxy and Memory commands, not legacy namespaces", async () => {
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
  mod.default(pi);

  assert.ok(commands.has("wb:headroom-proxy"));
  assert.ok(commands.has("wb:headroom-memory"));
  assert.ok(commands.has("wb:headroom-health"));
  assert.equal(commands.has("headroom"), false);
  assert.equal(commands.has("headroom-health"), false);
  assert.equal(commands.has("hj:headroom-proxy"), false);
  assert.equal(commands.has("hj:headroom-memory"), false);
  assert.match(commands.get("wb:headroom-proxy").description, /\/wb:headroom-proxy/);
  assert.match(commands.get("wb:headroom-memory").description, /\/wb:headroom-memory/);
});

test("Memory off: refuses noninteractive deletion without explicit confirmation", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-headroom-memory-command-"));
  const root = join(tempDir, "memory-root");
  const configPath = join(tempDir, "headroom.json");
  const project = join(tempDir, "project");

  try {
    await writeFile(configPath, JSON.stringify({ memoryRoot: root, memoryNamespace: "tester" }));
    await mkdir(project);
    const memoryConfig = await jiti.import("../src/memory-config.ts");
    const store = memoryConfig.resolveMemoryStore({ cwd: project, root, userId: "tester" });
    await mkdir(store.directory, { recursive: true });
    const handle = await open(store.databasePath, "a");
    await handle.close();

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
    mod.default(pi, { headroomConfigPath: configPath });

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
    await writeFile(configPath, JSON.stringify({ memoryRoot: root }));
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
    mod.default(pi, { headroomConfigPath: configPath });
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

    const rootWarnings = notifications.filter(({ message }) => message.includes("headroom.json memoryRoot resolves inside this project"));
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
    await writeFile(configPath, JSON.stringify({ compression: { mode: "token" } }));

    const handlers = new Map();
    const pi = {
      on(event, handler) {
        handlers.set(event, handler);
        return () => {};
      },
      registerCommand() {},
    };

    const mod = await jiti.import("../src/index.ts");
    mod.default(pi, { headroomConfigPath: configPath });

    const statuses = [];
    const notifications = [];
    const ctx = {
      sessionManager: {
        getBranch: () => [
          {
            type: "custom",
            customType: "pi-workbench-preceptor-mode",
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
    assert.ok(statuses.some((status) => status?.includes("Headroom offline")));
    assert.ok(statuses.some((status) => status?.includes("Learning")));
    assert.ok(
      notifications.some(({ message, level }) =>
        level === "error" && message.includes("headroom.json compression.mode must be ccr, lossy_inline, or lossless_then_lossy"),
      ),
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
