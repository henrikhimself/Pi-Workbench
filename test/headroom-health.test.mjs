import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  checkHeadroomVersion,
  describeHeadroomVersionCheck,
  getHeadroomHealth,
} = await jiti.import("../src/headroom-health.ts");

async function startHealthServer(respond) {
  const server = http.createServer((req, res) => {
    if (req.url !== "/health") return res.end();
    respond(res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function withHealthServer(respond, action) {
  const { server, baseUrl } = await startHealthServer(respond);
  try {
    await action(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("Headroom health: accepts matching JSON version", async () => {
  await withHealthServer((res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "healthy", version: "0.41.0" }));
  }, async (baseUrl) => {
    assert.deepEqual(await getHeadroomHealth(baseUrl, 1_000), { ok: true, version: "0.41.0" });
    assert.deepEqual(await checkHeadroomVersion(baseUrl, "0.41.0", 1_000), {
      ok: true,
      expectedVersion: "0.41.0",
      reportedVersion: "0.41.0",
    });
  });
});

test("Headroom health: rejects version mismatch and unavailable expected version", async () => {
  await withHealthServer((res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ version: "0.40.0" }));
  }, async (baseUrl) => {
    const mismatch = await checkHeadroomVersion(baseUrl, "0.41.0", 1_000);
    assert.deepEqual(mismatch, {
      ok: false,
      expectedVersion: "0.41.0",
      reportedVersion: "0.40.0",
      reason: "version_mismatch",
    });
    assert.match(describeHeadroomVersionCheck(mismatch), /expected 0\.41\.0, received 0\.40\.0/);
    assert.deepEqual(await checkHeadroomVersion(baseUrl, null, 1_000), {
      ok: false,
      expectedVersion: null,
      reportedVersion: null,
      reason: "expected_version_unavailable",
    });
  });
});

test("Headroom health: rejects malformed, missing-version, and failed responses", async () => {
  await withHealthServer((res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("not JSON");
  }, async (baseUrl) => {
    assert.deepEqual(await getHeadroomHealth(baseUrl, 1_000), { ok: false, reason: "invalid_json" });
  });

  await withHealthServer((res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ version: 41 }));
  }, async (baseUrl) => {
    assert.deepEqual(await getHeadroomHealth(baseUrl, 1_000), { ok: false, reason: "missing_version" });
  });

  await withHealthServer((res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ version: "0.41.0" }));
  }, async (baseUrl) => {
    assert.deepEqual(await getHeadroomHealth(baseUrl, 1_000), { ok: false, reason: "http_error" });
  });

  assert.deepEqual(await getHeadroomHealth("http://127.0.0.1:1", 1_000), { ok: false, reason: "unreachable" });
});
