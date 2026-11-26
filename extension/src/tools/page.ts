// Reading a page's content through CDP. checkToolCall has already checked the tab and its URL.
//
// Used by tools.ts:
//   getPageText      the page's readable text, MAX_TEXT characters at a time
//   captureViewport  a JPEG of the visible part of the page, in the frame (frame.ts)

import { sendCdpCommand } from "../cdp/cdp.js";
import { ToolError } from "../shared/errors.js";
import type { ToolImage } from "../shared/protocol.js";
import { frameOf } from "./frame.js";

/** Characters per call. A longer page is read in parts with offset and nextOffset. */
const MAX_TEXT = 50_000;

// Runs inside the page. Prefers the main content over menus and footers.
const PAGE_TEXT_SCRIPT = `(() => {
  const root = document.querySelector("main, article, [role=main]") || document.body;
  return { url: location.href, title: document.title, text: root ? root.innerText : "" };
})()`;

export interface PageText {
  url: string;
  title: string;
  text: string;
  /** Where the next part starts; absent on the last part. */
  nextOffset?: number;
}

/**
 * Up to MAX_TEXT characters of the page's readable text, starting at `offset`, with runs of
 * blank lines collapsed. Each call reads the page again. Throws SCRIPT_ERROR if the script fails.
 */
export async function getPageText(tabId: number, offset = 0): Promise<PageText> {
  const { result, exceptionDetails } = await sendCdpCommand(tabId, "Runtime.evaluate", {
    expression: PAGE_TEXT_SCRIPT,
    returnByValue: true,
  });
  if (exceptionDetails) {
    throw new ToolError("SCRIPT_ERROR", `Could not read the page text: ${exceptionDetails.text}`);
  }
  // The page can tamper with what the script returns, so coerce every field to a string.
  const page = (result.value ?? {}) as Record<string, unknown>;
  const text = String(page.text ?? "").replace(/\n{3,}/g, "\n\n").trim();
  const end = offset + MAX_TEXT;
  return {
    url: String(page.url ?? ""),
    title: String(page.title ?? ""),
    text: text.slice(offset, end),
    nextOffset: end < text.length ? end : undefined,
  };
}

export interface Screenshot {
  /** Sent to the model as an image part, not as JSON text. */
  image: ToolImage;
  /** The image's size: the frame times `scale`. */
  width: number;
  height: number;
  /** The full frame, which coordinates are always given in, whatever the scale. */
  frameWidth: number;
  frameHeight: number;
}

/**
 * A JPEG of the visible part of the page (not the browser window or the screen), at the frame's
 * size times `scale`. Measured fresh each call: scrolling and resizing change it.
 */
export async function captureViewport(tabId: number, scale = 1): Promise<Screenshot> {
  // The visible area in CSS px, and where the page is scrolled to.
  const { cssVisualViewport: view } = await sendCdpCommand(tabId, "Page.getLayoutMetrics");
  const { result } = await sendCdpCommand(tabId, "Runtime.evaluate", {
    expression: "devicePixelRatio",
    returnByValue: true,
  });
  const devicePixelRatio = Number(result.value) || 1;
  // The size the model sees and clicks in: the visible area shrunk to fit MAX_FRAME_EDGE.
  const frame = frameOf(view.clientWidth, view.clientHeight);
  const { data } = await sendCdpCommand(tabId, "Page.captureScreenshot", {
    format: "jpeg",
    quality: 80,
    // Chrome makes the image CSS px x clip scale x devicePixelRatio (measured at a scale
    // factor of 2), so divide by devicePixelRatio or HiDPI screens get double-size images.
    clip: {
      x: view.pageX,
      y: view.pageY,
      width: view.clientWidth,
      height: view.clientHeight,
      scale: (frame.ratio * scale) / devicePixelRatio,
    },
  });
  return {
    image: { data, mimeType: "image/jpeg" },
    width: Math.round(frame.width * scale),
    height: Math.round(frame.height * scale),
    frameWidth: frame.width,
    frameHeight: frame.height,
  };
}
