import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  ASSET_VERSION_TOKEN,
  CODE_GRAPH_ASSETS,
  CODE_GRAPH_BINARY_MEMBER,
  compareAssetVersions,
  getAsset,
  parseAssetVersion,
  resolveAssetUrl,
  validateAsset,
} = await jiti.import("../src/code-graph-assets.ts");

test("approved linux-arm64 asset is internally consistent", () => {
  const asset = CODE_GRAPH_ASSETS["linux-arm64"];
  assert.equal(asset.version, "v0.8.1");
  assert.equal(asset.sha256, "d2f842d1365da5c35d9c5796f57a821c9745267350994346735e1e6e04d46091");
  assert.deepEqual(validateAsset("linux-arm64", asset), []);
});

test("packaged asset size matches the spike-verified release archive", () => {
  // Verified against the v0.8.1 GitHub release during the compatibility
  // spike (36,458,830 bytes; SHA-256 d2f842d1...6091).
  assert.equal(CODE_GRAPH_ASSETS["linux-arm64"].sizeBytes, 36_458_830);
  const good = CODE_GRAPH_ASSETS["linux-arm64"];
  assert.deepEqual(
    validateAsset("linux-arm64", { ...good, sizeBytes: -5 }),
    ["Asset sizeBytes must be a positive integer: -5"],
  );
  assert.deepEqual(
    validateAsset("linux-arm64", { ...good, sizeBytes: 1.5 }),
    ["Asset sizeBytes must be a positive integer: 1.5"],
  );
});

test("parseAssetVersion accepts only vMAJOR.MINOR.PATCH", () => {
  assert.deepEqual(parseAssetVersion("v0.8.1"), { major: 0, minor: 8, patch: 1 });
  assert.deepEqual(parseAssetVersion("v10.20.30"), { major: 10, minor: 20, patch: 30 });
  assert.equal(parseAssetVersion("0.8.1"), null);
  assert.equal(parseAssetVersion("v0.8"), null);
  assert.equal(parseAssetVersion("v0.8.1.2"), null);
  assert.equal(parseAssetVersion("v0.8.1-beta"), null);
  assert.equal(parseAssetVersion("V0.8.1"), null);
  assert.equal(parseAssetVersion(""), null);
  assert.equal(parseAssetVersion(undefined), null);
});

test("compareAssetVersions compares numeric segments, not lexically", () => {
  assert.equal(compareAssetVersions("v0.8.1", "v0.8.1"), 0);
  assert.equal(compareAssetVersions("v0.8.1", "v0.8.2"), -1);
  assert.equal(compareAssetVersions("v0.8.2", "v0.8.1"), 1);
  assert.equal(compareAssetVersions("v0.8.9", "v0.8.10"), -1);
  assert.equal(compareAssetVersions("v0.9.0", "v0.8.10"), 1);
  assert.equal(compareAssetVersions("v1.0.0", "v0.99.99"), 1);
  assert.throws(() => compareAssetVersions("0.8.1", "v0.8.1"), /Unparseable asset version/);
});

test("validateAsset rejects malformed version, checksum, URL, and platform", () => {
  const good = CODE_GRAPH_ASSETS["linux-arm64"];

  assert.match(
    validateAsset("darwin-arm64", good).join(" "),
    /Unsupported code graph platform/,
  );

  const badVersion = { ...good, version: "0.8.1" };
  assert.match(validateAsset("linux-arm64", badVersion).join(" "), /vMAJOR.MINOR.PATCH/);

  const badHash = { ...good, sha256: "ABC".repeat(22) + "XYZ" };
  assert.match(validateAsset("linux-arm64", badHash).join(" "), /sha256 must be 64 lowercase hex/);

  const badProtocol = { ...good, url: good.url.replace("https://", "http://") };
  assert.match(validateAsset("linux-arm64", badProtocol).join(" "), /must use HTTPS/);

  const badHost = { ...good, url: good.url.replace("github.com", "example.com") };
  assert.match(validateAsset("linux-arm64", badHost).join(" "), /must point at github\.com/);

  const badRepo = { ...good, url: good.url.replace("DeusData/codebase-memory-mcp", "Other/repo") };
  assert.match(validateAsset("linux-arm64", badRepo).join(" "), /DeusData\/codebase-memory-mcp release/);

  const noToken = { ...good, url: good.url.replace(ASSET_VERSION_TOKEN, "v0.8.1") };
  assert.match(validateAsset("linux-arm64", noToken).join(" "), /literal v0\.x\.y token/);

  const notUrl = { ...good, url: "not a url" };
  assert.match(validateAsset("linux-arm64", notUrl).join(" "), /not a valid URL/);
});

test("resolveAssetUrl replaces every v0.x.y token and requires the token", () => {
  const asset = CODE_GRAPH_ASSETS["linux-arm64"];
  assert.equal(
    resolveAssetUrl(asset),
    "https://github.com/DeusData/codebase-memory-mcp/releases/download/v0.8.1/codebase-memory-mcp-linux-arm64.tar.gz",
  );

  const doubleToken = { ...asset, url: `https://github.com/DeusData/codebase-memory-mcp/releases/download/${ASSET_VERSION_TOKEN}/x-${ASSET_VERSION_TOKEN}.tar.gz` };
  assert.equal(
    resolveAssetUrl(doubleToken),
    "https://github.com/DeusData/codebase-memory-mcp/releases/download/v0.8.1/x-v0.8.1.tar.gz",
  );

  const noToken = { ...asset, url: asset.url.replace(ASSET_VERSION_TOKEN, "v0.8.1") };
  assert.throws(() => resolveAssetUrl(noToken), new RegExp(ASSET_VERSION_TOKEN));
});

test("getAsset returns the pinned entry and rejects unsupported platforms", () => {
  const { platform, asset } = getAsset("linux-arm64");
  assert.equal(platform, "linux-arm64");
  assert.equal(asset.version, "v0.8.1");
  assert.throws(() => getAsset("linux-x64"), /Unsupported code graph platform/);
});

test("asset selection is immune to legacy/user environment variables", () => {
  const saved = process.env;
  process.env = {
    ...saved,
    CBM_DOWNLOAD_URL: "https://evil.example/tampered.tar.gz",
    CODEBASE_MEMORY_MCP_URL: "https://evil.example/other.tar.gz",
    CBM_CACHE_DIR: "/tmp/elsewhere",
  };
  try {
    const { asset } = getAsset("linux-arm64");
    assert.equal(asset.url, CODE_GRAPH_ASSETS["linux-arm64"].url);
    assert.equal(
      resolveAssetUrl(asset),
      "https://github.com/DeusData/codebase-memory-mcp/releases/download/v0.8.1/codebase-memory-mcp-linux-arm64.tar.gz",
    );
    assert.equal(asset.sha256, "d2f842d1365da5c35d9c5796f57a821c9745267350994346735e1e6e04d46091");
    // The packaged manifest is the only accepted asset source: no asset API
    // reads environment overrides, and the installer exposes no env override.
  } finally {
    process.env = saved;
  }
});

test("binary member constant matches the only extractable archive member", () => {
  assert.equal(CODE_GRAPH_BINARY_MEMBER, "codebase-memory-mcp");
});
