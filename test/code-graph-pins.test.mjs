import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { CODE_GRAPH_ASSETS, getAsset, resolveAssetUrl, validateAsset } = await jiti.import("../src/code-graph-assets.ts");
const { MAX_DOWNLOAD_BYTES, MAX_MEMBER_BYTES } = await jiti.import("../src/code-graph-installer.ts");
test("both reviewed portable assets and bounded extraction limits have exact identities", () => {
  assert.deepEqual(Object.keys(CODE_GRAPH_ASSETS).sort(), ["linux-amd64", "linux-arm64"]);
  assert.equal(MAX_DOWNLOAD_BYTES, 64_000_000);
  assert.equal(MAX_MEMBER_BYTES, 400_000_000);
  const expected = {
    "linux-arm64": [48_466_763, "ed0f1f548cd79b121c401c2e9f7841c189a001af26d3768368088c24f6a53533"],
    "linux-amd64": [48_920_994, "8c3d0341064301e78ecc84cf7348d4e2c6562a0f57448243ea560aaa34de36c1"],
  };
  for (const [platform, [bytes, hash]] of Object.entries(expected)) {
    const asset = getAsset(platform).asset;
    assert.equal(asset.version, "v0.12.1");
    assert.equal(asset.sizeBytes, bytes);
    assert.equal(asset.sha256, hash);
    assert.ok(resolveAssetUrl(asset).endsWith("codebase-memory-mcp-" + platform + "-portable.tar.gz"));
    assert.deepEqual(validateAsset(platform, asset), []);
  }
});
