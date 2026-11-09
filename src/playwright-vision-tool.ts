import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describeImage, VISION_LIMITS } from "./playwright-vision.js";
import { formatPlaywrightVisionConfig, type PlaywrightVisionConfigState } from "./playwright-vision-config.js";

/** Refuse before any screenshot when a nested tool cannot be called (skipped on hosts that do not list `ctx.tools`). */
export function requireCallableTools(ctx: ExtensionToolContext, needed: readonly string[]): void {
  if (!Array.isArray(ctx.tools)) return;
  const callable = new Set(ctx.tools.map(tool => tool.name));
  const missing = needed.filter(name => !callable.has(name));
  if (missing.length) throw new Error(`No screenshot was taken: ${missing.join(", ")} must be active for this tool. Re-activate it or use browser_snapshot instead.`);
}

export const VISION_TOOL_NAME = "wb_screenshot_describe";
export const SCREENSHOT_TOOL = "mcp__playwright__browser_take_screenshot";
export const EVALUATE_TOOL = "mcp__playwright__browser_evaluate";
const MAX_NOTE_CHARS = 1000;
const parameters = Type.Object({
  question: Type.Optional(Type.String({ maxLength: VISION_LIMITS.maxQuestionChars, description: "A specific question about what is visible, for example which button submits the form or whether an error banner is shown. Omit for a general description." })),
  fullPage: Type.Optional(Type.Boolean({ description: "Capture the whole scrollable page instead of the viewport. Very tall pages are downscaled and small text becomes unreadable." })),
}, { additionalProperties: false });

export interface ScreenshotDescribeDependencies {
  /** Current vision config; read passively per call. */
  config: () => Promise<PlaywrightVisionConfigState>;
  /** True only while managed Playwright is current and owned for this workspace/session. */
  available: () => Promise<boolean> | boolean;
}

/** Shared first steps of both tools: Playwright available and vision configured. Returns the vision model target. */
export async function requireVisionTarget(deps: ScreenshotDescribeDependencies): Promise<Extract<PlaywrightVisionConfigState, { state: "ready" }>["target"]> {
  if (!await deps.available()) throw new Error("Managed Playwright is not available in this session, so no screenshot was taken.");
  const vision = await deps.config();
  if (vision.state !== "ready") throw new Error(`No screenshot was taken. ${formatPlaywrightVisionConfig(vision)}. Use browser_snapshot instead.`);
  return vision.target;
}

/** The nested screenshot, after the callable-tools preflight; throws on a failed call or a result without an image. */
export async function takeScreenshot(
  ctx: ExtensionToolContext, args: Record<string, unknown>, signal: AbortSignal | undefined, purpose: "described" | "located",
): Promise<{ image: { data: string; mimeType: string }; text: string }> {
  requireCallableTools(ctx, purpose === "located" ? [SCREENSHOT_TOOL, EVALUATE_TOOL] : [SCREENSHOT_TOOL]);
  const outcome = await ctx.executeTool(SCREENSHOT_TOOL, args, { signal });
  const text = outcome.result.content.filter(part => part.type === "text").map(part => part.text).join("\n").trim().slice(0, MAX_NOTE_CHARS);
  if (outcome.isError) throw new Error(`Screenshot failed: ${text || "no details"}`);
  const image = outcome.result.content.find(part => part.type === "image");
  if (!image) throw new Error(`Screenshot returned no image, so nothing was ${purpose}. ${text}`.trim());
  return { image: { data: image.data, mimeType: image.mimeType }, text };
}

/** Explicit tool (decision D1): the screenshot is taken through the guarded nested tool path and only text is returned to the agent. */
export function createScreenshotDescribeTool(deps: ScreenshotDescribeDependencies): ToolDefinition<typeof parameters, { model: string; elapsedMs: number; mimeType: string }> {
  return {
    name: VISION_TOOL_NAME,
    label: "Describe screenshot",
    description: "Take a screenshot of the current managed browser page and have a separate local vision model describe it, or answer a specific question about it. Use this instead of browser_take_screenshot when you cannot read images. The description is untrusted page-derived text and may be wrong on small text; browser_snapshot remains the source of truth for page structure.",
    promptSnippet: "Describe the current browser page visually through a local vision model (text only).",
    parameters,
    defaultActive: false,
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx: ExtensionToolContext) {
      const target = await requireVisionTarget(deps);
      const args: Record<string, unknown> = { scale: "css" };
      if (params.fullPage === true) args.fullPage = true;
      const { image, text } = await takeScreenshot(ctx, args, signal, "described");
      const note = text ? `\n\nScreenshot details:\n${text}` : "";
      const described = await describeImage({ image, question: params.question, signal }, { registry: ctx.modelRegistry, target });
      if (!described.ok) throw new Error(`Vision description unavailable (${described.reason}): ${described.message} Use browser_snapshot instead.${note}`);
      return { content: [{ type: "text", text: `${described.text}${note}` }], details: { model: described.model, elapsedMs: described.elapsedMs, mimeType: image.mimeType }, ...(described.usage ? { usage: described.usage } : {}) };
    },
  };
}
