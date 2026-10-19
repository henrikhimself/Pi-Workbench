/**
 * Integration tests for the `/wb:code-graph` command family and the
 * session lifecycle wiring in `src/index.ts` (TODO.md Phases 3/4).
 *
 * Everything runs against a temporary workbench home
 * (`options.workbenchPaths` test seam) and a fake verified
 * codebase-memory-mcp install, so no network or real user data is touched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { fakeCbmSource } from "./helpers/fake-cbm.mjs";

const jiti = createJiti(import.meta.url);
const { resolveWorkbenchPaths } = await jiti.import("../src/paths.ts");
const {
  CODE_GRAPH_ASSETS,
  resolveAssetUrl,
} = await jiti.import("../src/code-graph-assets.ts");
const {
  createCodeGraphState,
  resolveCodeGraphProject,
} = await jiti.import("../src/code-graph-config.ts");
const { curlShimDirectory } = await jiti.import("../src/code-graph-manager.ts");
const extensionModule = await jiti.import("../src/index.ts");

// ─── Harness ──────────────────────────────────────────────────────────

function makePi() {
  const handlers = new Map();
  const commands = new Map();
  const mcp = new Map();
  const unregistered = [];
  return {
    pi: {
      on: (event, handler) => {
        handlers.set(event, handler);
        return () => {};
      },
      appendEntry: () => {},
      registerCommand: (name, definition) => {
        commands.set(name, definition);
      },
      registerMcpServer: (name, config) => {
        mcp.set(name, config);
      },
      unregisterMcpServer: (name) => {
        mcp.delete(name);
        unregistered.push(name);
      },
    },
    handlers,
    commands,
    mcp,
    unregistered,
  };
}

function makeCtx(workspace, options = {}) {
  const notifications = [];
  const confirms = [];
  const statuses = [];
  const ctx = {
    cwd: workspace,
    hasUI: options.hasUI ?? true,
    model: { id: "test-model" },
    sessionManager: { getBranch: () => [] },
    ui: {
      theme: { fg: (_color, value) => value },
      setStatus: (key, value) => statuses.push([key, value]),
      notify: (message, level) => notifications.push({ message, level }),
      confirm: async (question, detail) => {
        confirms.push({ question, detail });
        return options.confirmAnswer ?? true;
      },
    },
  };
  return { ctx, notifications, confirms, statuses };
}

async function makeFixture() {
  const home = await mkdtemp(join(tmpdir(), "cg-wiring-home-"));
  const workspace = await mkdtemp(join(tmpdir(), "cg-wiring-ws-"));
  const paths = resolveWorkbenchPaths(home);
  const configPath = join(home, "headroom.json");
  // User-managed external proxy that is unreachable: session_start must
  // fail open fast without touching the network for real.
  await writeFile(configPath, JSON.stringify({ url: "http://127.0.0.1:1" }));
  const piState = makePi();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("connection refused");
  };
  extensionModule.default(piState.pi, { headroomConfigPath: configPath, workbenchPaths: paths });
  const callLog = join(home, "cbm-calls.log");
  return {
    home,
    workspace,
    paths,
    piState,
    callLog,
    cleanup: async () => {
      globalThis.fetch = originalFetch;
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

async function waitFor(condition, timeoutMs = 15000, message = "condition") {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Seed a fake verified install at the packaged version in the bin root so
 * the production installer reuses it offline (no download).
 */
async function seedVerifiedInstall(fixture) {
  const { paths, callLog } = fixture;
  const asset = CODE_GRAPH_ASSETS["linux-arm64"];
  const resolvedUrl = resolveAssetUrl(asset);
  const binDir = join(paths.codeGraphBin, asset.version, "linux-arm64");
  await mkdir(binDir, { recursive: true });
  const fakeBinary = join(binDir, "codebase-memory-mcp");
  await writeFile(fakeBinary, fakeCbmSource({ callLog }), "utf8");
  await chmod(fakeBinary, 0o755);
  await writeFile(
    join(binDir, "asset.json"),
    JSON.stringify({ version: asset.version, resolvedUrl, sha256: asset.sha256 }) + "\n",
  );
  return fakeBinary;
}

