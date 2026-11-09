/**
 * Format bridge between Pi-AI Message[] and Headroom OpenAI message format.
 *
 * Pi-AI types:
 *   UserMessage    { role: "user", content: string | (TextContent | ImageContent)[], timestamp }
 *   AssistantMessage { role: "assistant", content: (TextContent | ThinkingContent | ToolCall)[], api, provider, model, usage, stopReason, timestamp, ... }
 *   ToolResultMessage { role: "toolResult", toolCallId, toolName, content: (TextContent | ImageContent)[], details?, isError, timestamp }
 *
 * Headroom OpenAI types:
 *   SystemMessage   { role: "system", content: string }
 *   UserMessage     { role: "user", content: string | ContentPart[] }
 *   AssistantMessage { role: "assistant", content: string | null, tool_calls?: ToolCall[] }
 *   ToolMessage     { role: "tool", content: string, tool_call_id: string }
 */

import { isDeepStrictEqual } from "node:util";

import type {
  Message,
  UserMessage as PiUserMessage,
  AssistantMessage as PiAssistantMessage,
  ToolResultMessage as PiToolResultMessage,
  TextContent,
  ImageContent,
  ToolCall as PiToolCall,
} from "@earendil-works/pi-ai";

import type {
  OpenAIMessage,
  ToolCall as OpenAIToolCall,
} from "headroom-ai";

// ─── Pi-AI → OpenAI ────────────────────────────────────────────────────

/**
 * Convert Pi-AI Message[] to Headroom OpenAI format.
 *
 * - Strips ThinkingContent from assistant messages (opaque/encrypted, not useful for compression)
 * - Serializes Pi tool call arguments (Record<string,any>) to JSON strings
 * - Converts Pi ImageContent (base64) to OpenAI image_url content parts
 */
export function piToOpenAI(messages: Message[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "user":
        result.push(convertUserMessage(msg));
        break;
      case "assistant":
        result.push(convertAssistantMessage(msg));
        break;
      case "toolResult":
        result.push(convertToolResultMessage(msg));
        break;
    }
  }

  return result;
}

function convertUserMessage(msg: PiUserMessage): OpenAIMessage {
  if (typeof msg.content === "string") {
    return { role: "user", content: msg.content };
  }

  // Check if there are any images
  const hasImages = msg.content.some((part) => part.type === "image");

  if (!hasImages) {
    // Text-only: join into a single string
    const text = msg.content
      .filter((p): p is TextContent => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    return { role: "user", content: text };
  }

  // Mixed content: convert to OpenAI content parts
  const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [];
  for (const part of msg.content) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      const imgPart = part as ImageContent;
      parts.push({
        type: "image_url",
        image_url: { url: `data:${imgPart.mimeType};base64,${imgPart.data}` },
      });
    }
  }
  return { role: "user", content: parts as any };
}

function convertAssistantMessage(msg: PiAssistantMessage): OpenAIMessage {
  // Extract text parts (skip ThinkingContent)
  const textParts = msg.content.filter((p): p is TextContent => p.type === "text");
  const text = textParts.map((p) => p.text).join("");

  // Extract tool calls
  const toolCalls = msg.content.filter((p): p is PiToolCall => p.type === "toolCall");

  const openaiMsg: any = {
    role: "assistant",
    content: text || null,
  };

  if (toolCalls.length > 0) {
    openaiMsg.tool_calls = toolCalls.map(
      (tc): OpenAIToolCall => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      }),
    );
  }

  return openaiMsg;
}

function convertToolResultMessage(msg: PiToolResultMessage): OpenAIMessage {
  const text = msg.content
    .filter((p): p is TextContent => p.type === "text")
    .map((p) => p.text)
    .join("\n");

  return {
    role: "tool",
    content: text,
    tool_call_id: msg.toolCallId,
  };
}

// ─── OpenAI → Pi-AI ────────────────────────────────────────────────────

/**
 * Convert compressed OpenAI messages back to Pi-AI Message[] format.
 *
 * Strategy: positional alignment with the original messages.
 * - If message counts match, copy structural metadata from originals, take text from compressed.
 * - Messages Headroom did not change are returned as the original object.
 * - If counts differ (compression merged/dropped messages), match tool results and
 *   tool-calling assistant messages to their originals by tool-call id. If any cannot
 *   be matched, report an unapplied outcome instead of inventing metadata.
 */
export interface OpenAIToPiOutcome {
  messages: Message[];
  applied: boolean;
  reason?: "image-count-mismatch" | "unmatched-after-count-change";
}

