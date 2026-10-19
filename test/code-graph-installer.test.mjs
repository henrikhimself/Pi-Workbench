import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  CodeGraphInstaller,
  acquireInstallLock,
  decideBinaryAction,
  detectCodeGraphPlatform,
  discoverInstalled,
  findGnuTar,
  downloadArchive,
  extractCodeGraphArchive,
  installedBinaryPath,
  parseBinaryVersionOutput,
  readInstalledRecord,
  sha256OfFile,
  unsupportedPlatformMessage,
  verifyBinaryVersion,
} = await jiti.import("../src/code-graph-installer.ts");

// ─── Helpers ──────────────────────────────────────────────────────────

async function makeTempRoot() {
  const root = await mkdtemp(join(tmpdir(), "cg-installer-test-"));
  const paths = {
    codeGraphRoot: root,
    codeGraphBin: join(root, "bin"),
    codeGraphDownloads: join(root, "downloads"),
  };
  await mkdir(paths.codeGraphBin, { recursive: true });
  await mkdir(paths.codeGraphDownloads, { recursive: true });
  return { root, paths, cleanup: async () => rm(root, { recursive: true, force: true }) };
}

const LINUX_ARM64_URL =
  "https://github.com/DeusData/codebase-memory-mcp/releases/download/v0.x.y/codebase-memory-mcp-linux-arm64.tar.gz";

function makeTarHeader(name, size, typeflag = "0", mode = 0o755) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write(mode.toString(8).padStart(7, "0") + "\0", 100, 8, "ascii");
  h.write("0000000\0", 108, 8, "ascii");
  h.write("0000000\0", 116, 8, "ascii");
  h.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  h.write("00000000000\0", 136, 12, "ascii");
  h.fill(0x20, 148, 156);
  h.write(typeflag, 156, 1, "ascii");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, "0") + "\0\0", 148, 8, "ascii");
  return h;
}

function buildTar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? "");
    blocks.push(makeTarHeader(entry.name, data.length, entry.typeflag ?? "0", entry.mode ?? 0o755));
    blocks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function tarGzip(entries) {
  return gzipSync(buildTar(entries));
}

async function makeFixtureInstall(deps) {
  const { root, paths } = await makeTempRoot();
  const state = { archiveBytes: deps.archiveBytes, reportsVersion: deps.reportsVersion };
  const downloads = [];
  const installer = new CodeGraphInstaller({
    paths,
    platform: () => ({ os: "linux", arch: "arm64" }),
    sleep: async () => {},
    download: async (url, destination) => {
      downloads.push(url);
      await writeFile(destination, state.archiveBytes);
    },
    runProcess: async (command, args) => {
      if (args[0] === "--version" && command.endsWith("/tar")) {
        return { code: 0, stdout: "tar (GNU tar) 1.35\n", stderr: "" };
      }
      if (args[0] === "--version") {
        // Content-aware: a corrupted binary reports the wrong version.
        let contents = "";
        try {
          contents = await readFile(command, "utf8");
        } catch {
          contents = "";
        }
        const reported = contents.startsWith("ELF") ? state.reportsVersion : "0.0.0";
        return { code: 0, stdout: `codebase-memory-mcp ${reported}\n`, stderr: "" };
      }
      return { code: 127, stdout: "", stderr: "unexpected" };
    },
  });
  return { root, paths, installer, downloads, state, cleanup: async () => rm(root, { recursive: true, force: true }) };
}

function fixtureAsset(sha256, version = "v0.8.1") {
  return { version, url: LINUX_ARM64_URL, sha256 };
}

const sleep0 = async () => {};

// ─── Platform detection ───────────────────────────────────────────────

