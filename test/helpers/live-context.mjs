/** Explicit synthetic historical tool-output fixture, not model-generated evidence. */
export function compressionHistory(model) {
  const assistant = (text, call) => ({ role: "assistant", content: [{ type: "text", text }, ...(call ? [call] : [])],
    api: model.api, provider: model.provider, model: model.id, stopReason: call ? "toolUse" : "stop", timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const tool = (id, name, text) => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: 1 });
  const dump = Array.from({ length: 200 }, (_, i) => `function handler${i}(req, res) { return res.json({ ok: true, n: ${i} }); }`).join("\n");
  return [
    { role: "user", content: "Inspect this synthetic repository.", timestamp: 1 },
    assistant("Reading synthetic fixture.", { type: "toolCall", id: "live-fixture-c1", name: "read", arguments: { path: "fixture.js" } }),
    tool("live-fixture-c1", "read", dump), assistant("Fixture has handlers."),
    { role: "user", content: "Add a synthetic health endpoint.", timestamp: 1 },
    assistant("Editing synthetic fixture.", { type: "toolCall", id: "live-fixture-c2", name: "edit", arguments: { path: "fixture.js" } }),
    tool("live-fixture-c2", "edit", "Synthetic edit applied."), assistant("Synthetic endpoint is ready."),
  ];
}
