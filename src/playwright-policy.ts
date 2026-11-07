import { assertPlaywrightArtifact, type PlaywrightSession } from "./playwright-config.js";
/** Core + vision from pinned upstream 0.0.84 generated README; server-side unsafe code excluded.
 * Unknown/dynamic tools stay hidden, including page-authored WebMCP additions.
 */
export const PLAYWRIGHT_NORMAL_TOOLS = [
  "browser_click", "browser_close", "browser_console_messages", "browser_drag", "browser_drop", "browser_emulate_media",
  "browser_evaluate", "browser_file_upload", "browser_fill_form", "browser_find", "browser_handle_dialog", "browser_hover",
  "browser_navigate", "browser_navigate_back", "browser_network_request", "browser_network_requests", "browser_press_key",
  "browser_resize", "browser_select_option", "browser_snapshot", "browser_take_screenshot", "browser_type", "browser_wait_for", "browser_tabs",
  "browser_mouse_click_xy", "browser_mouse_down", "browser_mouse_drag_xy", "browser_mouse_move_xy", "browser_mouse_up", "browser_mouse_wheel",
] as const;
export const PLAYWRIGHT_TOOL_EXPOSURE = { "*": "hidden", ...Object.fromEntries(PLAYWRIGHT_NORMAL_TOOLS.map(name => [name, "direct"])), browser_run_code_unsafe: "hidden" } as Record<string, "hidden" | "direct">;
export async function assertPlaywrightToolCall(session: PlaywrightSession, name: string, input: Record<string, unknown>): Promise<void> {
  const local = name.replace(/^mcp__playwright__/, "");
  if (!(PLAYWRIGHT_NORMAL_TOOLS as readonly string[]).includes(local)) throw new Error("Managed Playwright tool blocked by fixed core/vision policy");
  // Canonical absolute path prevents client-root/per-call workspace aliases from
  // changing upstream's resolution after this check. Pi supports in-place input mutation.
  if (Object.hasOwn(input, "filename")) input.filename = await assertPlaywrightArtifact(session, input.filename);
  // Upload paths are deliberately not rewritten or treated as output destinations.
}