test("detects linux/arm64 as the only supported platform", () => {
  assert.equal(detectCodeGraphPlatform({ os: "linux", arch: "arm64" }), "linux-arm64");
  assert.equal(detectCodeGraphPlatform({ os: "linux", arch: "x64" }), null);
  assert.equal(detectCodeGraphPlatform({ os: "darwin", arch: "arm64" }), null);
  assert.equal(detectCodeGraphPlatform({ os: "darwin", arch: "x64" }), null);
  assert.equal(detectCodeGraphPlatform({ os: "win32", arch: "x64" }), null);
  assert.match(unsupportedPlatformMessage("linux", "x64"), /not supported on linux\/x64/);
  assert.match(unsupportedPlatformMessage("linux", "x64"), /linux\/arm64/);
});

// ─── Update decision ──────────────────────────────────────────────────

test("decideBinaryAction: missing install", () => {
  assert.deepEqual(decideBinaryAction(null, { version: "v0.8.1", resolvedUrl: "u", sha256: "s" }), {
    action: "install",
    reason: "missing",
  });
});

test("decideBinaryAction: same identity reuses", () => {
  const identity = { version: "v0.8.1", resolvedUrl: "u", sha256: "s" };
  assert.deepEqual(decideBinaryAction(identity, identity), { action: "reuse", reason: "verified" });
});

test("decideBinaryAction: same version with changed URL or SHA is an invalid manifest", () => {
  const base = { version: "v0.8.1", resolvedUrl: "u", sha256: "s" };
  const urlChanged = decideBinaryAction(base, { ...base, resolvedUrl: "u2" });
  assert.equal(urlChanged.action, "invalid_manifest");
  assert.match(urlChanged.detail, /manifest is invalid/i);
  const shaChanged = decideBinaryAction(base, { ...base, sha256: "s2" });
  assert.equal(shaChanged.action, "invalid_manifest");
});

test("decideBinaryAction: newer packaged version installs an update", () => {
  const action = decideBinaryAction(
    { version: "v0.8.0", resolvedUrl: "u", sha256: "s" },
    { version: "v0.8.1", resolvedUrl: "u", sha256: "s" },
  );
  assert.deepEqual(action, { action: "install", reason: "update" });
});

test("decideBinaryAction: older packaged version never downgrades", () => {
  const action = decideBinaryAction(
    { version: "v0.8.2", resolvedUrl: "u2", sha256: "s2" },
    { version: "v0.8.1", resolvedUrl: "u", sha256: "s" },
  );
  assert.deepEqual(action, { action: "reuse", reason: "downgrade_refused" });
});

// ─── SHA-256 ──────────────────────────────────────────────────────────

test("sha256OfFile hashes file contents", async () => {
  const { root, cleanup } = await makeTempRoot();
  const file = join(root, "data.bin");
  await writeFile(file, "hello workbench");
  assert.equal(await sha256OfFile(file), (await import("node:crypto")).createHash("sha256").update("hello workbench").digest("hex"));
  await cleanup();
});

// ─── Version output parsing ───────────────────────────────────────────

test("parseBinaryVersionOutput normalizes the CBM --version line", () => {
  assert.equal(parseBinaryVersionOutput("codebase-memory-mcp 0.8.1\n"), "v0.8.1");
  assert.equal(parseBinaryVersionOutput("noise before\ncodebase-memory-mcp v0.8.1\nnoise after"), "v0.8.1");
  assert.equal(parseBinaryVersionOutput("codebase-memory-mcp 0.8.1 extra"), null);
  assert.equal(parseBinaryVersionOutput("codebase-memory-mcp 0.8"), null);
  assert.equal(parseBinaryVersionOutput("other tool 0.8.1"), null);
  assert.equal(parseBinaryVersionOutput(""), null);
});

