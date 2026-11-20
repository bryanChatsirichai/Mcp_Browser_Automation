// The one connected browser extension: its WebSocket, the hello handshake and keep-alive.
// A newer connection replaces an older one. Results are handed to calls.ts.
//
// Lifecycle of one socket:
//   open → hello within HELLO_TIMEOUT_MS (else close 4401) → ready → ping/pong + results
//   → no frame for IDLE_TIMEOUT_MS: terminate → close: fail its pending calls.
// Frames before hello, binary frames and malformed JSON are ignored.

import type { WebSocket } from "ws";
import {
  CLOSE_BY_USER,
  CLOSE_REPLACED,
  CLOSE_UNAUTHORIZED,
} from "../../extension/src/protocol.ts";
import type { Hello, ToExtension } from "../../extension/src/protocol.ts";
import {
  BROWSER_LAUNCH,
  LAUNCH_WAIT_MS,
  browserWasLaunched,
  notifyExtensionConnected,
  waitForBrowserLaunch,
} from "./launch.ts";
import { ExtensionError, failCallsOn, settleFromResult } from "./calls.ts";
import { parseToRelay } from "../relay-lib.ts";
import { log } from "../log.ts";

const HELLO_TIMEOUT_MS = 5_000;
/** Longer than the extension's 20 s ping interval, so a live extension never hits it. */
const IDLE_TIMEOUT_MS = 60_000;

let activeExtension: WebSocket | null = null;
/** The last extension left by the user pressing Disconnect; starting the browser would not bring it back. */
let disconnectedByUser = false;

/**
 * The connected extension, starting the browser first when that may help.
 * Throws an ExtensionError NO_EXTENSION, worded as the model's next step, when none connects.
 */
export async function requireExtension(): Promise<WebSocket> {
  if (!activeExtension) {
    await waitForBrowserLaunch(!disconnectedByUser);
  }
  if (!activeExtension) {
    throw new ExtensionError("NO_EXTENSION", noBrowserMessage(), false);
  }
  return activeExtension;
}

/** Takes over a WebSocket that passed the local-only gate on /ext. */
export function acceptExtension(ws: WebSocket): void {
  let greeted = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const helloTimer = setTimeout(() => {
    log(
      `[acceptExtension:] socket closed: no hello within ${HELLO_TIMEOUT_MS}ms`,
    );
    ws.close(CLOSE_UNAUTHORIZED, "No hello in time");
  }, HELLO_TIMEOUT_MS);

  const restartIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      log(
        `[acceptExtension:] socket terminated: silent for ${IDLE_TIMEOUT_MS}ms`,
      );
      ws.terminate();
    }, IDLE_TIMEOUT_MS);
  };

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      return;
    }
    const message = parseToRelay(data.toString());
    if (!message) {
      return;
    }

    if (!greeted) {
      if (message.type !== "hello") {
        return;
      }
      greeted = true;
      clearTimeout(helloTimer);
      onHello(ws, message);
      restartIdleTimer();
      return;
    }

    // Any valid frame after hello proves the socket is alive.
    restartIdleTimer();
    if (message.type === "ping") {
      sendTo(ws, { type: "pong" });
    } else if (message.type === "result") {
      settleFromResult(ws, message);
    }
  });

  ws.on("close", (code) => {
    clearTimeout(helloTimer);
    clearTimeout(idleTimer);
    failCallsOn(ws);
    // A replaced or never-greeted socket is not the active one: nothing more to reset.
    if (activeExtension !== ws) {
      return;
    }
    activeExtension = null;
    // The extension closes with CLOSE_BY_USER only when the user presses Disconnect; a quitting
    // browser or a dropped connection closes with another code.
    disconnectedByUser = code === CLOSE_BY_USER;
    log(
      `[acceptExtension:] extension disconnected (code ${code}${disconnectedByUser ? ", by the user" : ""})`,
    );
  });

  ws.on("error", (error) =>
    log(`[acceptExtension:] socket error: ${error.message}`),
  );
}

/** Makes `ws` the active extension, replacing any older one, and ends a launch wait. */
function onHello(ws: WebSocket, hello: Hello): void {
  if (activeExtension && activeExtension !== ws) {
    log(
      "[onHello:] extension replaced: a newer browser connected; closing the old socket",
    );
    activeExtension.close(CLOSE_REPLACED, "Another browser connected");
  }
  activeExtension = ws;
  disconnectedByUser = false;
  sendTo(ws, { type: "ready" });
  log(`[onHello:] extension connected: ${hello.browser} v${hello.version}`);
  notifyExtensionConnected();
}

function noBrowserMessage(): string {
  if (disconnectedByUser) {
    return "The user disconnected the browser from the extension popup. Ask them to open it and press Connect, then retry.";
  }
  if (browserWasLaunched()) {
    return (
      `Started the browser (${BROWSER_LAUNCH}) but its extension did not connect within ${LAUNCH_WAIT_MS / 1000}s. ` +
      "Ask the user to check that the extension is installed in that browser profile and set to Connect."
    );
  }
  return "No browser connected. Ask the user to open the extension popup and press Connect.";
}

function sendTo(ws: WebSocket, message: ToExtension): void {
  ws.send(JSON.stringify(message));
}
