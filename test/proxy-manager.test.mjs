/** Hermetic managed-ownership tests. Local HTTP fixture only; no pip/model/real proxy. */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
async function waitHealth(manager) {
  const deadline = Date.now() + 2000;
  do { if (await manager.healthCheck()) return true; await new Promise(done => setTimeout(done, 20)); } while (Date.now() < deadline);
  return false;
}
const { ProxyManager, acquireStartupLock, findPython, getHeadroomAiVersion } = await jiti.import("../src/proxy-manager.ts");
const { createConsumerLease, ownIdentity, publishJson } = await jiti.import("../src/managed-lifecycle.ts");

async function fixture(fn, { owned = true, verifier = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "wb-proxy-ownership-"));
  const slot = join(root, "runtimes", "0.41.0", "fixture"); await mkdir(join(slot, "bin"), { recursive: true, mode: 0o700 });
  const python = join(slot, "bin", "python"); await writeFile(python, "fixture", { mode: 0o700 });
  const descriptor = { schema: 1, version: "0.41.0", slot, python, cli: join(slot, "bin", "headroom"), inventory: [], pythonIdentity: "fixture", dependencyDigest: "fixture", embedding: { model: "Qdrant/all-MiniLM-L6-v2-onnx", dimensions: 384, provider: "CPUExecutionProvider" } };
  await publishJson(root, join(slot, "ready.json"), descriptor);
  const identity = await ownIdentity(); const nonce = "a".repeat(64);
  const state = { healthy: true, alive: true, version: "0.41.0", nonce, requests: 0, installs: 0, killed: 0, starts: 0 };
  const tag = createHash("sha256").update(`${python}|0.41.0`).digest("hex");
  let server;
  async function listen(port = 0) {
    server = http.createServer((req, res) => {
      state.requests++;
      if (req.url !== "/health" && state.onRequest) { void state.onRequest(req, res); return; }
      if (req.url !== "/health") { res.writeHead(404); res.end(); return; }
      res.writeHead(state.healthy ? 200 : 503, { "content-type": "application/json", "x-pi-workbench-owner": state.replayedProof ?? createHmac("sha256", Buffer.from(state.nonce, "hex")).update(`health:${req.headers["x-pi-workbench-challenge"]}:${tag}`).digest("hex"), "x-pi-workbench-runtime": tag });
      res.end(JSON.stringify({ version: state.version, config: { pid: identity.pid } }));
    });
    await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
    return server.address().port;
  }
  async function close() { if (server?.listening) await new Promise(resolve => server.close(resolve)); }
  const port = await listen();
  const runtime = { root, leaseRoot: join(root, "consumers"), inspect: async () => descriptor, environment: () => ({}),
    acquire: async resource => { state.installs++; return { descriptor, lease: await createConsumerLease(join(root, "consumers"), resource) }; } };
  let keeper = owned ? await createConsumerLease(runtime.leaseRoot, `proxy:${port}`) : null;
  const recordPath = join(root, "proxies", String(port), "owner.json");
  const record = { schema: 1, ...identity, port, nonce, serviceToken: randomUUID(), script: "/fixture/managed-proxy.py", descriptor };
  if (owned) await publishJson(root, recordPath, record);
  const managers = [];
  const make = () => {
    const manager = new ProxyManager({ port, runtime,
      ...(verifier ? { processMatches: async candidate => state.alive && candidate.pid === identity.pid && candidate.start === identity.start } : {}),
      terminate: async () => { state.killed++; state.alive = false; await close(); },
    }); managers.push(manager); return manager;
  };
  const releaseKeeper = async () => { await keeper?.release(); keeper = null; };
  try { await fn({ root, port, state, runtime, descriptor, record, recordPath, make, close, listen, releaseKeeper }); }
  finally {
    for (const manager of managers) await manager.stop();
    await releaseKeeper(); await close(); await rm(root, { recursive: true, force: true });
  }
}