test("verifyBinaryVersion accepts exact match and rejects deviations", async () => {
  const cwd = "/tmp";
  const ok = await verifyBinaryVersion("/b", "v0.8.1", async () => ({ code: 0, stdout: "codebase-memory-mcp 0.8.1\n", stderr: "" }), { cwd });
  assert.deepEqual(ok, { ok: true, version: "v0.8.1" });

  const wrong = await verifyBinaryVersion("/b", "v0.8.1", async () => ({ code: 0, stdout: "codebase-memory-mcp 0.9.0\n", stderr: "" }), { cwd });
  assert.equal(wrong.ok, false);
  assert.match(wrong.detail, /reports v0\.9\.0, expected v0\.8\.1/);

  const failing = await verifyBinaryVersion("/b", "v0.8.1", async () => ({ code: 127, stdout: "", stderr: "exec format error" }), { cwd });
  assert.equal(failing.ok, false);
  assert.match(failing.detail, /exec format error/);

  const garbage = await verifyBinaryVersion("/b", "v0.8.1", async () => ({ code: 0, stdout: "totally different\n", stderr: "" }), { cwd });
  assert.equal(garbage.ok, false);
  assert.match(garbage.detail, /Unrecognized --version output/);

  const badExpected = await verifyBinaryVersion("/b", "garbage", async () => ({ code: 0, stdout: "codebase-memory-mcp 0.8.1\n", stderr: "" }), { cwd });
  assert.equal(badExpected.ok, false);
});

// ─── GNU tar extraction ───────────────────────────────────────────────

const GNU_TAR = await findGnuTar();

test("extracts only the binary member from a valid tar.gz", async () => {
  const { root, cleanup } = await makeTempRoot();
  const archive = join(root, "fixture.tar.gz");
  await writeFile(archive, tarGzip([
    { name: "LICENSE", data: "license text" },
    { name: "codebase-memory-mcp", data: "ELFBINARY" },
    { name: "install.sh", data: "#!/bin/sh\necho install\n" },
  ]));
  const staging = join(root, "staging");
  const { binaryPath } = await extractCodeGraphArchive(archive, staging, GNU_TAR);
  assert.equal(binaryPath, join(staging, "codebase-memory-mcp"));
  assert.equal(await readFile(binaryPath, "utf8"), "ELFBINARY");
  assert.equal((await stat(binaryPath)).mode & 0o777, 0o755);
  assert.deepEqual(await readdir(staging), ["codebase-memory-mcp"]);
  await cleanup();
});

test("rejects corrupt, truncated, and member-missing archives", async () => {
  const { root, cleanup } = await makeTempRoot();
  const corrupt = buildTar([{ name: "codebase-memory-mcp", data: "ELFBINARY" }]);
  corrupt.write("000001\0\0", 148, 8, "ascii");
  const corruptArchive = join(root, "corrupt.tar.gz");
  await writeFile(corruptArchive, gzipSync(corrupt));
  await assert.rejects(() => extractCodeGraphArchive(corruptArchive, join(root, "corrupt"), GNU_TAR), /GNU tar extraction failed/);

  const missingArchive = join(root, "missing.tar.gz");
  await writeFile(missingArchive, tarGzip([{ name: "LICENSE", data: "x" }]));
  await assert.rejects(() => extractCodeGraphArchive(missingArchive, join(root, "missing"), GNU_TAR), /GNU tar extraction failed/);

  const truncatedArchive = join(root, "truncated.tar.gz");
  const full = tarGzip([{ name: "codebase-memory-mcp", data: "ELFBINARY" }]);
  await writeFile(truncatedArchive, full.subarray(0, Math.floor(full.length / 2)));
  await assert.rejects(() => extractCodeGraphArchive(truncatedArchive, join(root, "truncated"), GNU_TAR));
  await cleanup();
});

// ─── Download ─────────────────────────────────────────────────────────

function fakeBody(bytes) {
  return Readable.from([Buffer.from(bytes)]);
}

async function downloadWithFakeFetch(destination, fetchResponse, options = {}) {
  const status = [];
  await downloadArchive(
    "https://github.example/download.tar.gz",
    destination,
    (message) => status.push(message),
    { fetchResponse, ...options },
  );
  return { status };
}

