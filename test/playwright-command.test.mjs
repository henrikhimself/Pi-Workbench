import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { parsePlaywrightCommand, executePlaywrightCommand } = await jiti.import("../src/playwright-command.ts");
function context(hasUI = false, confirm = async () => false) {
  const calls = [];
  return { calls, hasUI, confirm, manager: { on: async () => calls.push("on"), off: async value => calls.push(["off", value]), status: async () => { calls.push("status"); return { dataPresent: true, intent: "off", registered: false, currentRegistration: false, ownedChild: false, tools: [], selected: null, workspace: "/synthetic", directory: "/private", session: null, consumers: 0, failures: [] }; } } };
}
test("Playwright command defaults to read-only status and rejects extra arguments", async () => {
  const ctx = context(); await executePlaywrightCommand("", ctx); assert.deepEqual(ctx.calls, ["status"]);
  for (const input of ["on extra", "status extra", "off extra", "off --confirm-delete extra", "wat", "on --confirm-delete"]) assert.throws(() => parsePlaywrightCommand(input), /Usage:/);
});
test("Playwright noninteractive off never confirms implicitly", async () => {
  const ctx = context(); assert.match(await executePlaywrightCommand("off", ctx), /requires --confirm-delete/); assert.deepEqual(ctx.calls, ["status"]);
  assert.equal(await executePlaywrightCommand("off --confirm-delete", ctx), "Playwright data deleted for this project"); assert.deepEqual(ctx.calls, ["status", "status", ["off", true]]);
});
test("Playwright interactive refusal preserves session", async () => {
  let questions = 0; const ctx = context(true, async () => { questions++; return false; });
  assert.match(await executePlaywrightCommand("off", ctx), /cancelled/); assert.equal(questions, 1); assert.deepEqual(ctx.calls, ["status"]);
});
test("Playwright --confirm-delete replaces the interactive prompt", async () => {
  let questions = 0; const ctx = context(true, async () => { questions++; return false; });
  assert.equal(await executePlaywrightCommand("off --confirm-delete", ctx), "Playwright data deleted for this project");
  assert.equal(questions, 0); assert.deepEqual(ctx.calls.at(-1), ["off", true]);
});
test("Playwright off without project data reports already off", async () => {
  for (const hasUI of [true, false]) for (const input of ["off", "off --confirm-delete"]) {
    let questions = 0; const ctx = context(hasUI, async () => { questions++; return true; });
    const status = ctx.manager.status; ctx.manager.status = async () => ({ ...(await status()), dataPresent: false });
    assert.equal(await executePlaywrightCommand(input, ctx), "Playwright already off for this project");
    assert.equal(questions, 0); assert.deepEqual(ctx.calls, ["status"]);
  }
});
test("Playwright interactive approval invokes confirmed off once", async () => {
  const ctx = context(true, async () => true); await executePlaywrightCommand("off", ctx); assert.deepEqual(ctx.calls, ["status", ["off", true]]);
});
test("Playwright on reports registration/evidence without claiming browser is open", async () => {
  const ctx = context(); const message = await executePlaywrightCommand("on", ctx); assert.deepEqual(ctx.calls, ["on", "status"]); assert.match(message, /does not launch a browser or prove one is open/);
});
