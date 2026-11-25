// The extension half of each tool. relay/mcp/tools.ts holds the name, description and argument
// schema, and validates the arguments before they reach these handlers.

import { addScheme, checkUrl } from "../policy/policy.js";
import { ToolError } from "../shared/errors.js";
import { log } from "../shared/log.js";
import type {
  ComputerArgs,
  GetPageTextArgs,
  NavigateArgs,
  TabCloseArgs,
  TabsListArgs,
  ToolName,
} from "../shared/protocol.js";
import { loadSettings } from "../shared/settings.js";
import { leftClick, pressKeys, typeText } from "./input.js";
import { captureViewport, getPageText } from "./page.js";
import {
  checkInGroup,
  closeTab,
  ensureGroup,
  groupTabs,
  navigateTab,
  openTab,
  tabContext,
} from "./tabs.js";

/** Returns plain data; the relay turns it into JSON text for the model. */
type Handler = (args: Record<string, unknown>) => Promise<object>;

const handlers: Record<ToolName, Handler> = {
  async tabs_list(args) {
    const { createIfEmpty } = args as TabsListArgs;
    return tabContext(createIfEmpty ? await ensureGroup() : await groupTabs());
  },

  async tab_open() {
    const tab = await openTab();
    return { tabId: tab.id, ...(await tabContext(await groupTabs())) };
  },

  async tab_close(args) {
    const { tabId } = args as unknown as TabCloseArgs;
    await closeTab(tabId);
    return { closedTabId: tabId, ...(await tabContext(await groupTabs())) };
  },

  async navigate(args) {
    const { url, tabId } = args as unknown as NavigateArgs;
    // Defaults to the group's first tab; the returned tabId tells the model which one.
    const id = tabId ?? (await ensureGroup())[0].id!;
    const { tab, stillLoading } = await navigateTab(id, addScheme(url));
    return {
      tabId: id,
      url: tab.url ?? tab.pendingUrl ?? "",
      stillLoading,
      ...(await tabContext(await groupTabs())),
    };
  },

  async get_page_text(args) {
    const { tabId, offset } = args as unknown as GetPageTextArgs;
    return { tabId, ...(await getPageText(tabId, offset)) };
  },

  async computer(args) {
    const { action, tabId, scale, duration, coordinate, text, submitKey, keys } =
      args as unknown as ComputerArgs;
    // The relay's schema cannot make an argument required for one action alone, so the
    // per-action arguments are checked here.
    if (action === "left_click") {
      if (coordinate === undefined) {
        throw new ToolError("BAD_ARGS", "left_click needs coordinate: [x, y] in the full frame.");
      }
      await leftClick(tabId, coordinate);
      return { tabId };
    }
    if (action === "wait") {
      if (duration === undefined) {
        throw new ToolError("BAD_ARGS", "wait needs duration: the seconds to pause, up to 10.");
      }
      await new Promise((resolve) => setTimeout(resolve, duration * 1000));
      return { tabId };
    }
    if (action === "type_text") {
      if (text === undefined) {
        throw new ToolError("BAD_ARGS", "type_text needs text: the text to type where the cursor is.");
      }
      await typeText(tabId, text, submitKey);
      return { tabId };
    }
    if (action === "press_key") {
      if (keys === undefined) {
        throw new ToolError("BAD_ARGS", 'press_key needs keys, such as "Enter" or "ctrl+a".');
      }
      await pressKeys(tabId, keys);
      return { tabId };
    }
    return { tabId, ...(await captureViewport(tabId, scale)) };
  },
};

/**
 * The per-call guard run before every handler: refuses a tab outside the
 * group (NOT_IN_GROUP) and a URL the site policy blocks (BLOCKED), either the URL navigate
 * loads or the page the tab is on now.
 */
async function checkToolCall(tool: ToolName, args: Record<string, unknown>): Promise<void> {
  const settings = await loadSettings();

  // navigate: check where the tab is going. It names the URL, so it can be checked before loading.
  if (tool === "navigate") {
    checkUrl(addScheme(String(args.url)), settings);
  }

  if (typeof args.tabId !== "number") {
    return;
  }
  const tab = await checkInGroup(args.tabId);

  // Every other tool: check where the tab is now. Pages redirect and links get clicked, so the
  // live URL is re-checked on every call. tab_close skips it, so the agent can always close its tab.
  if (tool !== "navigate" && tool !== "tab_close") {
    checkUrl(tab.url ?? tab.pendingUrl ?? "", settings);
  }
}

/** Runs the handler whose name matches `tool`, after checkToolCall, and returns its data. */
export async function runTool(
  tool: string,
  args: Record<string, unknown>,
): Promise<object> {
  const handler = Object.hasOwn(handlers, tool)
    ? handlers[tool as ToolName]
    : undefined;
  if (!handler) {
    throw new ToolError(
      "UNKNOWN_TOOL",
      `This browser does not support the tool "${tool}". Update the extension.`,
    );
  }
  await checkToolCall(tool as ToolName, args);
  log(`[flow] extension -> browser: ${tool}`);
  // Runs the tool found above
  const data = await handler(args);
  log(`[flow] browser -> extension: ${tool} done`);
  return data;
}