test("download writes a 200 body and commits via rename", async () => {
  const { root, cleanup } = await makeTempRoot();
  const destination = join(root, "out.tar.gz");
  const calls = [];
  const { status } = await downloadWithFakeFetch(destination, async (url) => {
    calls.push(url);
    return { statusCode: 200, headers: { "content-length": "5" }, body: fakeBody("hello") };
  });
  assert.equal(calls.length, 1);
  assert.equal(await readFile(destination, "utf8"), "hello");
  assert.match(status.at(-1), /Downloaded .* MB/);
  const leftovers = (await readdir(root)).filter((name) => name.includes(".part"));
  assert.deepEqual(leftovers, []);
  await cleanup();
});

test("download follows at most maxRedirects redirects", async () => {
  const { root, cleanup } = await makeTempRoot();
  const destination = join(root, "out.tar.gz");
  const urls = [
    "https://a.example/1",
    "https://b.example/2",
    "https://c.example/3",
  ];
  const fetchResponse = async (url) => {
    const index = urls.indexOf(url);
    if (index < urls.length - 1) {
      return { statusCode: 302, headers: {}, body: fakeBody(""), location: urls[index + 1] };
    }
    return { statusCode: 200, headers: {}, body: fakeBody("done") };
  };
  await downloadWithFakeFetch(destination, fetchResponse);
  assert.equal(await readFile(destination, "utf8"), "done");

  const deep = [
    "https://a.example/1",
    "https://b.example/2",
    "https://c.example/3",
    "https://d.example/4",
  ];
  const deepFetch = async (url) => {
    const index = deep.indexOf(url);
    if (index < deep.length - 1) {
      return { statusCode: 302, headers: {}, body: fakeBody(""), location: deep[index + 1] };
    }
    return { statusCode: 200, headers: {}, body: fakeBody("never") };
  };
  await assert.rejects(
    () => downloadWithFakeFetch(join(root, "deep.tar.gz"), deepFetch),
    /Too many redirects/,
  );
  await cleanup();
});

test("download rejects non-200, non-redirect responses", async () => {
  const { root, cleanup } = await makeTempRoot();
  const destination = join(root, "out.tar.gz");
  await assert.rejects(
    () => downloadWithFakeFetch(destination, async () => ({ statusCode: 500, headers: {}, body: fakeBody("") })),
    /HTTP 500/,
  );
  const leftovers = (await readdir(root)).filter((name) => name.includes(".part"));
  assert.deepEqual(leftovers, []);
  await cleanup();
});

test("download rejects oversized declared content-length", async () => {
  const { root, cleanup } = await makeTempRoot();
  const destination = join(root, "out.tar.gz");
  await assert.rejects(
    () =>
      downloadWithFakeFetch(
        destination,
        async () => ({ statusCode: 200, headers: { "content-length": "999999999" }, body: fakeBody("") }),
        { maxBytes: 1000 },
      ),
    /exceeds the .* byte limit/,
  );
  await cleanup();
});

test("download aborts when streamed body exceeds the limit", async () => {
  const { root, cleanup } = await makeTempRoot();
  const destination = join(root, "out.tar.gz");
  const big = Buffer.alloc(2048);
  await assert.rejects(
    () => downloadWithFakeFetch(destination, async () => ({ statusCode: 200, headers: {}, body: fakeBody(big) }), { maxBytes: 1000 }),
    /exceeded the .* byte limit/,
  );
  const leftovers = (await readdir(root)).filter((name) => name.includes(".part"));
  assert.deepEqual(leftovers, []);
  await cleanup();
});

test("download rejects redirect responses without Location", async () => {
  const { root, cleanup } = await makeTempRoot();
  const destination = join(root, "out.tar.gz");
  await assert.rejects(
    () => downloadWithFakeFetch(destination, async () => ({ statusCode: 302, headers: {}, body: fakeBody("") })),
    /without Location/,
  );
  await cleanup();
});

