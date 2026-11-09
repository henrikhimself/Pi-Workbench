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
const { piToOpenAI, openAIToPiWithOutcome, restoreAgentMessages } = await jiti.import("../src/format-bridge.ts");
const openAIToPi = (compressed, original) => openAIToPiWithOutcome(compressed, original).messages;

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

test("openAIToPi: matching count — thinking kept in place, text replaced, toolCall re-parsed", () => {
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
  assert.deepEqual(kinds, ["text", "thinking", "toolCall"], "original block order is preserved");
  assert.equal(m.content[0].text, "compressed");
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

test("openAIToPi: count mismatch — assistant matched by tool-call id keeps metadata and signatures", () => {
  const assistant = {
    ...assistantMixed,
    content: [
      { type: "thinking", thinking: "t", thinkingSignature: "sig-t" },
      { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" }, thoughtSignature: "ts-1", namespace: "ns" },
    ],
  };
  const original = [userString, assistant, toolResult];
  const compressed = [
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"pwd"}' } }] },
    { role: "tool", content: "short", tool_call_id: "call_1" },
  ];
  const outcome = openAIToPiWithOutcome(compressed, original);
  assert.equal(outcome.applied, true);
  const [m, r] = outcome.messages;
  assert.equal(m.provider, "openai");
  assert.equal(m.model, "gpt-4o");
  assert.equal(m.usage, assistant.usage);
  assert.deepEqual(m.content[0], assistant.content[0]);
  assert.deepEqual(m.content[1], { ...assistant.content[1], arguments: { command: "pwd" } });
  assert.equal(r.toolName, "bash");
  assert.equal(r.isError, false);
  assert.deepEqual(r.content, [{ type: "text", text: "short" }]);
});

test("openAIToPi: count mismatch — tool result keeps toolName and isError from its original", () => {
  const failed = { ...toolResult, toolName: "read", isError: true, details: { exit: 1 } };
  const original = [userString, assistantMixed, failed];
  const compressed = [{ role: "tool", content: "x", tool_call_id: "call_1" }];
  const [m] = openAIToPi(compressed, original);
  assert.equal(m.toolName, "read");
  assert.equal(m.isError, true);
  assert.deepEqual(m.details, { exit: 1 });
  assert.equal(m.timestamp, failed.timestamp);
});

test("openAIToPi: count mismatch — unmatched tool call id keeps the original transcript", () => {
  const original = [userString, assistantMixed];
  const compressed = [
    { role: "assistant", content: null, tool_calls: [{ id: "c9", type: "function", function: { name: "read", arguments: '{"path":"/tmp"}' } }] },
  ];
  const outcome = openAIToPiWithOutcome(compressed, original);
  assert.equal(outcome.applied, false);
  assert.equal(outcome.reason, "unmatched-after-count-change");
  assert.equal(outcome.messages, original);
});

test("openAIToPi: count mismatch — unmatched tool result keeps the original transcript", () => {
  const original = [userString, toolResult];
  const compressed = [{ role: "tool", content: "x", tool_call_id: "c1" }];
  const outcome = openAIToPiWithOutcome(compressed, original);
  assert.equal(outcome.applied, false);
  assert.equal(outcome.reason, "unmatched-after-count-change");
  assert.equal(outcome.messages, original);
});

test("openAIToPi: count mismatch — one original assistant cannot be matched twice", () => {
  const original = [userString, assistantMixed, toolResult];
  const call = { type: "function", function: { name: "bash", arguments: "{}" } };
  const compressed = [
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", ...call }] },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", ...call }] },
  ];
  assert.equal(openAIToPiWithOutcome(compressed, original).applied, false);
});

// ─── openAIToPi (fidelity of unchanged and merged assistant messages) ──

