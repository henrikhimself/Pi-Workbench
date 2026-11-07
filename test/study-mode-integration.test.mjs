import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });

async function studySession(run, initialBranch = []) {
  const home = await mkdtemp(join(tmpdir(), "wb-study-"));
  const { resolveWorkbenchPaths } = await jiti.import("../src/paths.ts");
  const paths = resolveWorkbenchPaths(home);
  const handlers = new Map(), commands = new Map(), statuses = new Map(), notices = [], saved = [];
  let branch = [...initialBranch];
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    appendEntry: (customType, data) => {
      const entry = { type: "custom", customType, data };
      saved.push(entry); branch.push(entry);
    },
    getActiveTools: () => ["bash", "read"],
    registerMcpServer: () => assert.fail("off features must not register MCP"),
    unregisterMcpServer() {},
  };
  const ctx = {
    cwd: home, hasUI: false, sessionManager: { getBranch: () => branch },
    ui: { setStatus: (key, value) => statuses.set(key, value), notify: (message, level) => notices.push({ message, level }) },
  };
  const { default: extension } = await jiti.import("../src/index.ts");
  extension(pi, {
    workbenchPaths: paths,
    proxyManager: {
      resume: () => assert.fail("off compression must not resume"),
      ensureRunning: async () => assert.fail("off compression must not start"),
      healthCheck: async () => assert.fail("off compression must not probe"),
      stop: async () => {}, tryRestart: async () => false,
    },
  });
  try {
    await run({ ctx, paths, handlers, commands, statuses, notices, saved, setBranch: entries => { branch = entries; } });
  } finally {
    await handlers.get("session_shutdown")();
    await rm(home, { recursive: true, force: true });
  }
}

function studyEntry(enabled) {
  return { type: "custom", customType: "pi-workbench-study-mode", data: { enabled } };
}

test("Study footer starts off without a theme and remains visible through idempotent on/off commands", () => studySession(async s => {
  await s.handlers.get("session_start")({}, s.ctx);
  assert.equal(s.statuses.get("study"), "○ Study off");
  const otherStatuses = new Map([
    ["headroom-proxy", "○ Headroom off"],
    ["headroom-memory", "○ Headroom Memory off"],
    ["code-graph", "○ Code Graph off"],
  ]);
  for (const [key, value] of otherStatuses) assert.equal(s.statuses.get(key), value);
  for (const args of ["", "status"]) {
    await s.commands.get("wb:study-mode").handler(args, s.ctx);
    assert.deepEqual(s.notices.at(-1), { message: "Usage: /wb:study-mode [on|off]", level: "error" });
    assert.equal(s.statuses.get("study"), "○ Study off");
    assert.equal(s.saved.length, 0);
  }
  for (const action of ["on", "on", "off", "off"]) {
    await s.commands.get("wb:study-mode").handler(action, s.ctx);
    assert.equal(s.statuses.get("study"), action === "on" ? "✓ Study" : "○ Study off");
    for (const [key, value] of otherStatuses) assert.equal(s.statuses.get(key), value);
  }
  assert.deepEqual(s.saved, [studyEntry(true), studyEntry(false)]);
  assert.equal(existsSync(s.paths.root), false, "footer changes must not prepare backend storage");
}));

test("Study footer and guidance restore branch-local state at startup and after tree navigation", () => studySession(async s => {
  await s.handlers.get("session_start")({}, s.ctx);
  assert.equal(s.statuses.get("study"), "✓ Study");
  assert.equal(s.saved.length, 0, "startup restoration must not append entries");
  const otherStatuses = [...s.statuses].filter(([key]) => key !== "study");
  for (const [branch, enabled] of [
    [[], false],
    [[studyEntry(true), studyEntry(false)], false],
    [[studyEntry(false), studyEntry(true)], true],
    [[studyEntry("invalid")], false],
  ]) {
    s.setBranch(branch);
    await s.handlers.get("session_tree")({ type: "session_tree", newLeafId: null, oldLeafId: "fixture" }, s.ctx);
    assert.equal(s.statuses.get("study"), enabled ? "✓ Study" : "○ Study off");
    const prompt = { systemPromptOptions: { sections: { unrelated: "keep", study_mode: "stale guidance" } } };
    s.handlers.get("before_agent_start")(prompt);
    if (enabled) assert.match(prompt.systemPromptOptions.sections.study_mode, /guidance only/);
    else assert.equal(prompt.systemPromptOptions.sections.study_mode, undefined);
    assert.equal(prompt.systemPromptOptions.sections.unrelated, "keep");
    for (const [key, value] of otherStatuses) assert.equal(s.statuses.get(key), value);
    assert.equal(s.saved.length, 0, "branch navigation must not append or rewrite Study state");
  }
}, [studyEntry(true)]));