// ─── Install lock ─────────────────────────────────────────────────────

test("install lock: second waiter succeeds after release", async () => {
  const { root, cleanup } = await makeTempRoot();
  const lockDir = join(root, "install.lock");
  const release1 = await acquireInstallLock(lockDir, () => {}, sleep0);
  assert.ok(release1);
  let release2 = null;
  const waiter = acquireInstallLock(lockDir, () => {}, sleep0).then((value) => {
    release2 = value;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(release2, null, "waiter must not acquire while held");
  await release1();
  await waiter;
  assert.ok(release2);
  await release2();
  await cleanup();
});

test("install lock: abandons locks owned by dead processes", async () => {
  const { root, cleanup } = await makeTempRoot();
  const lockDir = join(root, "install.lock");
  await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, "owner.json"), JSON.stringify({ pid: 4194303, host: "dead" }));
  const release = await acquireInstallLock(lockDir, () => {}, sleep0);
  assert.ok(release, "abandoned lock must be removed and re-acquired");
  await release();
  await cleanup();
});

test("install lock: times out while a live process holds it", async () => {
  const { root, cleanup } = await makeTempRoot();
  const lockDir = join(root, "install.lock");
  const release1 = await acquireInstallLock(lockDir, () => {}, sleep0);
  assert.ok(release1);
  const messages = [];
  const release2 = await acquireInstallLock(lockDir, (message) => messages.push(message), sleep0, 300);
  assert.equal(release2, null);
  assert.match(messages.join(" | "), /Timed out waiting/);
  await release1();
  await cleanup();
});

// ─── Installed records ────────────────────────────────────────────────

test("readInstalledRecord validates shape and version match", async () => {
  const { root, paths, cleanup } = await makeTempRoot();
  const recordPath = join(paths.codeGraphBin, "v0.8.1", "linux-arm64", "asset.json");
  await mkdir(join(paths.codeGraphBin, "v0.8.1", "linux-arm64"), { recursive: true });
  await writeFile(recordPath, JSON.stringify({ version: "v0.8.1", resolvedUrl: "u", sha256: "s" }));
  assert.deepEqual(await readInstalledRecord(paths.codeGraphBin, "v0.8.1", "linux-arm64"), {
    version: "v0.8.1",
    resolvedUrl: "u",
    sha256: "s",
  });
  // Version mismatch between record and directory is rejected.
  await writeFile(recordPath, JSON.stringify({ version: "v0.9.9", resolvedUrl: "u", sha256: "s" }));
  assert.equal(await readInstalledRecord(paths.codeGraphBin, "v0.8.1", "linux-arm64"), null);
  // Malformed record is rejected.
  await writeFile(recordPath, JSON.stringify({ version: "v0.8.1" }));
  assert.equal(await readInstalledRecord(paths.codeGraphBin, "v0.8.1", "linux-arm64"), null);
  // Missing record.
  assert.equal(await readInstalledRecord(paths.codeGraphBin, "v9.9.9", "linux-arm64"), null);
  await cleanup();
});

test("discoverInstalled returns the newest valid record", async () => {
  const { root, paths, cleanup } = await makeTempRoot();
  for (const [version, payload] of [
    ["v0.8.0", { version: "v0.8.0", resolvedUrl: "u0", sha256: "s0" }],
    ["v0.8.2", { version: "v0.8.2", resolvedUrl: "u2", sha256: "s2" }],
  ]) {
    const dir = join(paths.codeGraphBin, version, "linux-arm64");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "asset.json"), JSON.stringify(payload));
  }
  // A directory with a broken record must be skipped.
  await mkdir(join(paths.codeGraphBin, "v0.8.1", "linux-arm64"), { recursive: true });
  await writeFile(join(paths.codeGraphBin, "v0.8.1", "linux-arm64", "asset.json"), "not json");
  const discovered = await discoverInstalled(paths.codeGraphBin, "linux-arm64");
  assert.deepEqual(discovered, { version: "v0.8.2", resolvedUrl: "u2", sha256: "s2" });
  await cleanup();
});