const signedAssistant = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "first", thinkingSignature: "sig-a" },
    { type: "text", text: "before ", textSignature: "tsig-1" },
    { type: "toolCall", id: "call_a", name: "read", arguments: { path: "a" }, thoughtSignature: "ts-a", namespace: "ns-a" },
    { type: "thinking", thinking: "second", thinkingSignature: "sig-b" },
    { type: "text", text: "after", textSignature: "tsig-2" },
    { type: "toolCall", id: "call_b", name: "bash", arguments: { command: "ls" }, thoughtSignature: "ts-b" },
  ],
  api: "google-generative-ai",
  provider: "google",
  model: "gemini-3-pro",
  usage: zeroUsage(),
  stopReason: "toolUse",
  timestamp: 900,
};

test("openAIToPi: unchanged assistant message comes back as the same object (signatures intact)", () => {
  const original = [signedAssistant];
  const [m] = openAIToPi(piToOpenAI(original), original);
  assert.equal(m, signedAssistant);
});

test("openAIToPi: unchanged messages of every role come back as the same object", () => {
  const original = [userString, userArray, signedAssistant, toolResult];
  const back = openAIToPi(piToOpenAI(original), original);
  back.forEach((m, i) => assert.equal(m, original[i]));
});

test("openAIToPi: tool-call arguments with different whitespace are not a change", () => {
  const compressed = piToOpenAI([signedAssistant]);
  compressed[0].tool_calls[0].function.arguments = '{ "path": "a" }';
  const [m] = openAIToPi(compressed, [signedAssistant]);
  assert.equal(m, signedAssistant);
});

test("openAIToPi: compressed tool-call arguments keep thoughtSignature, namespace and order", () => {
  const compressed = piToOpenAI([signedAssistant]);
  compressed[0].tool_calls[1].function.arguments = '{"command":"ls -l"}';
  const [m] = openAIToPi(compressed, [signedAssistant]);
  assert.notEqual(m, signedAssistant);
  assert.deepEqual(m.content.map((p) => p.type), ["thinking", "text", "toolCall", "thinking", "text", "toolCall"]);
  assert.deepEqual(m.content[2], signedAssistant.content[2]);
  assert.deepEqual(m.content[5], { ...signedAssistant.content[5], arguments: { command: "ls -l" } });
  assert.deepEqual(m.content[1], signedAssistant.content[1], "text blocks and their signatures untouched");
  assert.deepEqual(m.content[4], signedAssistant.content[4]);
  assert.equal(m.provider, "google");
});

test("openAIToPi: compressed text goes into the first text block, other text blocks are dropped", () => {
  const compressed = piToOpenAI([signedAssistant]);
  compressed[0].content = "short";
  const [m] = openAIToPi(compressed, [signedAssistant]);
  assert.deepEqual(m.content.map((p) => p.type), ["thinking", "text", "toolCall", "thinking", "toolCall"]);
  assert.deepEqual(m.content[1], { type: "text", text: "short", textSignature: "tsig-1" });
  assert.deepEqual(m.content[3], signedAssistant.content[3], "later thinking block keeps its position");
});

test("openAIToPi: tool call unknown to the original is appended as a plain call", () => {
  const compressed = piToOpenAI([signedAssistant]);
  compressed[0].tool_calls.push({ id: "call_new", type: "function", function: { name: "ls", arguments: "{}" } });
  const [m] = openAIToPi(compressed, [signedAssistant]);
  assert.deepEqual(m.content.at(-1), { type: "toolCall", id: "call_new", name: "ls", arguments: {} });
  assert.deepEqual(m.content[2], signedAssistant.content[2]);
});

// ─── restoreAgentMessages ─────────────────────────────────────────────

const bashExecution = { role: "bashExecution", command: "ls", output: "a", exitCode: 0, cancelled: false, truncated: false, timestamp: 1000 };
const custom = { role: "custom", customType: "note", content: "custom text", display: true, timestamp: 1001 };
const bashLlm = { role: "user", content: [{ type: "text", text: "Ran `ls`\na" }], timestamp: 1000 };
const customLlm = { role: "user", content: [{ type: "text", text: "custom text" }], timestamp: 1001 };

