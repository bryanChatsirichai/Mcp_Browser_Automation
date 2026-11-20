// Calls sent to the extension and waiting for their result. Each call settles exactly once:
// by its result frame, by CALL_TIMEOUT_MS, or by its socket closing.

import type { WebSocket } from "ws";
import type { Call, Result, ToolName } from "../../extension/src/protocol.ts";
import { log, shortId } from "../log.ts";

/** Longer than the extension's own 85 s budget, so its more specific timeout message wins. */
const CALL_TIMEOUT_MS = 90_000;

export class ExtensionError extends Error {
  /** Short upper-case id such as NO_EXTENSION or TIMEOUT, shown to the model as `Error <code>`. */
  code: string;
  /** The message came from the browser and may quote page content, so it must be fenced. */
  fromBrowser: boolean;

  constructor(code: string, message: string, fromBrowser: boolean) {
    super(message);
    this.code = code;
    this.fromBrowser = fromBrowser;
  }
}

type Outcome =
  { ok: true; data: unknown } | { ok: false; error: ExtensionError };

interface PendingCall {
  /** The socket the call went to; only it may answer, and its closing fails the call. */
  socket: WebSocket;
  /** Resolves or rejects the promise sendCall returned. Only settleCall invokes it. */
  deliver: (outcome: Outcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Keyed by call id. */
const pendingCalls = new Map<string, PendingCall>();

/** Sends one call on `socket` and resolves with its data, or rejects with an ExtensionError. */
export function sendCall(
  socket: WebSocket,
  id: string,
  tool: ToolName,
  args: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        settleCall(id, {
          ok: false,
          error: new ExtensionError(
            "TIMEOUT",
            `The browser did not answer within ${CALL_TIMEOUT_MS / 1000}s. Its effects may still land; check before retrying.`,
            false,
          ),
        }),
      CALL_TIMEOUT_MS,
    );
    pendingCalls.set(id, {
      socket,
      timer,
      deliver: (outcome) =>
        outcome.ok ? resolve(outcome.data) : reject(outcome.error),
    });

    const call: Call = { type: "call", id, tool, args };
    socket.send(JSON.stringify(call));
  });
}

/**
 * Settles the call a result frame answers. A result is ignored, and logged, when its call already
 * settled (for example after a timeout), is unknown, or was sent on a different socket.
 */
export function settleFromResult(socket: WebSocket, result: Result): void {
  if (pendingCalls.get(result.id)?.socket !== socket) {
    log(
      `[settleFromResult:] call ${shortId(result.id)}: result ignored (already settled, unknown id, or from another socket)`,
    );
    return;
  }
  settleCall(
    result.id,
    result.ok
      ? { ok: true, data: result.data }
      : {
          ok: false,
          error: new ExtensionError(
            result.error.code,
            result.error.message,
            true,
          ),
        },
  );
}

/** Fails at once every call still waiting on a socket that closed, instead of after the timeout. */
export function failCallsOn(socket: WebSocket): void {
  for (const [id, entry] of pendingCalls) {
    if (entry.socket !== socket) {
      continue;
    }
    settleCall(id, {
      ok: false,
      error: new ExtensionError(
        "NO_EXTENSION",
        "Browser disconnected mid-call. Reconnect it from the extension popup, then retry.",
        false,
      ),
    });
  }
}

/** Every path that ends a call goes through here, so a call is answered exactly once. */
function settleCall(id: string, outcome: Outcome): void {
  const entry = pendingCalls.get(id);
  // Already settled by another path: result, timeout or socket close.
  if (!entry) {
    return;
  }
  pendingCalls.delete(id);
  clearTimeout(entry.timer);
  entry.deliver(outcome);
}
