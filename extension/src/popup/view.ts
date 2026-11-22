// Text the popup shows. Kept free of DOM and chrome.* so node --test can load it.

import type { ConnectionState } from "../shared/settings.js";

export const STATUS_COPY: Record<
  ConnectionState,
  { title: string; detail: string }
> = {
  disconnected: {
    title: "Disconnected",
    detail: "Start the relay, then press Connect.",
  },
  connecting: {
    title: "Connecting…",
    detail: "Reaching the relay.",
  },
  connected: {
    title: "Connected",
    detail: "Agents can now use this browser through the relay.",
  },
  unreachable: {
    title: "Relay not responding",
    detail:
      "No relay answers at this URL. Start it below, the extension keeps retrying.",
  },
  unauthorized: {
    title: "Refused",
    detail: "The relay refused this browser.",
  },
  replaced: {
    title: "Taken over",
    detail: "Another browser took over the relay. Press Reconnect to take it back.",
  },
};

/** The command that registers the relay's /mcp endpoint with Claude Code, for every project. */
export function claudeCodeCommand(savedUrl: string): string {
  const base = savedUrl.replace(/\/+$/, "");
  return `claude mcp add --scope user --transport http browser ${base}/mcp`;
}
