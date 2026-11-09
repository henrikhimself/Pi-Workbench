import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { fsCache: false });
try {
  const { bootstrapPlaywrightMcp } = /** @type {typeof import("./playwright-mcp-bootstrap.js")} */ (await jiti.import("./playwright-mcp-bootstrap.ts"));
  await bootstrapPlaywrightMcp(JSON.parse(process.argv[2] ?? "null"));
} catch {
  process.stderr.write("Managed Playwright MCP bootstrap failed; verify owned runtime/configuration.\n");
  process.exitCode = 1;
}
