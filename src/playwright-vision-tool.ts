import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describeImage, VISION_LIMITS } from "./playwright-vision.js";
import { formatPlaywrightVisionConfig, type PlaywrightVisionConfigState } from "./playwright-vision-config.js";

export const VISION_TOOL_NAME = "wb_screenshot_describe";
export const SCREENSHOT_TOOL = "mcp__playwright__browser_take_screenshot";
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
      if (!await deps.available()) throw new Error("Managed Playwright is not available in this session, so no screenshot was taken.");
      const vision = await deps.config();
      if (vision.state !== "ready") throw new Error(`No screenshot was taken. ${formatPlaywrightVisionConfig(vision)}. Use browser_snapshot instead.`);
      const args: Record<string, unknown> = { scale: "css" };
      if (params.fullPage === true) args.fullPage = true;
      const outcome = await ctx.executeTool(SCREENSHOT_TOOL, args, { signal });
      const text = outcome.result.content.filter(part => part.type === "text").map(part => part.text).join("\n").trim().slice(0, MAX_NOTE_CHARS);
      if (outcome.isError) throw new Error(`Screenshot failed: ${text || "no details"}`);
      const image = outcome.result.content.find(part => part.type === "image");
      if (!image) throw new Error(`Screenshot returned no image, so nothing was described. ${text}`.trim());
      const note = text ? `\n\nScreenshot details:\n${text}` : "";
      const described = await describeImage({ image: { data: image.data, mimeType: image.mimeType }, question: params.question, signal }, { registry: ctx.modelRegistry, target: vision.target });
      if (!described.ok) throw new Error(`Vision description unavailable (${described.reason}): ${described.message} Use browser_snapshot instead.${note}`);
      return { content: [{ type: "text", text: `${described.text}${note}` }], details: { model: described.model, elapsedMs: described.elapsedMs, mimeType: image.mimeType }, ...(described.usage ? { usage: described.usage } : {}) };
    },
  };
}
