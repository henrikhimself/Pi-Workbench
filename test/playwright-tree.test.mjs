import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { PlaywrightOwnedTree, PLAYWRIGHT_TREE_PULSE_MS, PLAYWRIGHT_TREE_EXE_CACHE_MS } = await jiti.import("../src/playwright-tree.ts");
const scope = () => ({ sessionId: randomUUID(), runtimeId: randomUUID(), browserRoot: "/nonexistent-wb-runtime/browsers" });

// ── M12: the background scan is no longer every 100 ms ──
test("M12: the background scan runs about every 1-2 s, not every 100 ms", t => {
  assert.ok(PLAYWRIGHT_TREE_PULSE_MS >= 1000 && PLAYWRIGHT_TREE_PULSE_MS <= 2000, String(PLAYWRIGHT_TREE_PULSE_MS));
  t.mock.timers.enable({ apis: ["setInterval"] });
  const tree = new PlaywrightOwnedTree(scope()); let scans = 0;
  tree.capture = () => { scans++; return Promise.resolve({ processes: [], uncertain: false }); };
  tree.start(() => {});
  try {
    t.mock.timers.tick(PLAYWRIGHT_TREE_PULSE_MS - 1); assert.equal(scans, 0);
    t.mock.timers.tick(1); assert.equal(scans, 1);
    t.mock.timers.tick(PLAYWRIGHT_TREE_PULSE_MS * 3); assert.equal(scans, 4);
    tree.start(() => {}); t.mock.timers.tick(PLAYWRIGHT_TREE_PULSE_MS); assert.equal(scans, 5, "a second start() does not add a second timer");
  } finally { clearInterval(tree.pulse); }
});

// ── M12: executables known to be outside the runtime are not re-read on every scan ──
test("M12: a process whose executable is outside the browser runtime is not re-read until the cache expires or the pid is new", async () => {
  let clock = 1_000_000; const reads = [];
  const tree = new PlaywrightOwnedTree(scope(), [], undefined, { readExecutable: async pid => { reads.push(pid); return "/usr/bin/unrelated"; }, now: () => clock });
  const first = await tree.capture(); assert.deepEqual(first.processes, [], "nothing outside the runtime is ever owned");
  assert.ok(reads.length > 1, "the first scan looks at the other processes");
  const seen = new Set(reads); reads.length = 0;
  await tree.capture();
  assert.equal(reads.filter(pid => seen.has(pid)).length, 0, "second scan: known non-candidates are skipped");
  clock += PLAYWRIGHT_TREE_EXE_CACHE_MS + 1; reads.length = 0;
  await tree.capture();
  assert.ok(reads.filter(pid => seen.has(pid)).length > 1, "after the cache expires the executables are checked again (an in-place exec cannot hide forever)");
});
test("M12: a cached non-candidate never hides a browser executable inside the runtime", async () => {
  let clock = 5_000_000;
  const exe = new Map(); const tree = new PlaywrightOwnedTree({ ...scope(), browserRoot: "/usr/lib/wb-browsers" }, [], undefined, { readExecutable: async pid => exe.get(pid) ?? "/usr/bin/unrelated", now: () => clock });
  await tree.capture();
  // Every process is cached as outside. A process that later runs a runtime browser binary is only seen once the entry expires;
  // it is then a candidate but, with no private session tags, stays unowned. The scan must still complete without error.
  exe.set(process.pid, "/usr/lib/wb-browsers/chromium/chrome"); clock += PLAYWRIGHT_TREE_EXE_CACHE_MS + 1;
  const snapshot = await tree.capture();
  assert.equal(snapshot.processes.some(row => row.pid === process.pid), false, "untagged candidates are never claimed");
});