// ─── ensureInstalled end-to-end (fakes) ───────────────────────────────

test("ensureInstalled installs a fresh, verified binary and cleans staging", async () => {
  const archiveBytes = tarGzip([{ name: "codebase-memory-mcp", data: "ELF-A" }]);
  const sha = (await import("node:crypto")).createHash("sha256").update(archiveBytes).digest("hex");
  const fixture = await makeFixtureInstall({ archiveBytes, reportsVersion: "0.8.1" });
  const status = [];
  const result = await fixture.installer.ensureInstalled((message) => status.push(message), { asset: fixtureAsset(sha) });
  assert.equal(result.reused, false);
  assert.equal(result.version, "v0.8.1");
  assert.equal(result.path, installedBinaryPath(fixture.paths.codeGraphBin, "v0.8.1", "linux-arm64"));
  assert.equal(await readFile(result.path, "utf8"), "ELF-A");
  const record = JSON.parse(await readFile(join(fixture.paths.codeGraphBin, "v0.8.1", "linux-arm64", "asset.json"), "utf8"));
  assert.equal(record.version, "v0.8.1");
  assert.equal(record.sha256, sha);
  assert.equal(record.resolvedUrl, LINUX_ARM64_URL.replace("v0.x.y", "v0.8.1"));
  // Staging and archives are cleaned.
  const downloads = await readdir(fixture.paths.codeGraphDownloads);
  assert.deepEqual(downloads, []);
  assert.match(status.join(" | "), /Downloading codebase-memory-mcp v0\.8\.1/);
  assert.match(status.join(" | "), /Verifying SHA-256/);
  assert.match(status.join(" | "), /Installed codebase-memory-mcp v0\.8\.1/);
  assert.equal(fixture.downloads.length, 1);
  await fixture.cleanup();
});

test("ensureInstalled reuses a verified install without downloading", async () => {
  const archiveBytes = tarGzip([{ name: "codebase-memory-mcp", data: "ELF-A" }]);
  const sha = (await import("node:crypto")).createHash("sha256").update(archiveBytes).digest("hex");
  const fixture = await makeFixtureInstall({ archiveBytes, reportsVersion: "0.8.1" });
  await fixture.installer.ensureInstalled(() => {}, { asset: fixtureAsset(sha) });
  const result = await fixture.installer.ensureInstalled(() => {}, { asset: fixtureAsset(sha) });
  assert.equal(result.reused, true);
  assert.equal(fixture.downloads.length, 1, "second run must not download");
  await fixture.cleanup();
});

test("ensureInstalled refuses same-version manifest changes and keeps the binary", async () => {
  const archiveA = tarGzip([{ name: "codebase-memory-mcp", data: "ELF-A" }]);
  const archiveB = tarGzip([{ name: "codebase-memory-mcp", data: "ELF-B" }]);
  const shaA = (await import("node:crypto")).createHash("sha256").update(archiveA).digest("hex");
  const shaB = (await import("node:crypto")).createHash("sha256").update(archiveB).digest("hex");
  const fixture = await makeFixtureInstall({ archiveBytes: archiveA, reportsVersion: "0.8.1" });
  await fixture.installer.ensureInstalled(() => {}, { asset: fixtureAsset(shaA) });
  fixture.state.archiveBytes = archiveB;
  await assert.rejects(
    () => fixture.installer.ensureInstalled(() => {}, { asset: fixtureAsset(shaB) }),
    /manifest is invalid/i,
  );
  const binaryPath = installedBinaryPath(fixture.paths.codeGraphBin, "v0.8.1", "linux-arm64");
  assert.equal(await readFile(binaryPath, "utf8"), "ELF-A");
  assert.equal(fixture.downloads.length, 1, "no download for an invalid manifest");
  await fixture.cleanup();
});

