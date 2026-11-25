// Mouse input through CDP, at points in the frame (frame.ts). checkToolCall has already checked
// the tab and its URL.
//
// Used by tools.ts:
//   leftClick  one left click at a frame point

import { sendCdpCommand } from "../cdp/cdp.js";
import { frameOf, toCss } from "./frame.js";

/**
 * One left click at a frame point: a move, a press and a release, the events a real mouse sends.
 * Throws BAD_ARGS for a point outside the frame.
 */
export async function leftClick(tabId: number, [frameX, frameY]: [number, number]): Promise<void> {
  // Measured fresh each call, like captureViewport: scrolling and resizing change the frame.
  const { cssVisualViewport: view } = await sendCdpCommand(tabId, "Page.getLayoutMetrics");
  const { x, y } = toCss(frameOf(view.clientWidth, view.clientHeight), frameX, frameY);
  await sendCdpCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  // buttons is the mask of held buttons (1 = left). Some pages read it instead of button.
  await sendCdpCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await sendCdpCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}
