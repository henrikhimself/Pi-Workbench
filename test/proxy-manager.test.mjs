/**
 * Unit tests for src/proxy-manager.ts — proxy lifecycle logic.
 *
 * Network-free: uses a local mock HTTP server for health checks.
 * Never triggers pip install / venv creation.
 *
 * Run: node --test test/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { acquireStartupLock, findPython, ProxyManager } = await jiti.import("../src/proxy-manager.ts");

/** Start a mock proxy: answers 200 on GET /health. Resolves with the bound port. */
async function startMockProxy() {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return { server, port };
}

// ─── findPython ───────────────────────────────────────────────────────

test("findPython: detects a Python >= 3.10 interpreter on this machine", async () => {
  const cmd = await findPython();
  assert.ok(cmd, "expected a python interpreter (python3) to be found");
  assert.ok(["python3", "python"].includes(cmd));
});

// ─── Startup lock ─────────────────────────────────────────────────────

test("acquireStartupLock: waits for current owner before granting next owner", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-headroom-lock-"));
  const lockDir = join(tempDir, "startup.lock");

  try {
    const firstRelease = await acquireStartupLock(lockDir, () => {}, () => false);
    assert.ok(firstRelease);

    let secondAcquired = false;
    const secondLock = acquireStartupLock(lockDir, () => {}, () => false).then((release) => {
      secondAcquired = true;
      return release;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(secondAcquired, false);

    await firstRelease();
    const secondRelease = await secondLock;
    assert.ok(secondRelease);
    assert.equal(secondAcquired, true);
    await secondRelease();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ─── ProxyManager basics ──────────────────────────────────────────────

test("baseUrl: reflects configured port and host", () => {
  const pm = new ProxyManager({ port: 1234, host: "127.0.0.1" });
  assert.equal(pm.baseUrl, "http://127.0.0.1:1234");
  assert.equal(pm.isManaged, false);
});

test("baseUrl: defaults to 8787", () => {
  const pm = new ProxyManager();
  assert.equal(pm.baseUrl, "http://127.0.0.1:8787");
});

// ─── healthCheck ──────────────────────────────────────────────────────

test("healthCheck: false when nothing listens", async () => {
  // Find a free port, then check it (nothing listening)
  const { server, port } = await startMockProxy();
  await new Promise((resolve) => server.close(resolve));
  const pm = new ProxyManager({ port });
  assert.equal(await pm.healthCheck(), false);
});

test("healthCheck: true when proxy responds", async () => {
  const { server, port } = await startMockProxy();
  try {
    const pm = new ProxyManager({ port });
    assert.equal(await pm.healthCheck(), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ─── stop() idempotency ───────────────────────────────────────────────

test("stop(): safe to call when proxy was never started (idempotent)", async () => {
  const pm = new ProxyManager({ port: 1 });
  await pm.stop();
  await pm.stop(); // second call must not throw
  assert.equal(pm.isManaged, false);
});

// ─── ensureRunning: external proxy detection ──────────────────────────

test("ensureRunning: detects already-running external proxy, does not take ownership", async () => {
  const { server, port } = await startMockProxy();
  try {
    const pm = new ProxyManager({ port });
    const statuses = [];
    const ok = await pm.ensureRunning((msg) => statuses.push(msg));
    assert.equal(ok, true);
    assert.equal(pm.isManaged, false); // external — extension must not kill it on shutdown
    // No spawn-related status updates expected on the fast path
    assert.ok(!statuses.some((s) => s.includes("Installing") || s.includes("venv")));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("tryRestart: restarts after an owned child exits", async () => {
  const pm = new ProxyManager({ port: 1 });
  const internal = pm;
  const exitedChild = { exitCode: 1 };
  internal.managedByThisInstance = true;
  internal.proc = exitedChild;
  internal.handleChildExit(exitedChild);

  assert.equal(pm.isManaged, true, "unexpected exit must retain extension ownership");
  assert.equal(internal.proc, null);

  let starts = 0;
  internal.ensureRunning = async () => {
    starts++;
    internal.proc = { exitCode: null };
    return true;
  };

  const recovered = await pm.tryRestart(() => {});
  assert.equal(recovered, true);
  assert.equal(starts, 1);
  assert.equal(pm.isManaged, true);
});

test("tryRestart: replaces unhealthy owned child before its exit event arrives", async () => {
  const pm = new ProxyManager({ port: 1 });
  const internal = pm;
  let killed = false;
  internal.managedByThisInstance = true;
  internal.proc = {
    exitCode: null,
    kill: () => { killed = true; },
  };
  let starts = 0;
  internal.ensureRunning = async () => {
    starts++;
    internal.proc = { exitCode: null };
    return true;
  };

  const recovered = await pm.tryRestart(() => {});
  assert.equal(recovered, true);
  assert.equal(killed, true);
  assert.equal(starts, 1);
});

test("ensureRunning: fails fast while shutdown is in progress (stopping guard)", async () => {
  // Deliberately does NOT exercise the install/spawn path (would pip install).
  // stop() sets the stopping flag; ensureRunning must bail without touching python.
  const pm = new ProxyManager({ port: 1 });
  await pm.stop();
  const ok = await pm.ensureRunning(() => {});
  assert.equal(ok, false);
});