export function openAIToPiWithOutcome(compressed: OpenAIMessage[], original: Message[]): OpenAIToPiOutcome {
  // A changed message count destroys image-to-message association. Preserve the
  // original transcript rather than attaching an image to the wrong message.
  if (compressed.length !== original.length && (hasPiImages(original) || hasOpenAIImages(compressed))) {
    return { messages: original, applied: false, reason: "image-count-mismatch" };
  }

  // If counts match, use positional alignment.
  if (compressed.length === original.length) {
    return { messages: compressed.map((compMsg, i) => alignMessage(compMsg, original[i])), applied: true };
  }

  // Counts differ without images: positional alignment is impossible, so match
  // tool results and tool-calling assistant messages to their originals by
  // tool-call id. Never invent tool names, error flags or provider metadata:
  // when something cannot be matched, keep the original transcript instead.
  const messages = rebuildAfterCountChange(compressed, original);
  if (!messages) return { messages: original, applied: false, reason: "unmatched-after-count-change" };
  return { messages, applied: true };
}

function rebuildAfterCountChange(compressed: OpenAIMessage[], original: Message[]): Message[] | null {
  const toolResults = new Map<string, PiToolResultMessage>();
  const assistantsByCallId = new Map<string, PiAssistantMessage>();
  for (const msg of original) {
    if (msg.role === "toolResult") toolResults.set(msg.toolCallId, msg);
    else if (msg.role === "assistant") {
      for (const part of msg.content) if (part.type === "toolCall") assistantsByCallId.set(part.id, msg);
    }
  }

  const usedAssistants = new Set<PiAssistantMessage>();
  const usedResults = new Set<string>();
  const result: Message[] = [];
  for (const comp of compressed) {
    if (comp.role === "tool") {
      const orig = toolResults.get(comp.tool_call_id);
      if (!orig || usedResults.has(comp.tool_call_id)) return null;
      usedResults.add(comp.tool_call_id);
      result.push({ ...orig, content: replaceTextPreservingImages(orig.content, comp.content) });
    } else if (comp.role === "assistant" && comp.tool_calls?.length) {
      let orig: PiAssistantMessage | undefined;
      for (const tc of comp.tool_calls) orig ??= assistantsByCallId.get(tc.id);
      if (!orig || usedAssistants.has(orig)) return null;
      usedAssistants.add(orig);
      result.push(alignAssistantMessage(comp, orig));
    } else {
      // User/system text and assistant text without tool calls carry no
      // metadata that a tool-call id could restore.
      result.push(buildFreshMessage(comp));
    }
  }
  return result;
}

/**
 * Map compressed LLM messages back onto the agent messages they came from, so
 * later `context` handlers still see custom, bash-execution and summary roles.
 *
 * `agentMessages[i]` must be the source of `llmMessages[i]`, and `compressed`
 * must be position-aligned with `llmMessages` (equal length). Otherwise the
 * compressed messages are returned as they are.
 *
 * - Unchanged message: the original agent message object.
 * - Changed `custom` message: the original with only `content` replaced.
 * - Changed bash-execution/summary message: the converted user message, because
 *   their structured fields cannot be rebuilt from compressed text.
 * - user/assistant/toolResult: the aligned message (already built from the original).
 */
export function restoreAgentMessages<T extends { role: string }>(
  agentMessages: readonly T[],
  llmMessages: readonly Message[],
  compressed: readonly Message[],
): Array<T | Message> {
  if (agentMessages.length !== llmMessages.length || compressed.length !== llmMessages.length) return [...compressed];
  return compressed.map((msg, i) => {
    const agent = agentMessages[i];
    if (msg === llmMessages[i] || isDeepStrictEqual(msg, llmMessages[i])) return agent;
    if (agent.role === "custom" && msg.role === "user") return { ...agent, content: msg.content } as T;
    return msg;
  });
}

/**
 * Align a compressed OpenAI message with its original Pi message,
 * preserving structural metadata from the original.
 */
function alignMessage(comp: OpenAIMessage, orig: Message): Message {
  switch (comp.role) {
    case "system":
    case "user":
      return alignUserMessage(comp, orig);
    case "assistant":
      return alignAssistantMessage(comp, orig);
    case "tool":
      return alignToolResultMessage(comp, orig);
    default:
      return buildFreshMessage(comp);
  }
}