test("ensureInstalled installs a newer packaged version and keeps the older one", async () => {
  const archiveV1 = tarGzip([{ name: "codebase-memory-mcp", data: "ELF-1" }]);
  const archiveV2 = tarGzip([{ name: "codebase-memory-mcp", data: "ELF-2" }]);
  const shaV1 = (await import("node:crypto")).createHash("sha256").update(archiveV1).digest("hex");
  const shaV2 = (await import("node:crypto")).createHash("sha256").update(archiveV2).digest("hex");
  const fixture = await makeFixtureInstall({ archiveBytes: archiveV1, reportsVersion: "0.8.1" });
  await fixture.installer.ensureInstalled(() => {}, { asset: fixtureAsset(shaV1) });
  fixture.state.archiveBytes = archiveV2;
  fixture.state.reportsVersion = "0.8.2";
  const updated = await fixture.installer.ensureInstalled(() => {}, { asset: fixtureAsset(shaV2, "v0.8.2") });
  assert.equal(updated.reused, false);
  assert.equal(updated.version, "v0.8.2");
  assert.equal(await readFile(updated.path, "utf8"), "ELF-2");
  // Older version retained for fallback.
  assert.equal(await readFile(installedBinaryPath(fixture.paths.codeGraphBin, "v0.8.1", "linux-arm64"), "utf8"), "ELF-1");
  await fixture.cleanup();
});

test("ensureInstalled refuses to auto-downgrade", async () => {
  const archiveV2 = tarGzip([{ name: "codebase-memory-mcp", data: "ELF-2" }]);
  const shaV2 = (await import("node:crypto")).createHash("sha256").update(archiveV2).digest("hex");
  const archiveV1 = tarGzip([{ name: "codebase-memory-mcp", data: "ELF-1" }]);
  const shaV1 = (await import("node:crypto")).createHash("sha256").update(archiveV1).digest("hex");
  const fixture = await makeFixtureInstall({ archiveBytes: archiveV2, reportsVersion: "0.8.2" });
  await fixture.installer.ensureInstalled(() => {}, { asset: fixtureAsset(shaV2, "v0.8.2") });
  fixture.state.archiveBytes = archiveV1;
  const result = await fixture.installer.ensureInstalled(() => {}, { asset: fixtureAsset(shaV1, "v0.8.1") });
  assert.equal(result.reused, true);
  assert.equal(result.version, "v0.8.2", "keeps the newer installed binary");
  assert.equal(await readFile(result.path, "utf8"), "ELF-2");
  assert.equal(fixture.downloads.length, 1);
  await fixture.cleanup();
});

test("ensureInstalled reinstalls when the installed binary fails verification", async () => {
  const archiveBytes = tarGzip([{ name: "codebase-memory-mcp", data: "ELF-A" }]);
  const sha = (await import("node:crypto")).createHash("sha256").update(archiveBytes).digest("hex");
  const fixture = await makeFixtureInstall({ archiveBytes, reportsVersion: "0.8.1" });
  await fixture.installer.ensureInstalled(() => {}, { asset: fixtureAsset(sha) });
  // Corrupt the installed binary; the content-aware runner then reports a
  // mismatching version and the installer must reinstall.
  await writeFile(installedBinaryPath(fixture.paths.codeGraphBin, "v0.8.1", "linux-arm64"), "corrupted");
  const result = await fixture.installer.ensureInstalled(() => {}, { asset: fixtureAsset(sha) });
  assert.equal(result.reused, false);
  assert.equal(await readFile(result.path, "utf8"), "ELF-A");
  assert.equal(fixture.downloads.length, 2);
  await fixture.cleanup();
});

