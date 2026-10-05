import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });

test("restorePreceptorEnabled: restores latest valid branch state and fails safe", async () => {
  const { PRECEPTOR_ENTRY_TYPE, restorePreceptorEnabled } = await jiti.import("../src/preceptor-mode.ts");

  assert.equal(restorePreceptorEnabled([]), false);
  assert.equal(
    restorePreceptorEnabled([
      { type: "custom", customType: PRECEPTOR_ENTRY_TYPE, data: { enabled: true } },
      { type: "custom", customType: "other-extension", data: { enabled: false } },
      { type: "custom", customType: PRECEPTOR_ENTRY_TYPE, data: { enabled: false } },
    ]),
    false,
  );
  assert.equal(
    restorePreceptorEnabled([
      { type: "custom", customType: PRECEPTOR_ENTRY_TYPE, data: { enabled: false } },
      { type: "custom", customType: PRECEPTOR_ENTRY_TYPE, data: { enabled: true } },
    ]),
    true,
  );
  assert.equal(
    restorePreceptorEnabled([{ type: "custom", customType: PRECEPTOR_ENTRY_TYPE, data: { enabled: "yes" } }]),
    false,
  );
});

test("Preceptor Mode: command persists state and mutates only its prompt section", async () => {
  const commands = new Map();
  const handlers = new Map();
  const entries = [];
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    appendEntry: (customType, data) => entries.push({ customType, data }),
    registerFlag() {},
  };
  const { PRECEPTOR_ENTRY_TYPE, PRECEPTOR_GUIDANCE, PRECEPTOR_PROMPT_SECTION, PRECEPTOR_STATUS_KEY } =
    await jiti.import("../src/preceptor-mode.ts");
  const mod = await jiti.import("../src/index.ts");
  mod.default(pi);

  const statuses = [];
  const notifications = [];
  const previews = [];
  const ctx = {
    hasUI: true,
    getSystemPromptOptions: () => ({ cwd: "/tmp", sections: { tool_guidance: "Keep this section" } }),
    ui: {
      theme: { fg: (_color, value) => value },
      setStatus: (key, value) => statuses.push({ key, value }),
      notify: (message, level) => notifications.push({ message, level }),
      editor: async (title, prefill) => previews.push({ title, prefill }),
    },
  };
  const command = commands.get("wb:preceptor-mode");
  assert.ok(command);

  await command.handler("on", ctx);
  assert.deepEqual(entries, [{ customType: PRECEPTOR_ENTRY_TYPE, data: { enabled: true } }]);
  assert.deepEqual(statuses.at(-1), { key: PRECEPTOR_STATUS_KEY, value: "✓ Learning" });

  const event = { systemPromptOptions: { sections: { tool_guidance: "Keep this section" } } };
  handlers.get("before_agent_start")(event);
  assert.equal(event.systemPromptOptions.sections.tool_guidance, "Keep this section");
  assert.equal(event.systemPromptOptions.sections[PRECEPTOR_PROMPT_SECTION], PRECEPTOR_GUIDANCE);

  await commands.get("wb:show-system-prompt").handler("", ctx);
  assert.equal(previews.length, 1);
  assert.equal(previews[0].title, "System prompt preview (edits discarded)");
  assert.match(previews[0].prefill, /<preceptor_mode>/);
  assert.match(previews[0].prefill, /You are in opt-in Learning mode/);

  await command.handler("off", ctx);
  assert.deepEqual(entries.at(-1), { customType: PRECEPTOR_ENTRY_TYPE, data: { enabled: false } });
  assert.deepEqual(statuses.at(-1), { key: PRECEPTOR_STATUS_KEY, value: undefined });
  handlers.get("before_agent_start")(event);
  assert.equal(event.systemPromptOptions.sections[PRECEPTOR_PROMPT_SECTION], undefined);
  assert.equal(event.systemPromptOptions.sections.tool_guidance, "Keep this section");

  await command.handler("on", ctx);
  await commands.get("wb:study-mode").handler("on", ctx);
  assert.deepEqual(entries.slice(-2), [
    { customType: "pi-workbench-study-mode", data: { enabled: true } },
    { customType: PRECEPTOR_ENTRY_TYPE, data: { enabled: false } },
  ]);

  await command.handler("on", ctx);
  assert.deepEqual(entries.slice(-2), [
    { customType: PRECEPTOR_ENTRY_TYPE, data: { enabled: true } },
    { customType: "pi-workbench-study-mode", data: { enabled: false } },
  ]);

  await command.handler("wat", ctx);
  assert.equal(entries.length, 7);
  assert.deepEqual(notifications.at(-1), { message: "Usage: /wb:preceptor-mode [on|off|status]", level: "error" });
});
