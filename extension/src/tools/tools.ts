// The extension half of each tool. relay/mcp/tools.ts holds the name, description and argument
// schema, and validates the arguments before they reach these handlers.

import { addScheme, checkUrl } from "../policy/policy.js";
import { ToolError } from "../shared/errors.js";
import { log } from "../shared/log.js";
import type { NavigateArgs, TabCloseArgs, TabsListArgs, ToolName } from "../shared/protocol.js";
import { loadSettings } from "../shared/settings.js";
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
  const data = await handler(args);
  log(`[flow] browser -> extension: ${tool} done`);
  return data;
}
