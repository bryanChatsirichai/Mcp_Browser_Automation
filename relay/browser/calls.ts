// Calls sent to the extension and still waiting for their result.
//
// Every call is finished exactly once, by whichever of these happens first:
//   its result arrives      → finishCallWithResult  (from socket.ts)
//   CALL_TIMEOUT_MS passes  → the timer set in sendCall
//   its socket closes       → failCallsOnSocket     (from socket.ts)
// All three go through finishCall, which removes the call so the others find nothing to do.

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

type CallOutcome =
  { ok: true; data: unknown } | { ok: false; error: ExtensionError };

interface PendingCall {
  /** The socket the call went to; only it may answer, and its closing fails the call. */
  socket: WebSocket;
  /** Fails the call with TIMEOUT after CALL_TIMEOUT_MS. */
  timeoutTimer: ReturnType<typeof setTimeout>;
  /** Resolves or rejects the promise sendCall returned. Only finishCall runs it. */
  finish: (outcome: CallOutcome) => void;
}

/** Calls waiting for a result, keyed by call id. */
const pendingCalls = new Map<string, PendingCall>();

/** Sends one call on `socket`; resolves with its data, or rejects with an ExtensionError. */
export function sendCall(
  socket: WebSocket,
  id: string,
  tool: ToolName,
  args: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeoutTimer = setTimeout(
      () => finishCall(id, { ok: false, error: timeoutError() }),
      CALL_TIMEOUT_MS,
    );
    pendingCalls.set(id, {
      socket,
      timeoutTimer,
      finish: (outcome) =>
        outcome.ok ? resolve(outcome.data) : reject(outcome.error),
    });

    const call: Call = { type: "call", id, tool, args };
    socket.send(JSON.stringify(call));
  });
}

/**
 * Finishes the call a result frame answers. The result is ignored, and logged, when its call
 * already finished (for example after a timeout), is unknown, or was sent on another socket.
 */
export function finishCallWithResult(socket: WebSocket, result: Result): void {
  if (pendingCalls.get(result.id)?.socket !== socket) {
    log(
      `[finishCallWithResult:] call ${shortId(result.id)}: result ignored (already finished, unknown id, or from another socket)`,
    );
    return;
  }
  if (result.ok) {
    finishCall(result.id, { ok: true, data: result.data });
  } else {
    const { code, message } = result.error;
    finishCall(result.id, {
      ok: false,
      error: new ExtensionError(code, message, true),
    });
  }
}

/** Fails at once every call still waiting on a socket that closed, instead of after the timeout. */
export function failCallsOnSocket(socket: WebSocket): void {
  for (const [id, call] of pendingCalls) {
    if (call.socket === socket) {
      finishCall(id, { ok: false, error: disconnectedError() });
    }
  }
}

/** The one place a call ends, so it is answered exactly once. */
function finishCall(id: string, outcome: CallOutcome): void {
  const call = pendingCalls.get(id);
  // Already finished by another path: result, timeout or socket close.
  if (!call) {
    return;
  }
  pendingCalls.delete(id);
  clearTimeout(call.timeoutTimer);
  call.finish(outcome);
}

function timeoutError(): ExtensionError {
  return new ExtensionError(
    "TIMEOUT",
    `The browser did not answer within ${CALL_TIMEOUT_MS / 1000}s. Its effects may still land; check before retrying.`,
    false,
  );
}

function disconnectedError(): ExtensionError {
  return new ExtensionError(
    "NO_EXTENSION",
    "Browser disconnected mid-call. Reconnect it from the extension popup, then retry.",
    false,
  );
}
