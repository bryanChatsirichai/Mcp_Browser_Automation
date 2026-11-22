// MCP tool definitions. Definitions only: the logic lives in the extension (extension/src/tools/tools.ts).
// Each Zod schema is both the JSON Schema served by tools/list and the validator the SDK runs
// on every call, so a malformed call is rejected here instead of reaching the browser.

import * as z from "zod";
import type { ToolName } from "../../extension/src/shared/protocol.ts";

export interface ToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: z.ZodObject;
}

export const TOOLS: ToolDefinition[] = [
  {
    name: "tabs_list",
    description:
      'List the tabs you can use: those in the "MCP Browser" tab group. The user\'s other tabs are never listed. ' +
      "Call this first, and again whenever you are unsure which tabs exist. " +
      "Returns { availableTabs: [{ tabId, title, url }], tabGroupId }; titles and URLs may be cut short. " +
      "With no group (none opened yet, or the user closed it), availableTabs is empty and tabGroupId is null. " +
      "A tab missing from the list was closed by the user: do not use its id again.",
    inputSchema: z.object({
      createIfEmpty: z
        .boolean()
        .optional()
        .describe("When there is no group, create one with a blank tab instead of returning an empty list."),
    }),
  },
  {
    name: "tab_open",
    description:
      'Open a new blank tab in the "MCP Browser" tab group, creating the group if there is none. ' +
      "Returns { tabId, availableTabs, tabGroupId }, where tabId is the new tab. " +
      "If the user closed the group, a new group is created with a new tabGroupId and only the new tab: " +
      "this is expected, not an error.",
    inputSchema: z.object({}),
  },
  {
    name: "tab_close",
    description:
      'Close one tab in the "MCP Browser" tab group. Returns { closedTabId, availableTabs, tabGroupId }. ' +
      "Fails with NOT_IN_GROUP for any tab outside the group, including the user's own tabs and tabs already closed. " +
      "Closing the last tab removes the group; tab_open creates a new one.",
    inputSchema: z.object({
      tabId: z.number().int().describe("Id of the tab to close, from availableTabs."),
    }),
  },
  {
    name: "navigate",
    description:
      'Load a URL in a tab of the "MCP Browser" tab group and wait up to 30 seconds for it to finish loading. ' +
      "A URL without a scheme gets https:// (http:// for localhost). Only http and https URLs are allowed; " +
      "any other fails with BLOCKED. Without tabId, the group's first tab is used, creating the group if there is none. " +
      "Returns { tabId, url, stillLoading, availableTabs, tabGroupId }, where url is the final URL after redirects. " +
      "Fails with NOT_IN_GROUP for any tab outside the group.",
    inputSchema: z.object({
      url: z.string().min(1).describe("The URL to load, such as https://example.com or example.com."),
      tabId: z
        .number()
        .int()
        .optional()
        .describe("Id of the tab to navigate, from availableTabs. Defaults to the group's first tab."),
    }),
  },
];
