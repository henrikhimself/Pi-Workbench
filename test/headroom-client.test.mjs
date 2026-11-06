import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { compress } from "headroom-ai";
const { createOwnedHeadroomClient } = await createJiti(import.meta.url).import("../src/headroom-client.ts");
test("actual SDK compress and raw calls use owned transport, never unsealed fetch", async () => {
  const original = globalThis.fetch; let unsealed = 0; const calls = [];
  globalThis.fetch = async () => { unsealed++; throw new Error("Unsealed fetch must not run"); };
  try {
    const client = createOwnedHeadroomClient({ baseUrl: "http://127.0.0.1:8787", requestOwned: async (path, body, method) => {
      calls.push({ path, body, method }); return { messages: body.messages, tokens_before: 10, tokens_after: 8, tokens_saved: 2, compression_ratio: 0.8, transforms_applied: [], ccr_hashes: [] };
    } });
    const messages = [{ role: "user", content: "sentinel" }];
    assert.equal((await compress(messages, { client, model: "fixture", config: { protectRecent: 8 } })).tokensSaved, 2);
    await client.compressRaw({ model: "fixture", messages });
    assert.equal(calls.length, 2); assert.equal(calls[0].body.config.protect_recent, 8);
    assert.equal(unsealed, 0);
    await assert.rejects(createOwnedHeadroomClient(null).compress(messages), /contract unavailable|Connection/);
    assert.equal(unsealed, 0);
  } finally { globalThis.fetch = original; }
});