function alignUserMessage(comp: OpenAIMessage & { role: "system" | "user" }, orig: Message): Message {
  const content = openAIUserContentToPi(comp.content);

  if (orig.role === "user") {
    if (comp.role === "user" && isDeepStrictEqual(comp.content, convertUserMessage(orig).content)) return orig;
    if (!hasImageParts(orig.content)) return { ...orig, content };
    // Headroom may return string content even when input had images. Keep the original image
    // parts because they cannot safely be associated otherwise; when captions would lose their
    // images, keep the whole message.
    const merged = mergeCompressedParts(orig.content, content);
    return merged ? { ...orig, content: merged } : orig;
  }

  // Role mismatch: build fresh
  return {
    role: "user",
    content,
    timestamp: orig.timestamp ?? Date.now(),
  };
}

function alignAssistantMessage(comp: OpenAIMessage & { role: "assistant" }, orig: Message): Message {
  // Role mismatch: build fresh
  if (orig.role !== "assistant") return buildFreshAssistantMessage(comp);

  const compText = typeof comp.content === "string" ? comp.content : "";
  const compCalls = comp.tool_calls ?? [];
  const origCalls = orig.content.filter((p): p is PiToolCall => p.type === "toolCall");
  const origText = orig.content.filter((p): p is TextContent => p.type === "text").map((p) => p.text).join("");

  const textSame = compText === origText;
  const callsSame =
    compCalls.length === origCalls.length &&
    compCalls.every((tc, i) =>
      tc.id === origCalls[i].id &&
      tc.function.name === origCalls[i].name &&
      isDeepStrictEqual(safeJsonParse(tc.function.arguments), origCalls[i].arguments),
    );
  // Keep the original untouched when Headroom did not change it: providers
  // replay signatures, thinking order and tool-call metadata from these blocks.
  if (textSame && callsSame) return orig;

  // Merge into the original blocks in place. Only text and tool-call arguments
  // are replaced; thinking blocks, signatures, namespaces and order stay.
  const compCallById = new Map(compCalls.map((tc) => [tc.id, tc]));
  const seenCalls = new Set<string>();
  const content: PiAssistantMessage["content"] = [];
  let textPlaced = textSame;
  for (const block of orig.content) {
    if (block.type === "text" && !textSame) {
      if (!textPlaced) {
        textPlaced = true;
        if (compText) content.push({ ...block, text: compText });
      }
      continue;
    }
    if (block.type === "toolCall") {
      const tc = compCallById.get(block.id);
      if (!tc) continue; // Headroom dropped this call
      seenCalls.add(block.id);
      content.push({ ...block, arguments: parseArguments(tc.function.arguments) ?? block.arguments });
      continue;
    }
    content.push(block);
  }

  if (!textPlaced && compText) {
    const firstCall = content.findIndex((p) => p.type === "toolCall");
    content.splice(firstCall === -1 ? content.length : firstCall, 0, { type: "text", text: compText });
  }
  // Tool calls that did not exist in the original are appended as plain calls.
  for (const tc of compCalls) {
    if (seenCalls.has(tc.id)) continue;
    content.push({ type: "toolCall", id: tc.id, name: tc.function.name, arguments: safeJsonParse(tc.function.arguments) });
  }

  return { ...orig, content };
}

function alignToolResultMessage(comp: OpenAIMessage & { role: "tool" }, orig: Message): Message {
  if (orig.role === "toolResult") {
    if (comp.content === convertToolResultMessage(orig).content) return orig;
    // Several text parts around images cannot be told apart in one string: keep the message.
    if (hasImageParts(orig.content) && orig.content.filter((part) => part.type === "text").length > 1) return orig;
    return {
      ...orig,
      // OpenAI tool messages only support string content, so retain original
      // image parts while replacing text with compressed text.
      content: replaceTextPreservingImages(orig.content, comp.content),
    };
  }

  // Role mismatch: build fresh
  return buildFreshToolResultMessage(comp);
}

// ─── Fresh message builders (when positional alignment fails) ───────────

function buildFreshMessage(comp: OpenAIMessage): Message {
  switch (comp.role) {
    case "system":
    case "user":
      return buildFreshUserMessage(comp);
    case "assistant":
      return buildFreshAssistantMessage(comp);
    case "tool":
      return buildFreshToolResultMessage(comp);
    default:
      return {
        role: "user",
        content: [{ type: "text", text: String((comp as any).content ?? "") }],
        timestamp: Date.now(),
      };
  }
}

