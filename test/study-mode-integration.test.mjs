import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });

test("Study Mode command owns constrained loadout, prompt, skill input, and tool gate", async () => {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const entries = [];
  let activeTools = ["bash", "read", "grep"];
  const pi = {
    on: (name, handler) => {
      handlers.set(name, handler);
      return () => {};
    },
    registerCommand: (name, command) => commands.set(name, command),
    registerTool: (tool) => tools.set(tool.name, tool),
    appendEntry: (customType, data) => entries.push({ customType, data }),
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => { activeTools = [...names]; },
    getCommands: () => [{ name: "skill:ilspycmd", source: "skill", sourceInfo: { path: "/skills/ilspycmd/SKILL.md" } }],
    getAllTools: () => [
      { name: "bash" },
      { name: "read" },
      { name: "grep" },
      { name: "wb_study_fetch", annotations: { readOnlyHint: true } },
      { name: "wb_study_decompile", annotations: { readOnlyHint: true } },
    ],
  };
  const mod = await jiti.import("../src/index.ts");
  mod.default(pi);

  assert.ok(commands.has("wb:study-mode"));
  assert.ok(tools.has("wb_study_fetch"));
  assert.ok(tools.has("wb_study_decompile"));

  const statuses = [];
  const notifications = [];
  const ctx = {
    ui: {
      theme: { fg: (_color, value) => value },
      setStatus: (key, value) => statuses.push({ key, value }),
      notify: (message, level) => notifications.push({ message, level }),
    },
  };

  await commands.get("wb:study-mode").handler("on", ctx);
  assert.deepEqual(entries.at(-1), { customType: "pi-workbench-study-mode", data: { enabled: true, savedToolNames: ["bash", "read", "grep"] } });
  assert.deepEqual(activeTools, ["read", "grep", "wb_study_fetch"]);
  assert.deepEqual(statuses.at(-1), { key: "study", value: "✓ Study" });

  const prompt = { systemPromptOptions: { sections: { unrelated: "keep" } } };
  handlers.get("before_agent_start")(prompt);
  assert.match(prompt.systemPromptOptions.sections.study_mode, /Study Mode/);
  assert.equal(prompt.systemPromptOptions.sections.unrelated, "keep");

  assert.deepEqual(handlers.get("input")({ text: "/skill:other", source: "interactive" }, ctx), { action: "handled" });
  assert.deepEqual(handlers.get("input")({ text: "/skill:ilspycmd", source: "interactive" }, ctx), { action: "handled" });
  assert.deepEqual(handlers.get("tool_call")({ toolName: "bash", input: {} }), { block: true, reason: "Study Mode blocks bash." });
  assert.equal(handlers.get("tool_call")({ toolName: "wb_study_fetch", input: {} }), undefined);

  await commands.get("wb:study-mode").handler("off", ctx);
  assert.deepEqual(entries.at(-1), { customType: "pi-workbench-study-mode", data: { enabled: false } });
  assert.deepEqual(activeTools, ["bash", "read", "grep"]);
  assert.deepEqual(statuses.at(-1), { key: "study", value: undefined });
  handlers.get("before_agent_start")(prompt);
  assert.equal(prompt.systemPromptOptions.sections.study_mode, undefined);
  assert.equal(handlers.get("tool_call")({ toolName: "bash", input: {} }), undefined);
  assert.ok(notifications.some(({ message }) => message.includes("enabled")));
});
