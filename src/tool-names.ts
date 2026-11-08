/** The four tools, named once for every user-visible message. */
export const TOOL_NAMES = {
  compression: "Headroom compression",
  memory: "Headroom Memory",
  codeGraph: "Code Graph",
  playwright: "Playwright",
} as const;
export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];
