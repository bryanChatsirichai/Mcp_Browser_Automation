// The wire format between relay and extension: JSON text frames over one WebSocket.
// The relay imports this file directly and Node strips its types, so it must stay erasable
// (no enums, no namespaces) and must not touch `chrome`.
//
// Message sequence on one socket:
//   extension → hello            relay → ready        (handshake; relay closes 4401 if no hello in 5 s)
//   extension → ping             relay → pong         (keep-alive; the extension also answers a ping)
//   relay     → call {id,tool}   extension → result {id, ok, data | error}   (one result per call id)

/** Every tool the extension implements. Adding a name here without a handler is a compile error. */
export type ToolName = "tabs_list" | "tab_open";

export interface Hello {
  type: "hello";
  token: string;
  browser: string;
  version: string;
}
export interface Ready {
  type: "ready";
}
export interface Ping {
  type: "ping";
}
export interface Pong {
  type: "pong";
}
export interface Call {
  type: "call";
  id: string;
  tool: ToolName;
  args: Record<string, unknown>;
}

/** `code` is a short upper-case id such as NO_TAB; `message` says what the model should do next. */
export interface ErrorBody {
  code: string;
  message: string;
  [extra: string]: unknown;
}

export type Result =
  | { type: "result"; id: string; ok: true; data: unknown }
  | { type: "result"; id: string; ok: false; error: ErrorBody };

export type ToRelay = Hello | Ping | Pong | Result;
export type ToExtension = Ready | Ping | Pong | Call;

// WebSocket close codes. Both sides branch on them, so they are defined once here.

/** The user pressed Disconnect in the popup. The relay stops auto-starting the browser until a new hello. */
export const CLOSE_BY_USER = 1000;
/** Bad token, or no `hello` in time. The extension must not retry. */
export const CLOSE_UNAUTHORIZED = 4401;
/** Another browser connected and took over the relay. The extension must not retry. */
export const CLOSE_REPLACED = 4409;

export interface TabsListArgs {
  createIfEmpty?: boolean;
}