test("proxy launch closes log handle when progress callback throws before spawn", async t => fixture(async fx => {
  const manager = fx.make(); manager.descriptor = fx.descriptor;
  const realOpen = fsp.open; let opened = 0, closed = 0;
  t.mock.method(fsp, "open", async (...args) => {
    const handle = await realOpen(...args);
    if (String(args[0]).endsWith("/proxy.log")) {
      opened++;
      return { fd: handle.fd, close: async () => { closed++; await handle.close(); } };
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(manager.launch(() => { throw new Error("fixture UI callback failed"); }), /fixture UI callback failed/);
    assert.equal(opened, 1, "must intercept actual opened launch log");
    assert.equal(closed, 1, "throwing callback must not leak opened file handle");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
}));

test("managed proxy pin equals exact extension SDK dependency", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(await getHeadroomAiVersion(), packageJson.dependencies["headroom-ai"]);
});
test("findPython detects supported system Python without package installation", async () => {
  assert.ok(["python3", "python"].includes(await findPython()));
});
test("startup lock waits for current owner before next ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "wb-proxy-lock-"));
  try {
    const first = await acquireStartupLock(join(root, "startup.lock"), () => {}, () => false);
    let acquired = false;
    const second = acquireStartupLock(join(root, "startup.lock"), () => {}, () => false).then(release => { acquired = true; return release; });
    await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(acquired, false);
    await first(); await (await second)();
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("managed proxy defaults to loopback 8787 and refuses non-loopback binding", () => {
  assert.equal(new ProxyManager().baseUrl, "http://127.0.0.1:8787");
  assert.throws(() => new ProxyManager({ host: "0.0.0.0" }), /only 127/);
});
test("exact-version unowned HTTP server is never adopted, probed or stopped", () => fixture(async fx => {
  const manager = fx.make(); const messages = [];
  assert.equal(await manager.ensureRunning(message => messages.push(message)), false);
  assert.equal(manager.isManaged, false); assert.equal(fx.state.installs, 0); assert.equal(fx.state.requests, 0);
  assert.match(messages.join("\n"), /unknown\/unowned/); await manager.stop(); assert.equal(fx.state.killed, 0);
}, { owned: false }));
test("managed peer requires nonce, version, runtime and PID attestation", () => fixture(async fx => {
  const manager = fx.make(); assert.equal(await manager.ensureRunning(() => {}), true); assert.equal(manager.isManaged, true);
  assert.equal(await manager.healthCheck(), true);
  fx.state.nonce = "b".repeat(64); assert.equal(await manager.healthCheck(), false);
  fx.state.nonce = fx.record.nonce; fx.state.version = "0.40.0"; assert.equal(await manager.healthCheck(), false);
  fx.state.version = "0.41.0";
  await publishJson(fx.root, fx.recordPath, { ...fx.record, start: "reused-pid" });
  assert.equal(await manager.healthCheck(), false);
}));
test("forged private record cannot claim an unrelated executable", () => fixture(async fx => {
  const manager = fx.make(); assert.equal(await manager.ensureRunning(() => {}), false);
  assert.equal(fx.state.installs, 0); assert.equal(fx.state.killed, 0); assert.equal(fx.state.requests, 0);
}, { verifier: false }));
test("creator exit preserves peers; only last consumer stops owned service", () => fixture(async fx => {
  const a = fx.make(), b = fx.make();
  assert.equal(await a.ensureRunning(() => {}), true); assert.equal(await b.ensureRunning(() => {}), true);
  await fx.releaseKeeper(); await a.stop();
  assert.equal(fx.state.killed, 0); assert.equal(await b.healthCheck(), true);
  await b.stop(); assert.equal(fx.state.killed, 1);
}));
test("healthy owned proxy does not restart after healthy request failure", () => fixture(async fx => {
  const manager = fx.make(); assert.equal(await manager.ensureRunning(() => {}), true); await fx.releaseKeeper();
  manager.launch = async () => { fx.state.starts++; return true; };
  assert.equal(await manager.tryRestart(() => {}), true);
  assert.equal(fx.state.starts, 0); assert.equal(fx.state.killed, 0);
}));
test("watchdog leader replaces unhealthy owned service with bounded owned restart", () => fixture(async fx => {
  const manager = fx.make(); assert.equal(await manager.ensureRunning(() => {}), true); await fx.releaseKeeper();
  fx.state.healthy = false;
  manager.launch = async () => { fx.state.starts++; fx.state.alive = true; fx.state.healthy = true; await fx.listen(fx.port); return waitHealth(manager); };
  assert.equal(await manager.tryRestart(() => {}), true);
  assert.equal(fx.state.killed, 1); assert.equal(fx.state.starts, 1);
}));
test("owned crash retains consumer restart eligibility without killing an external process", () => fixture(async fx => {
  const manager = fx.make(); assert.equal(await manager.ensureRunning(() => {}), true); await fx.releaseKeeper();
  fx.state.alive = false; await fx.close();
  manager.launch = async () => { fx.state.starts++; fx.state.alive = true; await fx.listen(fx.port); return waitHealth(manager); };
  assert.equal(await manager.tryRestart(() => {}), true);
  assert.equal(fx.state.killed, 0); assert.equal(fx.state.starts, 1);
}));
test("stopped instance cannot reactivate without explicit resume", () => fixture(async fx => {
  const manager = fx.make(); await manager.stop();
  assert.equal(await manager.ensureRunning(() => {}), false);
  manager.resume(); assert.equal(await manager.ensureRunning(() => {}), true);
}));


test("compression authenticates both directions; port replacement sees ciphertext only", () => fixture(async (fx) => {
  const { openOwnedJson, sealOwnedJson } = await jiti.import("../src/owned-transport.ts");
  const manager = fx.make(); assert.equal(await manager.ensureRunning(() => {}), true);
  let captured = "", forged = false;
  fx.state.onRequest = async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    captured = Buffer.concat(chunks).toString();
    const id = req.headers["x-pi-workbench-request"];
    const body = openOwnedJson(fx.record.nonce, `pi-workbench:headroom:v1:request:${id}:POST:/v1/compress`, captured);
    if (forged) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ messages: ["forged context"] })); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(sealOwnedJson(fx.record.nonce, `pi-workbench:headroom:v1:response:${id}:200`, { messages: body.messages, compressed: false }));
  };
  const messages = [{ role: "user", content: "private context sentinel 978163" }];
  assert.deepEqual((await manager.compressRaw({ messages })).messages, messages);
  assert.equal(captured.includes("private context sentinel"), false);
  assert.equal(captured.includes(fx.record.nonce), false);
  forged = true;
  await assert.rejects(manager.compressRaw({ messages }), /authentication failed/);
  assert.equal(captured.includes("private context sentinel"), false, "foreign HTTP occupant never gets plaintext");
}));

test("replayed health response cannot prove fresh process ownership", () => fixture(async (fx) => {
  const manager = fx.make(); assert.equal(await manager.ensureRunning(() => {}), true);
  const old = await fetch(manager.baseUrl + "/health", { headers: { "x-pi-workbench-challenge": "old-challenge" } });
  fx.state.replayedProof = old.headers.get("x-pi-workbench-owner"); await old.text();
  assert.equal(await manager.healthCheck(), false);
}));
