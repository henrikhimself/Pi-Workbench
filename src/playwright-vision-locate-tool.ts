import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { cleanLocateTarget, LOCATE_LIMITS, locateInImage } from "./playwright-vision-locate.js";
import { formatPlaywrightVisionConfig } from "./playwright-vision-config.js";
import { SCREENSHOT_TOOL, type ScreenshotDescribeDependencies } from "./playwright-vision-tool.js";

export const LOCATE_TOOL_NAME = "wb_screenshot_locate";
export const CLICK_TOOL = "browser_mouse_click_xy";
const MAX_NOTE_CHARS = 1000;
const parameters = Type.Object({
  target: Type.String({ minLength: 1, maxLength: LOCATE_LIMITS.maxTargetChars, description: "What to find, in visual terms: label, colour, shape and position, for example 'the green Approve button' or 'the magnifier icon at the top right of the header'." }),
}, { additionalProperties: false });

/** Locates one element visually and returns a viewport point. It never clicks: the agent decides whether to call browser_mouse_click_xy. */
export function createScreenshotLocateTool(deps: ScreenshotDescribeDependencies): ToolDefinition<typeof parameters, { model: string; elapsedMs: number; x: number; y: number }> {
  return {
    name: LOCATE_TOOL_NAME,
    label: "Locate on screenshot",
    description: "Take a viewport screenshot of the current managed browser page and have a separate local vision model estimate where a described element is. Returns viewport pixel coordinates only; it does not click. Use it when browser_snapshot has no usable reference for the element (canvas, unlabeled icons, custom widgets), then call browser_mouse_click_xy with the returned x and y. The estimate can be wrong, so check the result afterwards with browser_snapshot.",
    promptSnippet: "Find where a visually described element is on the page and return click coordinates (no click).",
    parameters,
    defaultActive: false,
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx: ExtensionToolContext) {
      if (!await deps.available()) throw new Error("Managed Playwright is not available in this session, so no screenshot was taken.");
      const vision = await deps.config();
      if (vision.state !== "ready") throw new Error(`No screenshot was taken. ${formatPlaywrightVisionConfig(vision)}. Use browser_snapshot instead.`);
      const target = cleanLocateTarget(params.target);
      if (!target) throw new Error("No screenshot was taken: target description is empty.");
      const outcome = await ctx.executeTool(SCREENSHOT_TOOL, { scale: "css" }, { signal });
      const text = outcome.result.content.filter(part => part.type === "text").map(part => part.text).join("\n").trim().slice(0, MAX_NOTE_CHARS);
      if (outcome.isError) throw new Error(`Screenshot failed: ${text || "no details"}`);
      const image = outcome.result.content.find(part => part.type === "image");
      if (!image) throw new Error(`Screenshot returned no image, so nothing was located. ${text}`.trim());
      const found = await locateInImage({ image: { data: image.data, mimeType: image.mimeType }, target, signal }, { registry: ctx.modelRegistry, target: vision.target });
      if (!found.ok) throw new Error(`Could not locate the element (${found.reason}): ${found.message} Use browser_snapshot instead.`);
      const { box, point, size } = found;
      const answer = `Located ${JSON.stringify(target)} by a vision model estimate (not verified): click point x=${point.x}, y=${point.y} in viewport CSS pixels; estimated box (${box.x1},${box.y1})-(${box.x2},${box.y2}) in a ${size.width}x${size.height} viewport. ` +
        `To click it, call ${CLICK_TOOL} with x=${point.x} and y=${point.y}. Nothing was clicked. Afterwards confirm the outcome with browser_snapshot.`;
      return { content: [{ type: "text", text: answer }], details: { model: found.model, elapsedMs: found.elapsedMs, x: point.x, y: point.y } };
    },
  };
}
