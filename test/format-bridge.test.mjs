/**
 * Unit tests for src/format-bridge.ts — Pi-AI ↔ OpenAI message conversion.
 *
 * Run: node --test test/
 * Loads TS source via jiti (same loader Pi uses for extensions).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { piToOpenAI, openAIToPi, openAIToPiWithOutcome } = await jiti.import("../src/format-bridge.ts");

// ─── Fixtures ─────────────────────────────────────────────────────────

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

const userString = { role: "user", content: "plain text", timestamp: 111 };
const userArray = {
  role: "user",
  content: [
    { type: "text", text: "part one" },
    { type: "text", text: "part two" },
  ],
  timestamp: 222,
};
const userImage = {
  role: "user",
  content: [
    { type: "text", text: "see image" },
    { type: "image", data: "QUJD", mimeType: "image/png" },
  ],
  timestamp: 333,
};
const assistantMixed = {
  role: "assistant",
  content: [
    { type: "text", text: "ok" },
    { type: "thinking", thinking: "opaque chain of thought" },
    { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls -la" } },
  ],
  api: "openai-completions",
  provider: "openai",
  model: "gpt-4o",
  usage: zeroUsage(),
  stopReason: "stop",
  timestamp: 444,
};
const assistantTextOnly = {
  role: "assistant",
  content: [{ type: "text", text: "just text" }],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  usage: zeroUsage(),
  stopReason: "end_turn",
  timestamp: 555,
};
const toolResult = {
  role: "toolResult",
  toolCallId: "call_1",
  toolName: "bash",
  content: [
    { type: "text", text: "file1" },
    { type: "text", text: "file2" },
  ],
  isError: false,
  timestamp: 666,
};
const toolResultImage = {
  role: "toolResult",
  toolCallId: "call_image",
  toolName: "screenshot",
  content: [
    { type: "text", text: "captured screen" },
    { type: "image", data: "REVG", mimeType: "image/jpeg" },
  ],
  isError: false,
  timestamp: 777,
};

// ─── piToOpenAI ───────────────────────────────────────────────────────

test("piToOpenAI: string user message stays string", () => {
  const [m] = piToOpenAI([userString]);
  assert.deepEqual(m, { role: "user", content: "plain text" });
});

test("piToOpenAI: array user message joins text parts with newline", () => {
  const [m] = piToOpenAI([userArray]);
  assert.deepEqual(m, { role: "user", content: "part one\npart two" });
});

test("piToOpenAI: user message with image → content parts with data URL", () => {
  const [m] = piToOpenAI([userImage]);
  assert.equal(m.role, "user");
  assert.ok(Array.isArray(m.content));
  assert.deepEqual(m.content[0], { type: "text", text: "see image" });
  assert.deepEqual(m.content[1], {
    type: "image_url",
    image_url: { url: "data:image/png;base64,QUJD" },
  });
});

test("piToOpenAI: assistant text + toolCall → tool_calls with JSON arguments", () => {
  const [m] = piToOpenAI([assistantMixed]);
  assert.equal(m.role, "assistant");
  assert.equal(m.content, "ok");
  assert.equal(m.tool_calls.length, 1);
  assert.deepEqual(m.tool_calls[0], {
    id: "call_1",
    type: "function",
    function: { name: "bash", arguments: JSON.stringify({ command: "ls -la" }) },
  });
});

test("piToOpenAI: thinking content stripped from assistant", () => {
  const [m] = piToOpenAI([assistantMixed]);
  assert.ok(!JSON.stringify(m).includes("opaque chain of thought"));
});

test("piToOpenAI: text-only assistant has no tool_calls key", () => {
  const [m] = piToOpenAI([assistantTextOnly]);
  assert.equal(m.content, "just text");
  assert.ok(!("tool_calls" in m));
});

test("piToOpenAI: toolResult → role tool with tool_call_id, text joined", () => {
  const [m] = piToOpenAI([toolResult]);
  assert.deepEqual(m, { role: "tool", content: "file1\nfile2", tool_call_id: "call_1" });
});

test("piToOpenAI: preserves message order", () => {
  const out = piToOpenAI([userString, assistantTextOnly, toolResult]);
  assert.deepEqual(out.map((m) => m.role), ["user", "assistant", "tool"]);
});

// ─── openAIToPi (positional alignment) ────────────────────────────────

test("openAIToPi: matching count — user metadata preserved, text swapped", () => {
  const original = [userString];
  const compressed = [{ role: "user", content: "SHORT" }];
  const [m] = openAIToPi(compressed, original);
  assert.equal(m.role, "user");
  assert.equal(m.timestamp, 111); // preserved from original
  assert.deepEqual(m.content, [{ type: "text", text: "SHORT" }]);
});

test("openAIToPi: matching count — user image remains when compressed content is text-only", () => {
  const [m] = openAIToPi([{ role: "user", content: "compressed caption" }], [userImage]);
  assert.equal(m.role, "user");
  assert.deepEqual(m.content, [
    { type: "text", text: "compressed caption" },
    { type: "image", data: "QUJD", mimeType: "image/png" },
  ]);
});

test("openAIToPi: matching count — returned user image_url maps back to Pi image", () => {
  const [m] = openAIToPi([
    {
      role: "user",
      content: [
        { type: "text", text: "compressed caption" },
        { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
      ],
    },
  ], [userString]);
  assert.equal(m.role, "user");
  assert.deepEqual(m.content, [
    { type: "text", text: "compressed caption" },
    { type: "image", data: "QUJD", mimeType: "image/png" },
  ]);
});

test("openAIToPi: matching count — assistant thinking re-attached, toolCall re-parsed", () => {
  const original = [assistantMixed];
  const compressed = [
    {
      role: "assistant",
      content: "compressed",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"pwd"}' } },
      ],
    },
  ];
  const [m] = openAIToPi(compressed, original);
  assert.equal(m.role, "assistant");
  assert.equal(m.timestamp, 444);
  assert.equal(m.model, "gpt-4o"); // structural metadata kept
  const kinds = m.content.map((p) => p.type);
  assert.deepEqual(kinds, ["thinking", "text", "toolCall"]);
  assert.equal(m.content[1].text, "compressed");
  assert.deepEqual(m.content[2].arguments, { command: "pwd" });
});

test("openAIToPi: matching count — toolResult metadata preserved, text swapped", () => {
  const original = [toolResult];
  const compressed = [{ role: "tool", content: "TRUNCATED...", tool_call_id: "call_1" }];
  const [m] = openAIToPi(compressed, original);
  assert.equal(m.role, "toolResult");
  assert.equal(m.toolName, "bash");
  assert.equal(m.toolCallId, "call_1");
  assert.equal(m.isError, false);
  assert.deepEqual(m.content, [{ type: "text", text: "TRUNCATED..." }]);
});

test("openAIToPi: matching count — toolResult image remains after text compression", () => {
  const [m] = openAIToPi([
    { role: "tool", content: "compressed screen description", tool_call_id: "call_image" },
  ], [toolResultImage]);
  assert.equal(m.role, "toolResult");
  assert.deepEqual(m.content, [
    { type: "text", text: "compressed screen description" },
    { type: "image", data: "REVG", mimeType: "image/jpeg" },
  ]);
});

test("openAIToPi: role mismatch builds fresh message instead of corrupting", () => {
  // Original user, compressed says assistant
  const original = [userString];
  const compressed = [{ role: "assistant", content: "hi" }];
  const [m] = openAIToPi(compressed, original);
  assert.equal(m.role, "assistant");
  assert.equal(m.content[0].text, "hi");
  // Fresh assistant must be structurally complete
  assert.equal(m.stopReason, "stop");
  assert.ok(m.usage);
  assert.ok(typeof m.timestamp === "number");
});

// ─── openAIToPi (count mismatch → fresh messages) ─────────────────────

test("openAIToPi: count mismatch — fresh user message is valid", () => {
  const original = [userString, toolResult];
  const compressed = [{ role: "user", content: "merged" }]; // 1 vs 2
  const [m] = openAIToPi(compressed, original);
  assert.equal(m.role, "user");
  assert.deepEqual(m.content, [{ type: "text", text: "merged" }]);
  assert.ok(typeof m.timestamp === "number");
});

test("openAIToPi: image count mismatch reports unapplied safety fallback", () => {
  const original = [userImage, assistantTextOnly];
  const compressed = [{ role: "user", content: "merged" }];
  const outcome = openAIToPiWithOutcome(compressed, original);
  assert.equal(outcome.messages, original);
  assert.equal(outcome.applied, false);
  assert.equal(outcome.reason, "image-count-mismatch");
  assert.equal(openAIToPi(compressed, original), original, "legacy wrapper preserves message result");
});

test("openAIToPi: count mismatch — fresh assistant complete with tool calls", () => {
  const original = [userString, assistantMixed];
  const compressed = [
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c9", type: "function", function: { name: "read", arguments: '{"path":"/tmp"}' } },
      ],
    },
  ];
  const [m] = openAIToPi(compressed, original);
  assert.equal(m.role, "assistant");
  assert.equal(m.content.length, 1);
  assert.deepEqual(m.content[0], { type: "toolCall", id: "c9", name: "read", arguments: { path: "/tmp" } });
  assert.equal(m.api, "openai-completions");
  assert.equal(m.provider, "unknown");
});

test("openAIToPi: count mismatch — fresh tool message gets unknown toolName", () => {
  const original = [userString, toolResult];
  const compressed = [{ role: "tool", content: "x", tool_call_id: "c1" }];
  const [m] = openAIToPi(compressed, original);
  assert.equal(m.role, "toolResult");
  assert.equal(m.toolName, "unknown");
  assert.equal(m.toolCallId, "c1");
  assert.equal(m.isError, false);
});

// ─── Edge cases ───────────────────────────────────────────────────────

test("openAIToPi: invalid JSON tool arguments → {_raw} fallback", () => {
  const original = [assistantMixed];
  const compressed = [
    {
      role: "assistant",
      content: "x",
      tool_calls: [
        { id: "c1", type: "function", function: { name: "bash", arguments: "not-json{" } },
      ],
    },
  ];
  const [m] = openAIToPi(compressed, original);
  const tc = m.content.find((p) => p.type === "toolCall");
  assert.deepEqual(tc.arguments, { _raw: "not-json{" });
});

test("openAIToPi: null assistant content → no text part", () => {
  const original = [assistantMixed];
  const compressed = [{ role: "assistant", content: null }];
  const [m] = openAIToPi(compressed, original);
  const kinds = m.content.map((p) => p.type);
  assert.ok(!kinds.includes("text"));
  assert.ok(kinds.includes("thinking")); // original thinking preserved
});

test("openAIToPi: empty input → empty output", () => {
  assert.deepEqual(openAIToPi([], []), []);
});

// ─── Round-trip stability ─────────────────────────────────────────────

test("round-trip: piToOpenAI is stable across compress round-trips", () => {
  const original = [userString, assistantMixed, toolResult];
  const once = piToOpenAI(original);
  // Simulate a compression that returns the same messages (identity compression)
  const back = openAIToPi(once, original);
  const twice = piToOpenAI(back);
  assert.deepEqual(twice, once);
});
