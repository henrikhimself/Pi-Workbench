import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createJiti } from "jiti";
import { fakeCbmSource } from "./helpers/fake-cbm.mjs";

const jiti = createJiti(import.meta.url);
const {
  CodeGraphManager,
  CODE_GRAPH_EXPECTED_TOOL_COUNT,
  CODE_GRAPH_GUIDANCE_MESSAGE,
  CODE_GRAPH_MCP_SERVER_NAME,
  createCbmEnvironment,
  createCodeGraphManager,
  curlShimDirectory,
  defaultMcpHandshakeRunner,
  ensureCurlDenyShim,
} = await jiti.import("../src/code-graph-manager.ts");
const {
  createCodeGraphState,
  resolveCodeGraphProject,
  validateCodeGraphState,
  writeCodeGraphStateAtomic,
} = await jiti.import("../src/code-graph-config.ts");
const { detectCodeGraphPlatform, installedBinaryPath } = await jiti.import("../src/code-graph-installer.ts");
const { resolveWorkbenchPaths } = await jiti.import("../src/paths.ts");

const REAL_CBM_BINARY = "/tmp/cbm-v081.cyG8Me/extracted/codebase-memory-mcp";


async function writeFakeCbm(dir, name, config = {}) {
  const scriptPath = join(dir, name);
  await writeFile(scriptPath, fakeCbmSource(config), "utf8");
  await import("node:fs/promises").then((fsp) => fsp.chmod(scriptPath, 0o755));
  return scriptPath;
}

// ─── Fixtures ─────────────────────────────────────────────────────────

async function makeFixture() {
  const home = await mkdtemp(join(tmpdir(), "cg-manager-home-"));
  const paths = resolveWorkbenchPaths(home);
  const workspace = await mkdtemp(join(tmpdir(), "cg-manager-ws-"));
  const project = resolveCodeGraphProject(workspace, paths);
  const fakeDir = await mkdtemp(join(tmpdir(), "cg-manager-fake-"));
  const calls = [];
  const ensureInstalled = async () => {
    calls.push("ensureInstalled");
    throw new Error("installer must not be called in this test");
  };
  const deps = {
    paths,
    ensureInstalled,
    onStatus: () => {},
  };
  return {
    home,
    paths,
    workspace,
    project,
    fakeDir,
    calls,
    makeDeps: (overrides = {}) => ({ ...deps, ...overrides }),
    cleanup: async () => {
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
      await rm(fakeDir, { recursive: true, force: true });
    },
  };
}

async function writeValidState(project, paths, fakeDir, { version = "v0.8.1" } = {}) {
  const binary = await writeFakeCbm(fakeDir, `cbm-state-${version.replace(/\./g, "-")}.cjs`, {});
  await mkdir(project.directory, { recursive: true });
  await writeFile(join(project.directory, "_config.db"), "auto_index = true\n", "utf8");
  await writeFile(join(project.directory, "derived-project.db"), "INDEX", "utf8");
  const state = createCodeGraphState(project, {
    version,
    resolvedUrl: "https://github.com/abseil/codebase-memory-mcp/releases/download/v0.8.1/codebase-memory-mcp-linux-arm64.tar.gz",
    sha256: "d2f842d1365da5c35d9c5796f57a821c9745267350994346735e1e6e04d46091",
  });
  await writeCodeGraphStateAtomic(project, state);
  return { binary, state };
}

const FAKE_SHA = "d2f842d1365da5c35d9c5796f57a821c9745267350994346735e1e6e04d46091";
const FAKE_URL = "https://github.com/abseil/codebase-memory-mcp/releases/download/v0.8.1/codebase-memory-mcp-linux-arm64.tar.gz";

function installResult(binaryPath) {
  return { path: binaryPath, version: "v0.8.1", resolvedUrl: FAKE_URL, sha256: FAKE_SHA, reused: true };
}

function okHandshake(overrides = {}) {
  return async () => ({
    ok: true,
    tools: Array.from({ length: CODE_GRAPH_EXPECTED_TOOL_COUNT }, (_, i) => `tool_${i}`),
    ...overrides,
  });
}