test("ensureInstalled quarantines a broken same-version directory before installing", async () => {
  const archiveBytes = tarGzip([{ name: "codebase-memory-mcp", data: "ELF-A" }]);
  const sha = (await import("node:crypto")).createHash("sha256").update(archiveBytes).digest("hex");
  const fixture = await makeFixtureInstall({ archiveBytes, reportsVersion: "0.8.1" });
  const finalDir = join(fixture.paths.codeGraphBin, "v0.8.1", "linux-arm64");
  await mkdir(finalDir, { recursive: true });
  await writeFile(join(finalDir, "codebase-memory-mcp"), "garbage without record");
  await fixture.installer.ensureInstalled(() => {}, { asset: fixtureAsset(sha) });
  assert.equal(await readFile(join(finalDir, "codebase-memory-mcp"), "utf8"), "ELF-A");
  // The quarantine copy sits beside the platform directory inside v0.8.1/.
  const versionSiblings = await readdir(join(fixture.paths.codeGraphBin, "v0.8.1"));
  const quarantined = versionSiblings.filter((name) => name.startsWith("linux-arm64") && name.includes(".quarantine-"));
  assert.equal(quarantined.length, 1);
  assert.equal(
    await readFile(join(fixture.paths.codeGraphBin, "v0.8.1", quarantined[0], "codebase-memory-mcp"), "utf8"),
    "garbage without record",
  );
  await fixture.cleanup();
});

test("ensureInstalled aborts without touching a good install when SHA mismatches", async () => {
  const archiveV1 = tarGzip([{ name: "codebase-memory-mcp", data: "ELF-1" }]);
  const shaV1 = (await import("node:crypto")).createHash("sha256").update(archiveV1).digest("hex");
  const fixture = await makeFixtureInstall({ archiveBytes: archiveV1, reportsVersion: "0.8.1" });
  await fixture.installer.ensureInstalled(() => {}, { asset: fixtureAsset(shaV1) });
  // A newer manifest whose download serves wrong bytes.
  fixture.state.archiveBytes = Buffer.from("tampered archive bytes");
  await assert.rejects(
    () =>
      fixture.installer.ensureInstalled(
        () => {},
        { asset: { version: "v0.8.2", url: LINUX_ARM64_URL, sha256: "0".repeat(64) } },
      ),
    /SHA-256 mismatch/,
  );
  assert.equal(await readFile(installedBinaryPath(fixture.paths.codeGraphBin, "v0.8.1", "linux-arm64"), "utf8"), "ELF-1");
  const v2Dir = join(fixture.paths.codeGraphBin, "v0.8.2");
  const leftovers = await readdir(fixture.paths.codeGraphBin).catch(() => []);
  assert.ok(!leftovers.includes("v0.8.2"), "no partial v0.8.2 directory");
  void v2Dir;
  const downloads = await readdir(fixture.paths.codeGraphDownloads);
  assert.deepEqual(downloads, [], "staging cleaned after failure");
  await fixture.cleanup();
});

test("ensureInstalled rejects unsupported platforms before any I/O", async () => {
  const { root, paths, cleanup } = await makeTempRoot();
  const installer = new CodeGraphInstaller({
    paths,
    platform: () => ({ os: "linux", arch: "x64" }),
    sleep: sleep0,
  });
  await assert.rejects(() => installer.ensureInstalled(() => {}), /not supported on linux\/x64/);
  const downloads = await readdir(paths.codeGraphDownloads);
  assert.deepEqual(downloads, []);
  await cleanup();
});

test("ensureInstalled rejects a broken packaged manifest before any I/O", async () => {
  const { root, paths, cleanup } = await makeTempRoot();
  const installer = new CodeGraphInstaller({
    paths,
    platform: () => ({ os: "linux", arch: "arm64" }),
    sleep: sleep0,
  });
  await assert.rejects(
    () =>
      installer.ensureInstalled(() => {}, {
        asset: { version: "v0.8.1", url: LINUX_ARM64_URL, sha256: "not-a-sha" },
      }),
    /sha256 must be 64/i,
  );
  await cleanup();
});
