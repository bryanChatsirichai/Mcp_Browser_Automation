// Reading a page's content through CDP. checkToolCall has already checked the tab and its URL.
//
// Used by tools.ts:
//   getPageText  the page's readable text, in full (no length limit)

import { sendCdpCommand } from "../cdp/cdp.js";
import { ToolError } from "../shared/errors.js";

// Runs inside the page. Prefers the main content over menus and footers.
const PAGE_TEXT_SCRIPT = `(() => {
  const root = document.querySelector("main, article, [role=main]") || document.body;
  return { url: location.href, title: document.title, text: root ? root.innerText : "" };
})()`;

export interface PageText {
  url: string;
  title: string;
  text: string;
}

/**
 * The page's readable text, with runs of blank lines collapsed. Throws SCRIPT_ERROR if the script
 * fails. Not capped: a very long page can be cut or refused by the MCP client instead.
 */
export async function getPageText(tabId: number): Promise<PageText> {
  const { result, exceptionDetails } = await sendCdpCommand(tabId, "Runtime.evaluate", {
    expression: PAGE_TEXT_SCRIPT,
    returnByValue: true,
  });
  if (exceptionDetails) {
    throw new ToolError("SCRIPT_ERROR", `Could not read the page text: ${exceptionDetails.text}`);
  }
  // The page can tamper with what the script returns, so coerce every field to a string.
  const page = (result.value ?? {}) as Record<string, unknown>;
  return {
    url: String(page.url ?? ""),
    title: String(page.title ?? ""),
    text: String(page.text ?? "").replace(/\n{3,}/g, "\n\n").trim(),
  };
}
