/** Narrow owned Playwright launcher. No arbitrary executable/script acceptance. */
import { createJiti } from "jiti";
try {
  const jiti = createJiti(import.meta.url, { fsCache: false });
  const { launchPlaywrightMcp } = await jiti.import("./playwright-launcher.ts");
  await launchPlaywrightMcp(JSON.parse(process.argv[2] ?? "null"));
} catch (error) {
  process.stderr.write(`Managed Playwright launcher failed: ${error instanceof Error ? error.message : "invalid startup"}\n`);
  process.exitCode = 1;
}
