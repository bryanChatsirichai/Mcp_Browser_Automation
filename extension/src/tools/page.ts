// Reading a page's content through CDP. checkToolCall has already checked the tab and its URL.
//
// Used by tools.ts:
//   getPageText  the page's readable text, MAX_TEXT characters at a time

import { sendCdpCommand } from "../cdp/cdp.js";
import { ToolError } from "../shared/errors.js";

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
