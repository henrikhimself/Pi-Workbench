/**
 * E2E check: replicate the extension's exact compress path against the live proxy.
 * Same construction as src/index.ts:
 *   new HeadroomClient({ baseUrl, fallback: false, timeout: 15_000 })
 *   compress(openaiMessages, { client, model })
 * Then verify happy-path shape/accounting plus controlled unavailable-proxy
 * rejection. It never stops or mutates proxy used by current Pi session.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { HeadroomClient, compress } from "headroom-ai";

async function resolveBaseUrl() {
  const configPath = join(homedir(), ".pi", "pi-workbench", "headroom.json");
  try {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    if (typeof config.url === "string") return config.url;
    if (Number.isInteger(config.port) && config.port >= 1 && config.port <= 65535) {
      return `http://127.0.0.1:${config.port}`;
    }
  } catch {
    // Mirror extension bootstrap defaults when config does not exist yet.
  }
  return "http://127.0.0.1:8787";
}

const baseUrl = await resolveBaseUrl();
const model = process.env.PI_MODEL || "Qwen3.8-27B";

// Build a realistic, compressible coding context
const lines = [];
for (let i = 0; i < 40; i++) {
  lines.push(`drwxr-xr-x  5 htj htj   4096 Oct 04 10:00 dir_${String(i).padStart(2, "0")}`);
}
const lsOutput = "total 128\n" + lines.join("\n") + "\n";
const fileDump = Array.from({ length: 200 }, (_, i) =>
  `  1${String(i).padStart(3, "0")} | function handler${i}(req, res) { const result = process(req); return res.json({ ok: true, n: ${i} }); }`,
).join("\n");

const messages = [
  { role: "user", content: "Explore this repo. Run ls, then read src/server.js and tell me what it does." },
  {
    role: "assistant",
    content: "Let me explore the repository structure first.",
    tool_calls: [
      { id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"ls -la"}' } },
    ],
  },
  { role: "tool", content: lsOutput, tool_call_id: "c1" },
  {
    role: "assistant",
    content: "Now reading the main server file.",
    tool_calls: [
      { id: "c2", type: "function", function: { name: "read", arguments: '{"path":"src/server.js"}' } },
    ],
  },
  { role: "tool", content: fileDump, tool_call_id: "c2" },
  {
    role: "assistant",
    content: "The server module contains 200 handler functions, each wrapping a process() call and returning JSON.",
  },
  { role: "user", content: "OK. Now add a health endpoint that returns 200 with status ok." },
  {
    role: "assistant",
    content: "I'll add a GET /health endpoint to the server.",
    tool_calls: [
      { id: "c3", type: "function", function: { name: "edit", arguments: '{"path":"src/server.js"}' } },
    ],
  },
  { role: "tool", content: "Edit applied successfully.", tool_call_id: "c3" },
  { role: "assistant", content: "Done. The /health endpoint is in place." },
];

// Exact client construction from src/index.ts
const client = new HeadroomClient({ baseUrl, fallback: false, timeout: 15_000 });
const t0 = Date.now();
const result = await compress(messages, { client, model });
const elapsed = Date.now() - t0;

console.log("== E2E compress result ==");
console.log(`model: ${model}`);
console.log(`latency: ${elapsed}ms`);
console.log(`compressed: ${result.compressed}`);
console.log(`tokens: ${result.tokensBefore} -> ${result.tokensAfter} (saved ${result.tokensSaved}, ratio ${result.compressionRatio.toFixed(3)})`);
console.log(`transforms: ${result.transformsApplied.join(", ") || "none"}`);
console.log(`messages out: ${result.messages.length} (in: ${messages.length})`);

// ─── Verify result shape ─────────────────────────────────────────────
let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}

check("returned messages is non-empty array", Array.isArray(result.messages) && result.messages.length > 0);
const validRoles = new Set(["system", "user", "assistant", "tool"]);
check("all output roles valid OpenAI", result.messages.every((m) => validRoles.has(m.role)));
check("tool messages keep tool_call_id", result.messages.filter((m) => m.role === "tool").every((m) => typeof m.tool_call_id === "string"));
check("assistant tool_calls intact (3 calls)", result.messages.flatMap((m) => m.tool_calls || []).length === 3);
check("tool_call ids preserved", ["c1", "c2", "c3"].every((id) => result.messages.some((m) => (m.tool_calls || []).some((tc) => tc.id === id))));
check("tool_call arguments still parseable JSON", result.messages.flatMap((m) => m.tool_calls || []).every((tc) => { try { JSON.parse(tc.function.arguments); return true; } catch { return false; } }));
check("final assistant message preserved verbatim", result.messages.at(-1)?.content === "Done. The /health endpoint is in place.");
check("final user request preserved verbatim", result.messages.some((m) => m.role === "user" && m.content === "OK. Now add a health endpoint that returns 200 with status ok."));
check("token accounting consistent", result.tokensAfter <= result.tokensBefore && result.tokensSaved === result.tokensBefore - result.tokensAfter);
if (result.compressed) check("compression actually reduced tokens", result.tokensSaved > 0);

// Use a separate known-unavailable loopback endpoint. This proves SDK rejects
// instead of returning a silent fallback and never touches active Pi proxy.
let unavailableRejected = false;
try {
  const unavailableClient = new HeadroomClient({
    baseUrl: "http://127.0.0.1:1",
    fallback: false,
    timeout: 500,
  });
  await compress([{ role: "user", content: "Failure-policy probe." }], {
    client: unavailableClient,
    model,
  });
} catch (error) {
  unavailableRejected = true;
  console.log(`unavailable-proxy error: ${error instanceof Error ? error.message : String(error)}`);
}
check("unavailable proxy rejects without SDK fallback", unavailableRejected);

console.log(failures === 0 ? "\n== E2E: ALL CHECKS PASSED ==" : `\n== E2E: ${failures} CHECK(S) FAILED ==`);
process.exit(failures === 0 ? 0 : 1);
