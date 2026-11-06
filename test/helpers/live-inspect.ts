/** Read-only inventory for isolated live CLI tests; never installed by Workbench. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function liveInspect(pi: ExtensionAPI): void {
  pi.registerCommand("wb-live-inspect", {
    description: "Read active tool inventory in disposable acceptance process",
    handler: async (_args, ctx) => { ctx.ui.notify(JSON.stringify({ liveActiveTools: pi.getActiveTools() }), "info"); },
  });
}
