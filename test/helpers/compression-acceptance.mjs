import assert from "node:assert/strict";
import { compress } from "headroom-ai";
import { createJiti } from "jiti";
const { createOwnedHeadroomClient } = await createJiti(import.meta.url).import("../../src/headroom-client.ts");
/** Synthetic coding context through the exact SDK helper used by the extension. */
export async function verifyCompressionBridge(proxy) {
  const dump = Array.from({ length: 200 }, (_, i) => `function handler${i}(req, res) { return res.json({ ok: true, n: ${i} }); }`).join("\n");
  const messages = [
    { role: "user", content: "Inspect this synthetic repository." },
    { role: "assistant", content: "Reading fixture.", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"fixture.js"}' } }] },
    { role: "tool", tool_call_id: "c1", content: dump },
    { role: "assistant", content: "Fixture has handlers." },
    { role: "user", content: "Add a synthetic health endpoint." },
    { role: "assistant", content: "Editing fixture.", tool_calls: [{ id: "c2", type: "function", function: { name: "edit", arguments: '{"path":"fixture.js"}' } }] },
    { role: "tool", tool_call_id: "c2", content: "Synthetic edit applied." },
    { role: "assistant", content: "Synthetic endpoint is ready." },
  ];
  const client = createOwnedHeadroomClient(proxy);
  assert.equal((await client.health()).version, "0.41.0");
  const result = await compress(messages, { client, model: "Ornith-1.5-35B-A3B-q5-mtp0" });
  assert.ok(Array.isArray(result.messages) && result.messages.length > 0);
  assert.ok(result.messages.every(item => ["system", "user", "assistant", "tool"].includes(item.role)));
  const calls = result.messages.flatMap(item => item.tool_calls ?? []);
  assert.deepEqual(calls.map(item => item.id).sort(), ["c1", "c2"]);
  for (const call of calls) assert.doesNotThrow(() => JSON.parse(call.function.arguments));
  for (const tool of result.messages.filter(item => item.role === "tool")) assert.equal(typeof tool.tool_call_id, "string");
  assert.equal(result.messages.at(-1).content, "Synthetic endpoint is ready.");
  assert.ok(result.messages.some(item => item.role === "user" && item.content === "Add a synthetic health endpoint."));
  assert.equal(result.tokensSaved, result.tokensBefore - result.tokensAfter);
  assert.ok(result.tokensAfter <= result.tokensBefore);
  return { before: result.tokensBefore, after: result.tokensAfter, compressed: result.compressed };
}