function buildFreshUserMessage(comp: { role: string; content: any }): PiUserMessage {
  return {
    role: "user",
    content: openAIUserContentToPi(comp.content),
    timestamp: Date.now(),
  };
}

function buildFreshAssistantMessage(comp: OpenAIMessage & { role: "assistant" }): PiAssistantMessage {
  const contentParts: PiAssistantMessage["content"] = [];

  if (typeof comp.content === "string" && comp.content) {
    contentParts.push({ type: "text", text: comp.content });
  }

  if (comp.tool_calls) {
    for (const tc of comp.tool_calls) {
      contentParts.push({
        type: "toolCall",
        id: tc.id,
        name: tc.function.name,
        arguments: safeJsonParse(tc.function.arguments),
      });
    }
  }

  return {
    role: "assistant",
    content: contentParts,
    api: "openai-completions",
    provider: "unknown",
    model: "unknown",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function buildFreshToolResultMessage(comp: OpenAIMessage & { role: "tool" }): PiToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: comp.tool_call_id,
    toolName: "unknown",
    content: [{ type: "text", text: comp.content }],
    isError: false,
    timestamp: Date.now(),
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function hasPiImages(messages: Message[]): boolean {
  return messages.some((msg) =>
    (msg.role === "user" || msg.role === "toolResult") && hasImageParts(msg.content),
  );
}

function hasOpenAIImages(messages: OpenAIMessage[]): boolean {
  return messages.some((msg) =>
    msg.role === "user" && Array.isArray(msg.content) && msg.content.some((part) => part.type === "image_url"),
  );
}

function hasImageParts(
  content: PiUserMessage["content"] | PiToolResultMessage["content"],
): content is Array<TextContent | ImageContent> {
  return Array.isArray(content) && content.some((part) => part.type === "image");
}

function openAIUserContentToPi(content: unknown): Array<TextContent | ImageContent> {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  if (!Array.isArray(content)) {
    return [{ type: "text", text: "" }];
  }

  const result: Array<TextContent | ImageContent> = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;

    if ((part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string") {
      result.push({ type: "text", text: (part as { text: string }).text });
      continue;
    }

    if ((part as { type?: unknown }).type === "image_url") {
      const url = (part as { image_url?: { url?: unknown } }).image_url?.url;
      const image = imageFromDataUrl(url);
      if (image) result.push(image);
    }
  }

  return result.length > 0 ? result : [{ type: "text", text: "" }];
}

function imageFromDataUrl(url: unknown): ImageContent | null {
  if (typeof url !== "string") return null;

  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
  if (!match) return null;

  return { type: "image", mimeType: match[1], data: match[2] };
}

function textFromContentParts(content: Array<TextContent | ImageContent>): string {
  return content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/**
 * Fold compressed content into the original parts. The same part layout keeps every caption next to
 * its image; a single text part (or none) takes all compressed text; anything else cannot be mapped
 * back safely, so the caller keeps the original message. Images always come from the original.
 */
function mergeCompressedParts(
  original: Array<TextContent | ImageContent>,
  compressed: Array<TextContent | ImageContent>,
): Array<TextContent | ImageContent> | null {
  if (original.length === compressed.length && original.every((part, i) => part.type === compressed[i].type)) {
    return original.map((part, i) => {
      const next = compressed[i];
      return part.type === "text" && next.type === "text" ? { ...part, text: next.text } : part;
    });
  }
  if (original.filter((part) => part.type === "text").length <= 1) {
    return replaceTextPreservingImages(original, textFromContentParts(compressed));
  }
  return null;
}

function replaceTextPreservingImages(
  original: Array<TextContent | ImageContent>,
  compressedText: string,
): Array<TextContent | ImageContent> {
  const result: Array<TextContent | ImageContent> = [];
  let insertedText = false;

  for (const part of original) {
    if (part.type === "text") {
      if (!insertedText && compressedText) {
        result.push({ type: "text", text: compressedText });
        insertedText = true;
      }
      continue;
    }

    result.push(part);
  }

  if (!insertedText && compressedText) {
    result.unshift({ type: "text", text: compressedText });
  }

  return result;
}

/** Tool-call arguments as a plain object, or null (invalid, truncated, `null` or an array) so the caller keeps the original. */
function parseArguments(str: string): Record<string, any> | null {
  try {
    const value: unknown = JSON.parse(str);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, any> : null;
  } catch {
    return null;
  }
}

function safeJsonParse(str: string): Record<string, any> {
  try {
    return JSON.parse(str);
  } catch {
    return { _raw: str };
  }
}