/** Seed a valid project state: state.json, _config.db, and an index DB. */
async function seedProjectData(fixture) {
  const { paths, workspace } = fixture;
  const project = resolveCodeGraphProject(workspace, paths);
  const asset = CODE_GRAPH_ASSETS["linux-arm64"];
  await mkdir(project.directory, { recursive: true });
  const state = createCodeGraphState(project, {
    version: asset.version,
    resolvedUrl: resolveAssetUrl(asset),
    sha256: asset.sha256,
  });
  await writeFile(project.statePath, JSON.stringify(state, null, 2) + "\n");
  await writeFile(join(project.directory, "_config.db"), "auto_index = true\n");
  const derived = project.projectPath.replace(/^\//, "").replace(/\//g, "-");
  await writeFile(join(project.directory, `${derived}.db`), "INDEX");
  return project;
}

/** Seed a fully enabled workspace offline. */
async function seedEnabledWorkspace(fixture) {
  const fakeBinary = await seedVerifiedInstall(fixture);
  const project = await seedProjectData(fixture);
  return { project, fakeBinary };
}

function command(fixture) {
  return fixture.piState.commands.get("wb:code-graph");
}

async function readCallLog(fixture) {
  try {
    const raw = await readFile(fixture.callLog, "utf8");
    return raw.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// ─── Command surface ──────────────────────────────────────────────────

test("command: unknown arguments and actions are rejected with usage", async () => {
  const fixture = await makeFixture();
  try {
    const cmd = command(fixture);
    assert.ok(cmd, "wb:code-graph must be registered");
    for (const args of ["", "status", "frobnicate", "on --extra"]) {
      const { ctx, notifications } = makeCtx(fixture.workspace);
      await cmd.handler(args, ctx);
      assert.ok(
        notifications.every(({ level }) => level !== "error" || notifications.some((n) => n.message.startsWith("Usage:"))),
        `unexpected non-usage errors for ${JSON.stringify(args)}: ${JSON.stringify(notifications)}`,
      );
    }
    const bad = makeCtx(fixture.workspace);
    await cmd.handler("frobnicate", bad.ctx);
    assert.ok(bad.notifications.some(({ message, level }) => level === "error" && message.startsWith("Usage:")));
    assert.equal(fixture.piState.mcp.size, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("command: status with no state reports off", async () => {
  const fixture = await makeFixture();
  try {
    const { ctx, notifications } = makeCtx(fixture.workspace);
    await command(fixture).handler("status", ctx);
    const report = notifications.find(({ level }) => level === "info")?.message ?? "";
    assert.match(report, /State:\s+off/);
    assert.equal(fixture.piState.mcp.size, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("command: first on activates end to end without confirmation", async () => {
  const fixture = await makeFixture();
  await seedVerifiedInstall(fixture);
  try {
    const { paths, workspace, callLog } = fixture;
    const project = resolveCodeGraphProject(workspace, paths);
    const asset = CODE_GRAPH_ASSETS["linux-arm64"];
    const { ctx, notifications, confirms } = makeCtx(workspace);
    await command(fixture).handler("on", ctx);
    assert.equal(confirms.length, 0);

    // Activation succeeded end to end (offline: fake verified install).
    await waitFor(() => fixture.piState.mcp.has("codebase-memory"), 15000, "MCP registration");
    const config = fixture.piState.mcp.get("codebase-memory");
    const fakeBinary = join(paths.codeGraphBin, asset.version, "linux-arm64", "codebase-memory-mcp");
    assert.equal(config.command, fakeBinary);
    assert.deepEqual(config.args, []);
    assert.equal(config.cwd, project.projectPath);
    assert.equal(config.exposure, "direct");
    assert.equal(config.env.CBM_CACHE_DIR, project.directory);
    assert.equal(config.env.CBM_LOG_LEVEL, "error");
    assert.ok(config.env.PATH.startsWith(`${curlShimDirectory(fixture.paths.codeGraphCurlShim)}:`), "curl shim dir first in PATH");
    assert.ok(!("CBM_DOWNLOAD_URL" in config.env));

    // State published last, valid, with auto_index proven and index DB present.
    await waitFor(() => existsSync(project.statePath), 5000, "state.json");
    const state = JSON.parse(await readFile(project.statePath, "utf8"));
    assert.equal(state.version, asset.version);
    assert.equal(state.identifier, project.identifier);
    const configDb = await readFile(join(project.directory, "_config.db"), "utf8");
    assert.match(configDb, /auto_index = true/);
    const calls = await readCallLog(fixture);
    assert.ok(calls.includes("index-repository"), "index_repository ran once via owned binary");
    assert.ok(calls.includes("index-status"), "index validated via index_status");

    assert.match(notifications.map((n) => n.message).join("\n"), /Code graph enabled for /);
    assert.equal(existsSync(fixture.paths.codeGraphCurlShim), true, "curl deny shim materialized");
  } finally {
    await fixture.cleanup();
  }
});

test("command: on again while enabled does not reindex", async () => {
  const fixture = await makeFixture();
  const { project, fakeBinary } = await seedEnabledWorkspace(fixture);
  try {
    assert.equal(fakeBinary, join(fixture.paths.codeGraphBin, "v0.8.1", "linux-arm64", "codebase-memory-mcp"));
    const { ctx, notifications, confirms } = makeCtx(fixture.workspace, { confirmAnswer: true });
    await command(fixture).handler("on", ctx);
    assert.equal(confirms.length, 0, "no confirmation for already-enabled workspace");
    await waitFor(() => fixture.piState.mcp.has("codebase-memory"), 15000, "MCP registration");
    const calls = await readCallLog(fixture);
    assert.ok(!calls.includes("index-repository"), `must not reindex; calls=${JSON.stringify(calls)}`);
    assert.ok(!notifications.some(({ level }) => level === "error"));
  } finally {
    await fixture.cleanup();
  }
});

test("command: first on without UI activates", async () => {
  const fixture = await makeFixture();
  try {
    const { ctx, notifications } = makeCtx(fixture.workspace, { hasUI: false });
    await command(fixture).handler("on", ctx);
    await waitFor(() => fixture.piState.mcp.has("codebase-memory"), 15000, "MCP registration");
    assert.ok(notifications.some(({ message }) => /Code graph enabled for /.test(message)));
  } finally {
    await fixture.cleanup();
  }
});

test("command: on with corrupt pre-existing state is refused with recovery", async () => {
  const fixture = await makeFixture();
  const { project } = await seedEnabledWorkspace(fixture);
  try {
    // Break the state: remove _config.db so validation fails.
    await rm(join(project.directory, "_config.db"));
    const { ctx, notifications, confirms } = makeCtx(fixture.workspace, { confirmAnswer: true });
    await command(fixture).handler("on", ctx);
    assert.equal(confirms.length, 0);
    assert.ok(
      notifications.some(({ level, message }) => level === "error" && /invalid \(missing_config_db\)/.test(message)),
      JSON.stringify(notifications),
    );
    assert.match(notifications.find(({ level }) => level === "error").message, /\/wb:code-graph off/);
    assert.equal(fixture.piState.mcp.size, 0);
  } finally {
    await fixture.cleanup();
  }
});

// ─── Off / deletion ───────────────────────────────────────────────────

test("command: off on a clean workspace reports already off", async () => {
  const fixture = await makeFixture();
  try {
    const { ctx, notifications } = makeCtx(fixture.workspace, { confirmAnswer: true });
    await command(fixture).handler("off", ctx);
    assert.ok(notifications.some(({ message }) => /already off/.test(message)));
  } finally {
    await fixture.cleanup();
  }
});

test("command: off without --confirm-delete asks and deletes only the project directory", async () => {
  const fixture = await makeFixture();
  const { project, fakeBinary } = await seedEnabledWorkspace(fixture);
  try {
    const { ctx, notifications, confirms } = makeCtx(fixture.workspace, { confirmAnswer: true });
    await command(fixture).handler("off", ctx);
    assert.equal(confirms.length, 1);
    const detail = confirms[0].detail;
    assert.ok(detail.includes(project.directory), "exact deletion target stated");
    assert.ok(detail.includes("_config.db"), "deletion includes _config.db");
    assert.ok(detail.includes("state.json"), "deletion includes state.json");
    assert.ok(detail.includes(fixture.paths.codeGraphBin), "shared binary retained");

    assert.equal(existsSync(project.directory), false, "project directory deleted");
    assert.equal(existsSync(fakeBinary), true, "shared binary retained");
    assert.equal(fixture.piState.mcp.size, 0);
    assert.ok(notifications.some(({ message }) => /Code graph deleted/.test(message)));
  } finally {
    await fixture.cleanup();
  }
});

test("command: off --confirm-delete works noninteractively", async () => {
  const fixture = await makeFixture();
  const { project, fakeBinary } = await seedEnabledWorkspace(fixture);
  try {
    const { ctx, confirms } = makeCtx(fixture.workspace, { hasUI: false });
    await command(fixture).handler("off --confirm-delete", ctx);
    assert.equal(confirms.length, 0, "flag bypasses UI confirmation");
    assert.equal(existsSync(project.directory), false);
    assert.equal(existsSync(fakeBinary), true);
  } finally {
    await fixture.cleanup();
  }
});

test("command: off with unknown flag is a usage error", async () => {
  const fixture = await makeFixture();
  try {
    const { ctx, notifications } = makeCtx(fixture.workspace);
    await command(fixture).handler("off --yes", ctx);
    assert.ok(notifications.some(({ level, message }) => level === "error" && /Usage: \/wb:code-graph off/.test(message)));
  } finally {
    await fixture.cleanup();
  }
});

test("command: off respects a declined confirmation and keeps data", async () => {
  const fixture = await makeFixture();
  const { project } = await seedEnabledWorkspace(fixture);
  try {
    const { ctx, notifications } = makeCtx(fixture.workspace, { confirmAnswer: false });
    await command(fixture).handler("off", ctx);
    assert.ok(existsSync(project.directory), "data retained after decline");
    assert.ok(notifications.some(({ message }) => /cancelled/.test(message)));
  } finally {
    await fixture.cleanup();
  }
});

test("command: off stops the owned MCP registration before deletion", async () => {
  const fixture = await makeFixture();
  const { project } = await seedEnabledWorkspace(fixture);
  try {
    // Simulate the registration a restored session would hold.
    const managerRegistration = fixture.piState.mcp.set("codebase-memory", { command: "x" });
    // The command stops through the extension's manager; it only holds
    // registrations it made itself, so pre-seeded entries are not claimed.
    // Instead: restore through session_start first, then /off.
    fixture.piState.mcp.delete("codebase-memory");
    void managerRegistration;
    const startCtx = makeCtx(fixture.workspace);
    await fixture.piState.handlers.get("session_start")({}, startCtx.ctx);
    await waitFor(() => fixture.piState.mcp.has("codebase-memory"), 15000, "MCP registration");
    assert.equal(fixture.piState.unregistered.length, 0);

    const { ctx, notifications } = makeCtx(fixture.workspace, { confirmAnswer: true });
    await command(fixture).handler("off --confirm-delete", ctx);
    assert.deepEqual(fixture.piState.unregistered, ["codebase-memory"], "owned server unregistered");
    assert.equal(existsSync(project.directory), false);
    assert.ok(notifications.some(({ message }) => /Code graph deleted/.test(message)));
  } finally {
    await fixture.cleanup();
  }
});

// ─── Session lifecycle ────────────────────────────────────────────────

test("session start with no state stays off without error noise", async () => {
  const fixture = await makeFixture();
  try {
    const { ctx, notifications } = makeCtx(fixture.workspace);
    await fixture.piState.handlers.get("session_start")({}, ctx);
    // Allow the fire-and-forget restore to settle.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(fixture.piState.mcp.size, 0);
    assert.ok(
      !notifications.some(({ level, message }) => level === "warning" && /code graph/i.test(message)),
      JSON.stringify(notifications),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("session start with valid state restores and injects guidance", async () => {
  const fixture = await makeFixture();
  const { project, fakeBinary } = await seedEnabledWorkspace(fixture);
  try {
    const { ctx, notifications, statuses } = makeCtx(fixture.workspace);
    await fixture.piState.handlers.get("session_start")({}, ctx);
    await waitFor(() => fixture.piState.mcp.has("codebase-memory"), 15000, "MCP registration");
    const config = fixture.piState.mcp.get("codebase-memory");
    assert.equal(config.command, fakeBinary);
    assert.equal(config.cwd, project.projectPath);
    assert.equal(config.env.CBM_CACHE_DIR, project.directory);
    assert.ok(statuses.some(([key]) => key === "code-graph"), "code-graph status key set");
    assert.ok(!notifications.some(({ message }) => message.includes("structural")), "no user guidance notification");
    const promptEvent = { systemPromptOptions: { sections: {} } };
    fixture.piState.handlers.get("before_agent_start")(promptEvent);
    assert.match(promptEvent.systemPromptOptions.sections["pi-workbench-code-graph"], /structural/);
  } finally {
    await fixture.cleanup();
  }
});

test("session start with corrupt state stays off with a diagnostic", async () => {
  const fixture = await makeFixture();
  const { project } = await seedEnabledWorkspace(fixture);
  try {
    // Keep state.json but break the CBM config so validation is corrupt.
    await rm(join(project.directory, "_config.db"));
    const { ctx, notifications } = makeCtx(fixture.workspace);
    await fixture.piState.handlers.get("session_start")({}, ctx);
    await waitFor(
      () => notifications.some(({ level, message }) => level === "warning" && /code graph corrupt/i.test(message)),
      10000,
      "corrupt diagnostic",
    );
    assert.equal(fixture.piState.mcp.size, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("session shutdown releases only the owned registration", async () => {
  const fixture = await makeFixture();
  await seedEnabledWorkspace(fixture);
  try {
    const startCtx = makeCtx(fixture.workspace);
    await fixture.piState.handlers.get("session_start")({}, startCtx.ctx);
    await waitFor(() => fixture.piState.mcp.has("codebase-memory"), 15000, "MCP registration");
    await fixture.piState.handlers.get("session_shutdown")(undefined, undefined);
    assert.deepEqual(fixture.piState.unregistered, ["codebase-memory"]);
    assert.equal(fixture.piState.mcp.size, 0);
  } finally {
    await fixture.cleanup();
  }
});
