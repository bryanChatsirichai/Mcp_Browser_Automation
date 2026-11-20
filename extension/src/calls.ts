// Runs the calls the relay sends, one at a time, and sends back exactly one result for each.
//
// Flow: connection.ts onMessage → enqueueCall → waits its turn → runCall
//         → resultOf → runTool (tools.ts) → result sent on the socket the call came from

import { ToolError, toErrorBody } from "./errors.js";
import type { Call, Result, ToRelay } from "./protocol.js";
import { log, shortId } from "./log.js";
import { runTool } from "./tools.js";

// Nested inside the relay's 90 s call timeout, which is inside the ~100 s idle limit of common
// tunnels, so the innermost limit fires first and the model gets the most specific message.
const CALL_BUDGET_MS = 85_000;

// Calls run one at a time, in arrival order: two concurrent calls could otherwise each find no
// tab group and each create one.
let callQueue: Promise<void> = Promise.resolve();

/** Queues a call from the relay; it runs after every call that arrived before it. */
export function enqueueCall(ws: WebSocket, call: Call): void {
  const receivedAt = Date.now();
  callQueue = callQueue.then(() => runCall(ws, call, receivedAt));
}

/** Runs one call and sends its result on the socket the call came from, if that is still open. */
async function runCall(
  ws: WebSocket,
  call: Call,
  receivedAt: number,
): Promise<void> {
  const tag = `call ${shortId(call.id)} ${call.tool}`;
  log(`[runCall:] ${tag}: start (queued ${Date.now() - receivedAt}ms)`);

  const result = await resultOf(call, receivedAt);

  const elapsed = Date.now() - receivedAt;
  if (ws.readyState !== WebSocket.OPEN) {
    log(`[runCall:] ${tag}: result dropped, socket closed after ${elapsed}ms`);
    return;
  }
  log(
    `[runCall:] ${tag}: ${result.ok ? "ok" : result.error.code} in ${elapsed}ms`,
  );
  const message: ToRelay = result;
  ws.send(JSON.stringify(message));
}

/**
 * Runs the tool within what is left of the call's budget.
 * Never throws: any failure, including running out of time, becomes an error result.
 */
async function resultOf(call: Call, receivedAt: number): Promise<Result> {
  try {
    // The budget counts from arrival, so time spent waiting in the queue is included.
    const timeLeft = receivedAt + CALL_BUDGET_MS - Date.now();
    if (timeLeft <= 0) {
      throw new ToolError(
        "BUSY",
        "The browser was busy with earlier calls. This call was not run; retry it.",
      );
    }
    const work = runTool(call.tool, call.args);
    // A call that loses the race may still fail later; that failure must not go unhandled.
    work.catch(() => undefined);
    const data = await Promise.race([work, timeoutAfter(timeLeft)]);
    return { type: "result", id: call.id, ok: true, data };
  } catch (error) {
    return {
      type: "result",
      id: call.id,
      ok: false,
      error: toErrorBody(error),
    };
  }
}

/** Rejects with a TIMEOUT ToolError after `ms`. */
function timeoutAfter(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(
      () =>
        reject(
          new ToolError(
            "TIMEOUT",
            `The call took longer than ${Math.round(CALL_BUDGET_MS / 1000)}s and was abandoned. Its effects may still land in the page; check before retrying.`,
          ),
        ),
      ms,
    ),
  );
}
