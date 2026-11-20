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
      'List the tabs in the "MCP Browser" tab group, the only tabs the agent may use, with their ids, titles and URLs. ' +
      "The user's other tabs are never listed. Call this first to learn which tab ids exist. " +
      "Returns no tabs and tabGroupId null when there is no group (none opened yet, or the user closed it). " +
      "Tab and group ids change when the group is recreated, so always use ids from the latest result.",
    inputSchema: z.object({
      createIfEmpty: z
        .boolean()
        .optional()
        .describe("Create the tab group with one blank tab when it has none."),
    }),
  },
  {
    name: "tab_open",
    description:
      'Open a new blank tab in the "MCP Browser" tab group. Returns the new tab\'s id and every tab in the group. ' +
      "When there is no group (first use, or the user closed its tabs or window), a new group is created where the user " +
      "chose in the extension popup: their main window, a separate window, or an incognito window. " +
      "A recreated group has a new tabGroupId and holds only the new tab; this is expected, not an error. " +
      "Tabs that are no longer listed were closed by the user: do not reuse their ids.",
    inputSchema: z.object({}),
  },
];