test("restoreAgentMessages: unchanged custom and bash messages keep their original role", () => {
  const agent = [bashExecution, custom, userString];
  const llm = [bashLlm, customLlm, userString];
  const out = restoreAgentMessages(agent, llm, llm.map((m) => ({ ...m })));
  assert.equal(out[0], bashExecution);
  assert.equal(out[1], custom);
  assert.equal(out[2], userString);
});

test("restoreAgentMessages: changed custom message keeps the original with only content replaced", () => {
  const agent = [custom];
  const changed = { ...customLlm, content: [{ type: "text", text: "short" }] };
  const [m] = restoreAgentMessages(agent, [customLlm], [changed]);
  assert.deepEqual(m, { ...custom, content: [{ type: "text", text: "short" }] });
});

test("restoreAgentMessages: changed bash message falls back to the converted user message", () => {
  const changed = { ...bashLlm, content: [{ type: "text", text: "short" }] };
  const [m] = restoreAgentMessages([bashExecution], [bashLlm], [changed]);
  assert.equal(m, changed);
});

test("restoreAgentMessages: a changed message count returns the compressed messages as they are", () => {
  const compressed = [customLlm];
  assert.deepEqual(restoreAgentMessages([bashExecution, custom], [bashLlm, customLlm], compressed), compressed);
});

// ─── Edge cases ───────────────────────────────────────────────────────

const argumentsOutcome = (rawArguments) => {
  const [m] = openAIToPi([{ role: "assistant", content: "x", tool_calls: [
    { id: "call_1", type: "function", function: { name: "bash", arguments: rawArguments } },
  ] }], [assistantMixed]);
  return m;
};

test("openAIToPi: invalid JSON tool arguments keep the original arguments", () => {
  const m = argumentsOutcome("not-json{");
  const tc = m.content.find((p) => p.type === "toolCall");
  assert.deepEqual(tc.arguments, { command: "ls -la" });
  assert.equal(m.content.find((p) => p.type === "text").text, "x");
});

test("H-11: non-object JSON arguments keep the original arguments", () => {
  for (const raw of ["null", "[1]"]) {
    const m = argumentsOutcome(raw);
    assert.deepEqual(m.content.find((p) => p.type === "toolCall").arguments, { command: "ls -la" }, raw);
    assert.equal(m.content.find((p) => p.type === "text").text, "x", raw);
  }
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

const interleavedUser = {
  role: "user",
  content: [
    { type: "text", text: "Before:" },
    { type: "image", data: "QUJD", mimeType: "image/png" },
    { type: "text", text: "After:" },
    { type: "image", data: "REVG", mimeType: "image/png" },
  ],
  timestamp: 901,
};
const interleavedToolResult = {
  role: "toolResult", toolCallId: "call_interleaved", toolName: "screenshot", isError: false, timestamp: 902,
  content: interleavedUser.content,
};

test("H-10: interleaved captions stay with their images when the layout is unchanged", () => {
  const compressed = piToOpenAI([interleavedUser]);
  const texts = compressed[0].content.filter((part) => part.type === "text");
  texts[0].text = "B:"; texts[1].text = "A:";
  const [m] = openAIToPi(compressed, [interleavedUser]);
  assert.deepEqual(m.content, [
    { type: "text", text: "B:" },
    interleavedUser.content[1],
    { type: "text", text: "A:" },
    interleavedUser.content[3],
  ]);
  assert.equal(m.content[1], interleavedUser.content[1], "images stay the original objects");
});

test("H-10: interleaved captions whose layout was lost keep the original message", () => {
  const [user] = openAIToPi([{ role: "user", content: "Before:\nAfter:" }], [interleavedUser]);
  assert.equal(user, interleavedUser);
  const [tool] = openAIToPi([{ role: "tool", tool_call_id: "call_interleaved", content: "Before: After:" }], [interleavedToolResult]);
  assert.equal(tool, interleavedToolResult);
});
