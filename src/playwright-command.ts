import { offMessage } from "./command-messages.js";
import { TOOL_NAMES } from "./tool-names.js";
import { formatPlaywrightStatus, type PlaywrightManager } from "./playwright-manager.js";
export const PLAYWRIGHT_COMMAND_USAGE = "Usage: /wb:playwright [on|off [--confirm-delete]|status]";
export function parsePlaywrightCommand(raw: string): { action: "on" | "off" | "status"; confirmDelete: boolean } {
  const args = raw.trim() ? raw.trim().split(/\s+/) : [];
  if (!args.length) return { action: "status", confirmDelete: false };
  const [action, ...extra] = args;
  if (action === "on" || action === "status") { if (extra.length) throw new Error(PLAYWRIGHT_COMMAND_USAGE); return { action, confirmDelete: false }; }
  if (action === "off" && (!extra.length || extra.length === 1 && extra[0] === "--confirm-delete")) return { action, confirmDelete: extra.length === 1 };
  throw new Error(PLAYWRIGHT_COMMAND_USAGE);
}
export async function executePlaywrightCommand(raw: string, context: {
  manager: Pick<PlaywrightManager, "on" | "off" | "status">;
  hasUI: boolean;
  confirm?: (title: string, message: string) => Promise<boolean>;
}): Promise<string> {
  const command = parsePlaywrightCommand(raw);
  if (command.action === "on") await context.manager.on();
  if (command.action === "off") {
    const confirmed = context.hasUI
      ? await context.confirm?.("Turn off Playwright and delete workspace data?", "Stops only this session. Deletes this workspace's managed browser artifacts and diagnostics. Active same-workspace peers prevent deletion; shared installation is retained.") ?? false
      : command.confirmDelete;
    if (!confirmed) return context.hasUI ? "Playwright off cancelled; session, intent, and data unchanged." : "Playwright off requires --confirm-delete without interactive UI; nothing changed.";
    await context.manager.off(true);
    return offMessage(TOOL_NAMES.playwright, "deleted");
  }
  return formatPlaywrightStatus(await context.manager.status());
}
