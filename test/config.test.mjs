import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { DEFAULT_HEADROOM_PORT, parseHeadroomPort } = await jiti.import("../src/config.ts");

test("parseHeadroomPort: uses default when omitted", () => {
  assert.equal(DEFAULT_HEADROOM_PORT, 8787);
  assert.equal(parseHeadroomPort(undefined), 8787);
});

test("parseHeadroomPort: accepts in-range JSON numbers", () => {
  for (const value of [1, 8787, 65535]) {
    assert.equal(parseHeadroomPort(value), value);
  }
});

test("parseHeadroomPort: rejects non-integer and out-of-range JSON values", () => {
  for (const value of [0, -1, 65536, "8787", 1.5, null]) {
    assert.throws(
      () => parseHeadroomPort(value),
      new RegExp(`headroom\\.json port must be an integer from 1 to 65535; received ${JSON.stringify(value)}\\.`),
    );
  }
});
