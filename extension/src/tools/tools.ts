// The extension half of each tool. relay/mcp/tools.ts holds the name, description and argument
// schema, and validates the arguments before they reach these handlers.

import { ToolError } from "../shared/errors.js";
import { log } from "../shared/log.js";
import type { TabCloseArgs, TabsListArgs, ToolName } from "../shared/protocol.js";
import { closeTab, ensureGroup, groupTabs, openTab, tabContext } from "./tabs.js";

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
};

/**
 * Runs the handler whose name matches `tool` and returns its data.
 */
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
  log(`[flow] extension -> browser: ${tool}`);
  const data = await handler(args);
  log(`[flow] browser -> extension: ${tool} done`);
  return data;
}
