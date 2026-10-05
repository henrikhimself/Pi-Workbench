import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });

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
  assert.equal(handlers.has("tool_call"), false, "Study Mode does not block tools");

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
  assert.deepEqual(entries.at(-1), { customType: "pi-workbench-study-mode", data: { enabled: true } });
  assert.deepEqual(activeTools, ["bash", "read", "grep"], "active tool loadout remains unchanged");
  assert.deepEqual(statuses.at(-1), { key: "study", value: "✓ Study" });

  const prompt = { systemPromptOptions: { sections: { unrelated: "keep" } } };
  handlers.get("before_agent_start")(prompt);
  assert.match(prompt.systemPromptOptions.sections.study_mode, /guidance only/);
  assert.equal(prompt.systemPromptOptions.sections.unrelated, "keep");

  await commands.get("wb:study-mode").handler("status", ctx);
  assert.match(notifications.at(-1).message, /tools and commands remain available/);

  await commands.get("wb:study-mode").handler("off", ctx);
  assert.deepEqual(entries.at(-1), { customType: "pi-workbench-study-mode", data: { enabled: false } });
  assert.deepEqual(activeTools, ["bash", "read", "grep"]);
  assert.deepEqual(statuses.at(-1), { key: "study", value: undefined });
  handlers.get("before_agent_start")(prompt);
  assert.equal(prompt.systemPromptOptions.sections.study_mode, undefined);
});