test("Study Mode adds guidance without restricting tools, skills, or commands", async () => {
  const handlers = new Map();
  const commands = new Map();
  const entries = [];
  let activeTools = ["bash", "read", "grep"];
  const pi = {
    on: (name, handler) => {
      handlers.set(name, handler);
      return () => {};
    },
    registerCommand: (name, command) => commands.set(name, command),
    appendEntry: (customType, data) => entries.push({ customType, data }),
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => { activeTools = [...names]; },
  };
  const mod = await jiti.import("../src/index.ts");
  mod.default(pi);

  assert.ok(commands.has("wb:study-mode"));
  assert.equal(handlers.has("input"), false, "Study Mode does not block skill input");
  assert.equal(await handlers.get("tool_call")({ toolName: "bash", input: { command: "synthetic-not-executed" } }, {}), undefined, "Study Mode does not block ordinary tools; managed Playwright has its own scoped policy");

  const statuses = [];
  const notifications = [];
  const previews = [];
  const ctx = {
    hasUI: true,
    getSystemPromptOptions: () => ({ cwd: "/tmp", sections: { unrelated: "keep" } }),
    ui: {
      theme: { fg: (_color, value) => value },
      setStatus: (key, value) => statuses.push({ key, value }),
      notify: (message, level) => notifications.push({ message, level }),
      editor: async (title, prefill) => previews.push({ title, prefill }),
    },
  };

  await commands.get("wb:show-system-prompt").handler("", ctx);
  assert.doesNotMatch(previews.at(-1).prefill, /<study_mode>/);
  assert.match(previews.at(-1).prefill, /keep/);

  await commands.get("wb:study-mode").handler("on", ctx);
  assert.deepEqual(entries, [{ customType: "pi-workbench-study-mode", data: { enabled: true } }]);
  assert.deepEqual(notifications.at(-1), {
    message: "Study Mode enabled. Guidance favors explanation and avoiding changes unless requested.",
    level: "info",
  });
  assert.deepEqual(activeTools, ["bash", "read", "grep"], "active tool loadout remains unchanged");
  for (const toolName of ["bash", "read", "grep", "mcp__external__tool"]) assert.equal(await handlers.get("tool_call")({ toolName, input: {} }, ctx), undefined);
  assert.deepEqual(statuses.at(-1), { key: "study", value: "✓ Study" });

  const prompt = { systemPromptOptions: { sections: { unrelated: "keep" } } };
  handlers.get("before_agent_start")(prompt);
  assert.match(prompt.systemPromptOptions.sections.study_mode, /guidance only/);
  assert.equal(prompt.systemPromptOptions.sections.unrelated, "keep");

  await commands.get("wb:show-system-prompt").handler("", ctx);
  assert.equal(previews.at(-1).title, "System prompt preview (edits discarded)");
  assert.match(previews.at(-1).prefill, /<study_mode>/);
  assert.match(previews.at(-1).prefill, /You are in Study Mode/);
  assert.match(previews.at(-1).prefill, /keep/);

  for (const args of ["status", "", "  ", "on extra", "invalid"]) {
    await commands.get("wb:study-mode").handler(args, ctx);
    assert.deepEqual(notifications.at(-1), { message: "Usage: /wb:study-mode [on|off]", level: "error" });
    assert.equal(entries.length, 1, "invalid/bare commands must not change branch state");
    assert.deepEqual(statuses.at(-1), { key: "study", value: "✓ Study" });
  }
  assert.doesNotMatch(commands.get("wb:study-mode").description, /status/);

  await commands.get("wb:study-mode").handler("off", ctx);
  assert.deepEqual(entries, [
    { customType: "pi-workbench-study-mode", data: { enabled: true } },
    { customType: "pi-workbench-study-mode", data: { enabled: false } },
  ]);
  assert.deepEqual(activeTools, ["bash", "read", "grep"]);
  assert.deepEqual(statuses.at(-1), { key: "study", value: "○ Study off" });
  handlers.get("before_agent_start")(prompt);
  assert.equal(prompt.systemPromptOptions.sections.study_mode, undefined);
  assert.equal(prompt.systemPromptOptions.sections.unrelated, "keep");

  await commands.get("wb:show-system-prompt").handler("", ctx);
  assert.doesNotMatch(previews.at(-1).prefill, /<study_mode>/);
  assert.match(previews.at(-1).prefill, /keep/);
});
