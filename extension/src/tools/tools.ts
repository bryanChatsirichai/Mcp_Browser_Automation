// The extension half of each tool. relay/mcp/tools.ts holds the name, description and argument
// schema, and validates the arguments before they reach these handlers.

import { ToolError } from "../shared/errors.js";
import type { TabsListArgs, ToolName } from "../shared/protocol.js";
import { ensureGroup, groupTabs, openTab, tabContext } from "./tabs.js";

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
};

/** The single path from a tool name to its handler. */
export async function runTool(
  tool: string,
  args: Record<string, unknown>,
): Promise<object> {
  // Own keys only: a tool named "toString" must not reach Object.prototype.
  const handler = Object.hasOwn(handlers, tool)
    ? handlers[tool as ToolName]
    : undefined;
  if (!handler) {
    throw new ToolError(
      "UNKNOWN_TOOL",
      `This browser does not support the tool "${tool}". Update the extension.`,
    );
  }
  return handler(args);
}