// ─── Shim and environment ─────────────────────────────────────────────

test("ensureCurlDenyShim creates an executable deny script atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cg-shim-"));
  try {
    const shimPath = join(dir, "deny-shims", "curl");
    await ensureCurlDenyShim(shimPath);
    const info = await stat(shimPath);
    assert.equal(info.mode & 0o777, 0o755);
    const content = await readFile(shimPath, "utf8");
    assert.match(content, /^#!\/bin\/sh\nexit 3\n$/);
    const siblings = await readdir(join(dir, "deny-shims"));
    assert.deepEqual(siblings, ["curl"]);
    // Idempotent re-run.
    await ensureCurlDenyShim(shimPath);
    assert.deepEqual(await readdir(join(dir, "deny-shims")), ["curl"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("curlShimDirectory returns the PATH entry to prepend", () => {
  assert.equal(curlShimDirectory("/x/y/deny-shims/curl"), "/x/y/deny-shims");
});

test("createCbmEnvironment builds the minimal owned-child environment", () => {
  const source = {
    PATH: "/usr/bin:/bin",
    HOME: "/home/user",
    CBM_DOWNLOAD_URL: "https://evil.example/cbm",
    CBM_OTHER: "must-not-escape",
  };
  const env = createCbmEnvironment({ projectDirectory: "/proj", shimPath: "/root/deny-shims/curl", source });
  assert.equal(env.CBM_CACHE_DIR, "/proj");
  assert.equal(env.CBM_LOG_LEVEL, "error");
  assert.ok(env.PATH.startsWith("/root/deny-shims:/"));
  assert.equal(env.PATH, "/root/deny-shims:/usr/bin:/bin");
  assert.equal(env.HOME, "/home/user");
  assert.equal("CBM_DOWNLOAD_URL" in env, false);
  assert.equal("CBM_OTHER" in env, false);
  // Pure: the source object is never mutated.
  assert.deepEqual(source, {
    PATH: "/usr/bin:/bin",
    HOME: "/home/user",
    CBM_DOWNLOAD_URL: "https://evil.example/cbm",
    CBM_OTHER: "must-not-escape",
  });
});

/** Minimal probe environment that can still resolve the `node` interpreter. */
function probeEnv(cacheDir) {
  return {
    PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
    HOME: "/tmp",
    LANG: "C.UTF-8",
    CBM_CACHE_DIR: cacheDir,
    CBM_LOG_LEVEL: "error",
  };
}

// ─── MCP handshake probe ──────────────────────────────────────────────

test("handshake probe validates initialize + 14 tools and kills the probe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cg-hs-"));
  const workspace = await mkdtemp(join(tmpdir(), "cg-hs-ws-"));
  let cleaned = false;
  try {
    const killedMarker = join(dir, "killed");
    const fake = await writeFakeCbm(dir, "cbm-ok.cjs", { killedMarker });
    const env = probeEnv(dir);
    const result = await defaultMcpHandshakeRunner()({
      command: fake,
      args: [],
      cwd: workspace,
      env,
      timeoutMs: 15_000,
      expectedToolCount: 14,
    });
    assert.equal(result.ok, true);
    assert.equal(result.tools.length, 14);
    assert.equal(result.tools[0], "tool_0");
    await new Promise((r) => setTimeout(r, 150));
    const marker = await readFile(killedMarker, "utf8").catch(() => null);
    assert.equal(marker, "killed");
  } finally {
    if (!cleaned) {
      await rm(dir, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  }
});

test("handshake probe rejects wrong tool count", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cg-hs-"));
  const workspace = await mkdtemp(join(tmpdir(), "cg-hs-ws-"));
  try {
    const fake = await writeFakeCbm(dir, "cbm-13.cjs", { toolCount: 13 });
    const env = probeEnv(dir);
    const result = await defaultMcpHandshakeRunner()({
      command: fake,
      args: [],
      cwd: workspace,
      env,
      timeoutMs: 15_000,
      expectedToolCount: 14,
    });
    assert.equal(result.ok, false);
    assert.match(result.detail ?? "", /tool count mismatch: got 13, expected 14/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("handshake probe rejects noisy (non-JSON-RPC) stdout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cg-hs-"));
  const workspace = await mkdtemp(join(tmpdir(), "cg-hs-ws-"));
  try {
    const fake = await writeFakeCbm(dir, "cbm-noisy.cjs", { noisyStdout: true });
    const env = probeEnv(dir);
    const result = await defaultMcpHandshakeRunner()({
      command: fake,
      args: [],
      cwd: workspace,
      env,
      timeoutMs: 15_000,
      expectedToolCount: 14,
    });
    assert.equal(result.ok, false);
    assert.match(result.detail ?? "", /non-JSON-RPC/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("handshake probe rejects protocol version mismatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cg-hs-"));
  const workspace = await mkdtemp(join(tmpdir(), "cg-hs-ws-"));
  try {
    const fake = await writeFakeCbm(dir, "cbm-proto.cjs", { protocol: "2025-03-26" });
    const env = probeEnv(dir);
    const result = await defaultMcpHandshakeRunner()({
      command: fake,
      args: [],
      cwd: workspace,
      env,
      timeoutMs: 15_000,
      expectedToolCount: 14,
    });
    assert.equal(result.ok, false);
    assert.match(result.detail ?? "", /protocol mismatch/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("handshake probe times out on a hanging server", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cg-hs-"));
  const workspace = await mkdtemp(join(tmpdir(), "cg-hs-ws-"));
  try {
    const fake = await writeFakeCbm(dir, "cbm-hang.cjs", { mcpHang: true });
    const env = probeEnv(dir);
    const result = await defaultMcpHandshakeRunner()({
      command: fake,
      args: [],
      cwd: workspace,
      env,
      timeoutMs: 700,
      expectedToolCount: 14,
    });
    assert.equal(result.ok, false);
    assert.match(result.detail ?? "", /timed out/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("handshake probe reports early exit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cg-hs-"));
  const workspace = await mkdtemp(join(tmpdir(), "cg-hs-ws-"));
  try {
    const exitScript = join(dir, "cbm-exit.cjs");
    await writeFile(exitScript, "#!/usr/bin/env node\nprocess.exit(9);\n", "utf8");
    await import("node:fs/promises").then((fsp) => fsp.chmod(exitScript, 0o755));
    const env = probeEnv(dir);
    const result = await defaultMcpHandshakeRunner()({
      command: exitScript,
      args: [],
      cwd: workspace,
      env,
      timeoutMs: 10_000,
      expectedToolCount: 14,
    });
    assert.equal(result.ok, false);
    assert.match(result.detail ?? "", /exited before handshake/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

// ─── Manager: activation transaction ──────────────────────────────────

test("activate: full transaction publishes state, registers MCP, reports tools", async () => {
  const fx = await makeFixture();
  try {
    const binary = await writeFakeCbm(fx.fakeDir, "cbm-active.cjs", {
      callLog: join(fx.fakeDir, "calls.log"),
    });
    const registered = [];
    const unregistered = [];
    const manager = new CodeGraphManager(
      fx.makeDeps({
        ensureInstalled: async () => installResult(binary),
        registerMcp: (name, config) => registered.push({ name, config }),
        unregisterMcp: (name) => unregistered.push(name),
      }),
    );
    const result = await manager.activate(fx.project);
    assert.equal(result.ok, true);
    assert.equal(result.alreadyOn, false);
    assert.equal(result.tools.length, 14);
    assert.equal(result.state.version, "v0.8.1");

    // State + CBM data published below the project directory only.
    const stateCheck = validateCodeGraphState(fx.project);
    assert.equal(stateCheck.ok, true);
    const listing = await readdir(fx.project.directory);
    assert.ok(listing.includes("state.json"));
    assert.ok(listing.includes("_config.db"));
    assert.ok(listing.some((name) => name.endsWith(".db") && name !== "_config.db"));
    // Curl deny shim materialized under the managed root.
    await stat(fx.paths.codeGraphCurlShim);

    // Registration shape: direct stdio, workspace CWD, owned env.
    assert.equal(registered.length, 1);
    assert.equal(registered[0].name, CODE_GRAPH_MCP_SERVER_NAME);
    const config = registered[0].config;
    assert.equal(config.command, binary);
    assert.deepEqual(config.args, []);
    assert.equal(config.cwd, fx.project.projectPath);
    assert.equal(config.exposure, "direct");
    assert.equal(config.env.CBM_CACHE_DIR, fx.project.directory);
    assert.equal(config.env.CBM_LOG_LEVEL, "error");
    assert.ok(config.env.PATH.startsWith(`${curlShimDirectory(fx.paths.codeGraphCurlShim)}:`));
    assert.equal("CBM_DOWNLOAD_URL" in config.env, false);

    const callLog = await readFile(join(fx.fakeDir, "calls.log"), "utf8");
    assert.ok(callLog.includes("index-repository"));
    assert.equal(manager.isMcpRegistered, true);
  } finally {
    await fx.cleanup();
  }
});

test("bare curl inside the owned CBM environment resolves to the deny shim", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cg-mgr-shim-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shimPath = join(root, "deny-shims", "curl");
  await ensureCurlDenyShim(shimPath);
  const env = createCbmEnvironment({ projectDirectory: join(root, "proj"), shimPath });
  // Resolve + run exactly what a CBM child would run when it invokes a bare
  // `curl` for its upstream update check: PATH puts the shim directory
  // first, so the deny shim must win over the host curl. The shim exits 3
  // with no output — CBM treats that as a failed update check and proceeds
  // without one.
  const result = await new Promise((resolve) => {
    const child = spawn("curl", ["https://github.com/DeusData/codebase-memory-mcp/releases/latest"], {
      env: { PATH: env.PATH },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.on("close", (code) => resolve({ code, stdout }));
  });
  assert.equal(result.code, 3);
  assert.equal(result.stdout, "");
});

test("activate: workspace path with spaces and shell metacharacters stays a JSON argument", async () => {
  const fx = await makeFixture();
  try {
    const nastyWorkspace = join(fx.workspace, "my proj (1); rm -rf ~ && echo `id`");
    await mkdir(nastyWorkspace, { recursive: true });
    const project = resolveCodeGraphProject(nastyWorkspace, fx.paths);
    const binary = await writeFakeCbm(fx.fakeDir, "cbm-nasty.cjs", {});
    const recorded = [];
    const manager = new CodeGraphManager(
      fx.makeDeps({
        paths: fx.paths,
        ensureInstalled: async () => installResult(binary),
        runProcess: async (command, args, options) => {
          recorded.push({ command, args, cwd: options.cwd, env: options.env });
          // Emulate the fake CLI from captured arguments.
          if (args[0] === "config" && args[1] === "set") {
            await mkdir(options.env.CBM_CACHE_DIR, { recursive: true });
            await writeFile(join(options.env.CBM_CACHE_DIR, "_config.db"), "auto_index = true\n");
            return { exitCode: 0, stdout: "auto_index = true\n", stderr: "" };
          }
          if (args[0] === "config" && args[1] === "get") {
            return { exitCode: 0, stdout: "true\n", stderr: "" };
          }
          if (args[0] === "cli" && args[1] === "index_repository") {
            const request = JSON.parse(args[2]);
            assert.equal(request.repo_path, project.projectPath);
            const projectName = project.projectPath.replace(/^\//, "").replace(/\//g, "-");
            await writeFile(join(options.env.CBM_CACHE_DIR, `${projectName}.db`), "INDEX");
            return { exitCode: 0, stdout: JSON.stringify({ project: projectName, status: "indexed" }) + "\n", stderr: "" };
          }
          if (args[0] === "cli" && args[1] === "list_projects") {
            return { exitCode: 0, stdout: JSON.stringify({ projects: ["p"] }) + "\n", stderr: "" };
          }
          if (args[0] === "cli" && args[1] === "index_status") {
            return { exitCode: 0, stdout: JSON.stringify({ project: "p", status: "ready" }) + "\n", stderr: "" };
          }
          throw new Error(`unexpected args: ${JSON.stringify(args)}`);
        },
        runMcpHandshake: okHandshake(),
        registerMcp: () => {},
      }),
    );
    const result = await manager.activate(project);
    assert.equal(result.ok, true);
    const indexCall = recorded.find((call) => call.args[1] === "index_repository");
    assert.ok(indexCall);
    assert.deepEqual(JSON.parse(indexCall.args[2]), { repo_path: project.projectPath });
    // Every owned call ran from the workspace root with the minimal env.
    for (const call of recorded) {
      assert.equal(call.cwd, project.projectPath);
      assert.equal(call.env.CBM_CACHE_DIR, project.directory);
      assert.equal("CBM_DOWNLOAD_URL" in call.env, false);
    }
  } finally {
    await fx.cleanup();
  }
});

test("activate: index failure rolls back staging, publishes no state, registers nothing", async () => {
  const fx = await makeFixture();
  try {
    const binary = await writeFakeCbm(fx.fakeDir, "cbm-fail-index.cjs", { failIndex: true });
    const registered = [];
    const manager = new CodeGraphManager(
      fx.makeDeps({
        ensureInstalled: async () => installResult(binary),
        registerMcp: (name) => registered.push(name),
      }),
    );
    const result = await manager.activate(fx.project);
    assert.equal(result.ok, false);
    assert.equal(result.kind, "mcp_failed");
    assert.match(result.detail, /index_repository failed/);
    assert.equal(registered.length, 0);
    // Staging directory rolled back; no state.json survived.
    await assert.rejects(stat(fx.project.directory));
    await assert.rejects(stat(fx.project.statePath));
  } finally {
    await fx.cleanup();
  }
});

test("activate: handshake failure keeps the transaction unpublished", async () => {
  const fx = await makeFixture();
  try {
    const binary = await writeFakeCbm(fx.fakeDir, "cbm-bad-tools.cjs", { toolCount: 13 });
    const manager = new CodeGraphManager(
      fx.makeDeps({
        ensureInstalled: async () => installResult(binary),
        registerMcp: () => assert.fail("must not register"),
      }),
    );
    const result = await manager.activate(fx.project);
    assert.equal(result.ok, false);
    assert.match(result.detail, /tool count mismatch/);
    await assert.rejects(stat(fx.project.statePath));
    await assert.rejects(stat(fx.project.directory));
  } finally {
    await fx.cleanup();
  }
});

test("activate: corrupt pre-existing state is reported, never auto-repaired or deleted", async () => {
  const fx = await makeFixture();
  try {
    await mkdir(fx.project.directory, { recursive: true });
    await writeFile(fx.project.statePath, "{not json", "utf8");
    const binary = await writeFakeCbm(fx.fakeDir, "cbm-unused.cjs", {});
    let installerCalls = 0;
    const manager = new CodeGraphManager(
      fx.makeDeps({
        ensureInstalled: async () => {
          installerCalls += 1;
          return installResult(binary);
        },
      }),
    );
    const result = await manager.activate(fx.project);
    assert.equal(result.ok, false);
    assert.equal(result.kind, "corrupt");
    assert.equal(installerCalls, 0);
    // Pre-existing directory preserved.
    await stat(fx.project.directory);
    assert.equal(await readFile(fx.project.statePath, "utf8"), "{not json");
  } finally {
    await fx.cleanup();
  }
});

test("activate: valid existing state reports already-on without reindexing", async () => {
  const fx = await makeFixture();
  try {
    const { binary } = await writeValidState(fx.project, fx.paths, fx.fakeDir);
    const callLog = join(fx.fakeDir, "already-on.log");
    const reindexingBinary = await writeFakeCbm(fx.fakeDir, "cbm-logged.cjs", { callLog });
    const registered = [];
    const manager = new CodeGraphManager(
      fx.makeDeps({
        ensureInstalled: async () => installResult(reindexingBinary),
        registerMcp: (name) => registered.push(name),
      }),
    );
    const result = await manager.activate(fx.project);
    assert.equal(result.ok, true);
    assert.equal(result.alreadyOn, true);
    assert.deepEqual(registered, [CODE_GRAPH_MCP_SERVER_NAME]);
    const log = await readFile(callLog, "utf8").catch(() => "");
    assert.ok(!log.includes("index-repository"), "must not reindex an enabled workspace");
    void binary;
  } finally {
    await fx.cleanup();
  }
});

// ─── Manager: restore (session start) ─────────────────────────────────

test("restore: absent state stays off without installer or CBM work", async () => {
  const fx = await makeFixture();
  try {
    const calls = [];
    const manager = new CodeGraphManager(
      fx.makeDeps({
        ensureInstalled: async () => {
          calls.push("install");
          throw new Error("installer must not run for a workspace without state");
        },
        runProcess: async () => {
          calls.push("cbm");
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        runMcpHandshake: okHandshake(),
      }),
    );
    const result = await manager.restore(fx.project);
    assert.equal(result.ok, false);
    assert.equal(result.kind, "off");
    assert.deepEqual(calls, []);
    assert.equal(manager.isMcpRegistered, false);
  } finally {
    await fx.cleanup();
  }
});

test("restore: valid state restores registration with verified binary", async () => {
  const fx = await makeFixture();
  try {
    await writeValidState(fx.project, fx.paths, fx.fakeDir);
    const binary = await writeFakeCbm(fx.fakeDir, "cbm-restore.cjs", {});
    const registered = [];
    const manager = new CodeGraphManager(
      fx.makeDeps({
        ensureInstalled: async () => installResult(binary),
        registerMcp: (name) => registered.push(name),
      }),
    );
    const result = await manager.restore(fx.project);
    assert.equal(result.ok, true);
    assert.equal(result.alreadyOn, true);
    assert.equal(result.tools.length, 14);
    assert.deepEqual(registered, [CODE_GRAPH_MCP_SERVER_NAME]);
  } finally {
    await fx.cleanup();
  }
});

test("restore: _config.db without auto_index=true is corrupt, not auto-repaired", async () => {
  const fx = await makeFixture();
  try {
    await writeValidState(fx.project, fx.paths, fx.fakeDir);
    await writeFile(join(fx.project.directory, "_config.db"), "auto_index = false\n", "utf8");
    const binary = await writeFakeCbm(fx.fakeDir, "cbm-restore2.cjs", {});
    let registered = false;
    const manager = new CodeGraphManager(
      fx.makeDeps({
        ensureInstalled: async () => installResult(binary),
        registerMcp: () => {
          registered = true;
        },
      }),
    );
    const result = await manager.restore(fx.project);
    assert.equal(result.ok, false);
    assert.equal(result.kind, "corrupt");
    assert.match(result.detail, /auto_index/);
    assert.equal(registered, false);
    // No auto-repair: the config stays false.
    assert.equal(await readFile(join(fx.project.directory, "_config.db"), "utf8"), "auto_index = false\n");
  } finally {
    await fx.cleanup();
  }
});

test("restore: packaged update failure falls back to prior verified binary", { skip: detectCodeGraphPlatform({ os: process.platform, arch: process.arch }) === null ? "host platform outside approved scope" : false }, async () => {
  const fx = await makeFixture();
  try {
    const { state } = await writeValidState(fx.project, fx.paths, fx.fakeDir);
    // Seed a prior verified install at the state version.
    const platform = detectCodeGraphPlatform({ os: process.platform, arch: process.arch });
    const priorDir = join(fx.paths.codeGraphBin, state.version, platform);
    await mkdir(priorDir, { recursive: true });
    const priorBinary = await writeFakeCbm(fx.fakeDir, "cbm-prior.cjs", {});
    await import("node:fs/promises").then((fsp) => fsp.copyFile(priorBinary, join(priorDir, "codebase-memory-mcp")));
    await import("node:fs/promises").then((fsp) => fsp.chmod(join(priorDir, "codebase-memory-mcp"), 0o755));
    await writeFile(
      join(priorDir, "asset.json"),
      JSON.stringify({ version: state.version, resolvedUrl: FAKE_URL, sha256: FAKE_SHA, installedAt: new Date().toISOString() }),
      "utf8",
    );

    const statuses = [];
    const registered = [];
    const manager = new CodeGraphManager(
      fx.makeDeps({
        ensureInstalled: async () => {
          throw new Error("simulated packaged update failure");
        },
        onStatus: (message) => statuses.push(message),
        registerMcp: (name) => registered.push(name),
      }),
    );
    const result = await manager.restore(fx.project);
    assert.equal(result.ok, true);
    assert.equal(result.binaryPath, join(priorDir, "codebase-memory-mcp"));
    assert.deepEqual(registered, [CODE_GRAPH_MCP_SERVER_NAME]);
    assert.ok(statuses.some((message) => message.includes("retaining verified")));
  } finally {
    await fx.cleanup();
  }
});

test("restore: no fallback binary leaves workspace off (fail-open)", { skip: detectCodeGraphPlatform({ os: process.platform, arch: process.arch }) === null ? "host platform outside approved scope" : false }, async () => {
  const fx = await makeFixture();
  try {
    await writeValidState(fx.project, fx.paths, fx.fakeDir);
    let registered = false;
    const manager = new CodeGraphManager(
      fx.makeDeps({
        ensureInstalled: async () => {
          throw new Error("simulated packaged update failure");
        },
        registerMcp: () => {
          registered = true;
        },
      }),
    );
    const result = await manager.restore(fx.project);
    assert.equal(result.ok, false);
    assert.equal(result.kind, "binary_missing");
    assert.equal(registered, false);
  } finally {
    await fx.cleanup();
  }
});

// ─── Manager: ownership, stop, shutdown, status ───────────────────────

test("stop is idempotent and only releases the owned registration", async () => {
  const fx = await makeFixture();
  try {
    const binary = await writeFakeCbm(fx.fakeDir, "cbm-stop.cjs", {});
    const unregistered = [];
    const manager = new CodeGraphManager(
      fx.makeDeps({
        ensureInstalled: async () => installResult(binary),
        registerMcp: () => {},
        unregisterMcp: (name) => unregistered.push(name),
      }),
    );
    const result = await manager.activate(fx.project);
    assert.equal(result.ok, true);
    manager.stop(fx.project);
    assert.equal(manager.isMcpRegistered, false);
    manager.stop(fx.project); // idempotent
    manager.shutdown(); // no-op after stop
    assert.deepEqual(unregistered, [CODE_GRAPH_MCP_SERVER_NAME]);
  } finally {
    await fx.cleanup();
  }
});

test("shutdown releases the owned registration on session end", async () => {
  const fx = await makeFixture();
  try {
    const binary = await writeFakeCbm(fx.fakeDir, "cbm-shutdown.cjs", {});
    const unregistered = [];
    const manager = new CodeGraphManager(
      fx.makeDeps({
        ensureInstalled: async () => installResult(binary),
        registerMcp: () => {},
        unregisterMcp: (name) => unregistered.push(name),
      }),
    );
    await manager.activate(fx.project);
    manager.shutdown();
    assert.deepEqual(unregistered, [CODE_GRAPH_MCP_SERVER_NAME]);
    assert.equal(manager.isMcpRegistered, false);
  } finally {
    await fx.cleanup();
  }
});

test("sibling workspace stop does not touch this registration", async () => {
  const fx = await makeFixture();
  try {
    const siblingWorkspace = await mkdtemp(join(tmpdir(), "cg-manager-sib-"));
    try {
      const sibling = resolveCodeGraphProject(siblingWorkspace, fx.paths);
      const binary = await writeFakeCbm(fx.fakeDir, "cbm-sib.cjs", {});
      const unregistered = [];
      const manager = new CodeGraphManager(
        fx.makeDeps({
          ensureInstalled: async () => installResult(binary),
          registerMcp: () => {},
          unregisterMcp: (name) => unregistered.push(name),
        }),
      );
      await manager.activate(fx.project);
      manager.stop(sibling); // different project: no-op
      assert.equal(manager.isMcpRegistered, true);
      assert.deepEqual(unregistered, []);
      manager.stop(fx.project);
      assert.deepEqual(unregistered, [CODE_GRAPH_MCP_SERVER_NAME]);
    } finally {
      await rm(siblingWorkspace, { recursive: true, force: true });
    }
  } finally {
    await fx.cleanup();
  }
});

test("buildStatusReport reflects state without side effects", async () => {
  const fx = await makeFixture();
  try {
    const manager = new CodeGraphManager(fx.makeDeps());
    const off = await manager.buildStatusReport({
      project: fx.project,
      platform: "linux-arm64",
      manifestVersion: "v0.8.1",
    });
    assert.equal(off.kind, "off");
    assert.equal(off.recovery, "Run /wb:code-graph on to enable code graph for this workspace.");

    await writeValidState(fx.project, fx.paths, fx.fakeDir);
    const enabled = await manager.buildStatusReport({
      project: fx.project,
      platform: "linux-arm64",
      manifestVersion: "v0.8.1",
      installedVersion: "v0.8.1",
      indexSummary: "project p: ready, 3 nodes, 2 edges",
    });
    assert.equal(enabled.kind, "enabled");
    assert.equal(enabled.mcpRegistered, false);
    assert.ok(enabled.watcher === "git" || enabled.watcher === "disabled_non_git");

    await writeFile(fx.project.statePath, "{broken", "utf8");
    const corrupt = await manager.buildStatusReport({ project: fx.project, platform: "linux-arm64" });
    assert.equal(corrupt.kind, "corrupt");
    assert.match(corrupt.recovery ?? "", /off to clear/);
  } finally {
    await fx.cleanup();
  }
});

test("guidance message exists and mentions verification", () => {
  assert.equal(typeof CODE_GRAPH_GUIDANCE_MESSAGE, "string");
  assert.match(CODE_GRAPH_GUIDANCE_MESSAGE, /verify/i);
});

// ─── Real binary integration (gated on spike artifact) ────────────────

test(
  "handshake probe validates the real CBM v0.8.1 binary (14 tools, clean stdout)",
  { skip: (await stat(REAL_CBM_BINARY).then(() => false, () => true)) ? "spike binary not present" : false, timeout: 60_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "cg-hs-real-"));
    const workspace = await mkdtemp(join(tmpdir(), "cg-hs-real-ws-"));
    try {
      const env = { PATH: "/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8", CBM_CACHE_DIR: dir, CBM_LOG_LEVEL: "error" };
      const result = await defaultMcpHandshakeRunner()({
        command: REAL_CBM_BINARY,
        args: [],
        cwd: workspace,
        env,
        timeoutMs: 45_000,
        expectedToolCount: 14,
      });
      assert.equal(result.ok, true, result.detail);
      assert.equal(result.tools.length, 14);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  },
);

test("createCodeGraphManager builds a production-bound manager", async () => {
  const fx = await makeFixture();
  try {
    const binary = await writeFakeCbm(fx.fakeDir, "cbm-prod.cjs", {});
    let registered = false;
    const manager = createCodeGraphManager({
      paths: fx.paths,
      installer: async () => installResult(binary),
      registerMcp: () => {
        registered = true;
      },
      unregisterMcp: () => {},
    });
    assert.ok(manager instanceof CodeGraphManager);
    const result = await manager.activate(fx.project);
    assert.equal(result.ok, true);
    assert.equal(registered, true);
    manager.shutdown();
    assert.equal(registered, true);
  } finally {
    await fx.cleanup();
  }
});
