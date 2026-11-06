/** Compatibility entry point: only explicit, isolated managed-runtime acceptance. */
if (process.env.WORKBENCH_RUNTIME_TESTS !== "1") throw new Error("Set WORKBENCH_RUNTIME_TESTS=1; E2E uses disposable owned roots, never current user proxy/config");
await import("./runtime-headroom.mjs");
