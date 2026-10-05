/**
 * Smoke test: the extension module loads with the modernized package names.
 * Proves runtime import resolution for @earendil-works/* + headroom-ai.
 *
 * Run: node --test test/*.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

test("extension module loads and exports a factory", async () => {
  const mod = await jiti.import("../src/index.ts");
  assert.equal(typeof mod.default, "function");
});

test("headroom-ai exports the API the extension uses", async () => {
  const hr = await jiti.import("headroom-ai");
  assert.equal(typeof hr.compress, "function");
  assert.equal(typeof hr.HeadroomClient, "function");
});

test("@earendil-works/pi-coding-agent exports convertToLlm", async () => {
  const pi = await jiti.import("@earendil-works/pi-coding-agent");
  assert.equal(typeof pi.convertToLlm, "function");
});
