/** Harmless Node descendant for owned-process tests; not a browser executable. */
if (process.argv.includes("--ignore-term")) process.on("SIGTERM", () => {});
process.send?.({ type: "synthetic-browser-ready", pid: process.pid });
setInterval(() => {}, 1000);
