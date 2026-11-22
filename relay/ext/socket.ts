// The relay's connection to the browser extension: one WebSocket at a time, and the newest wins.
//
// Lifecycle of one socket (acceptExtension):
//   connects → must say hello within HELLO_TIMEOUT_MS, else closed with 4401 (closeForNoHello)
//   → hello: it becomes connectedExtension and the relay answers ready (onHello)
//   → then ping/pong and call results; silent for EXTENSION_SILENCE_LIMIT_MS: dropped (resetSilenceTimer)
//   → closes: its pending calls fail at once (onExtensionSocketClosed → calls.ts failCallsOnSocket)
// Frames before hello, binary frames and malformed JSON are ignored.

import type { RawData, WebSocket } from "ws";
import {
  CLOSE_BY_USER,
  CLOSE_REPLACED,
  CLOSE_UNAUTHORIZED,
} from "../../extension/src/shared/protocol.ts";
import type { Hello, ToExtension } from "../../extension/src/shared/protocol.ts";
import {
  BROWSER_LAUNCH,
  LAUNCH_WAIT_MS,
  browserWasLaunched,
  launchBrowserAndWait,
  onExtensionConnected,
} from "../browser/launch.ts";
import {
  ExtensionError,
  failCallsOnSocket,
  finishCallWithResult,
} from "./calls.ts";
import { parseToRelay } from "../relay-lib.ts";
import { log } from "../log.ts";

const HELLO_TIMEOUT_MS = 5_000;
/** Longer than the extension's 20 s ping interval, so a live extension never hits it. */
const EXTENSION_SILENCE_LIMIT_MS = 60_000;

/** The extension that said hello and is still connected; null when there is none. */
let connectedExtension: WebSocket | null = null;
/**
 * True when the last extension left because the user pressed Disconnect in its popup. Starting
 * the browser would not bring it back, so no launch is tried. The next hello resets it.
 */
let userPressedDisconnect = false;

/**
 * The connected extension, starting the browser first when that may help.
 * Throws ExtensionError NO_EXTENSION, worded as the model's next step, when none connects.
 */
export async function requireExtension(): Promise<WebSocket> {
  log("[requireExtension:] checking for a connected extension");
  if (!connectedExtension) {
    log("[requireExtension:] no extension connected, starting the browser if allowed");
    await startBrowserIfAllowed();
  }
  if (!connectedExtension) {
    log("[requireExtension:] still no extension connected; throwing NO_EXTENSION");
    throw new ExtensionError("NO_EXTENSION", whyNoExtension(), false);
  }
  log("[requireExtension:] returning the connected extension");
  return connectedExtension;
}

/** Takes over a WebSocket that passed the local-only gate on /ext. */
export function acceptExtension(webSocket: WebSocket): void {
  let saidHello = false;
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;
  const helloTimer = setTimeout(closeForNoHello, HELLO_TIMEOUT_MS);

  webSocket.on("message", onExtensionMessage);
  webSocket.on("close", onExtensionSocketClosed);
  webSocket.on("error", (error) =>
    log(`[acceptExtension:] socket error: ${error.message}`),
  );

  /** Handles a message from the extension: hello first, then ping and call results. */
  function onExtensionMessage(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      return;
    }
    const message = parseToRelay(data.toString());
    if (!message) {
      return;
    }

    if (!saidHello) {
      // Until hello, every other frame is dropped.
      if (message.type !== "hello") {
        return;
      }
      saidHello = true;
      clearTimeout(helloTimer);
      onHello(webSocket, message);
      resetSilenceTimer();
      return;
    }

    // Any valid frame after hello proves the socket is alive.
    resetSilenceTimer();
    if (message.type === "ping") {
      send(webSocket, { type: "pong" });
    } else if (message.type === "result") {
      finishCallWithResult(webSocket  , message);
    }
  }

  /** Fails this socket's pending calls; clears connectedExtension if it was the connected one. */
  function onExtensionSocketClosed(code: number): void {
    clearTimeout(helloTimer);
    clearTimeout(silenceTimer);
    failCallsOnSocket(webSocket);
    // A replaced or never-greeted socket is not the connected one: nothing more to reset.
    if (connectedExtension !== webSocket) {
      return;
    }
    connectedExtension = null;
    // The extension closes with CLOSE_BY_USER only when the user presses Disconnect; a quitting
    // browser or a dropped connection closes with another code.
    userPressedDisconnect = code === CLOSE_BY_USER;
    log(
      `[onExtensionSocketClosed:] extension disconnected (code ${code}${userPressedDisconnect ? ", by the user" : ""})`,
    );
  }

  function closeForNoHello(): void {
    log(`[closeForNoHello:] no hello within ${HELLO_TIMEOUT_MS}ms; closing`);
    webSocket.close(CLOSE_UNAUTHORIZED, "No hello in time");
  }

  /** Restarts the countdown that drops an extension that has gone silent. */
  function resetSilenceTimer(): void {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      log(
        `[resetSilenceTimer:] silent for ${EXTENSION_SILENCE_LIMIT_MS}ms; dropping`,
      );
      webSocket.terminate();
    }, EXTENSION_SILENCE_LIMIT_MS);
  }
}

/** Makes `webSocket` the connected extension, replacing any older one, and ends a launch wait. */
function onHello(webSocket: WebSocket, hello: Hello): void {
  if (connectedExtension && connectedExtension !== webSocket  ) {
    log(
      "[onHello:] extension replaced: a newer browser connected; closing the old socket",
    );
    connectedExtension.close(CLOSE_REPLACED, "Another browser connected");
  }
  connectedExtension = webSocket;
  userPressedDisconnect = false;
  send(webSocket, { type: "ready" });
  log(`[onHello:] extension connected: ${hello.browser} v${hello.version}`);
  onExtensionConnected();
}

/** Starts the browser and waits for its extension, unless the user pressed Disconnect. */
async function startBrowserIfAllowed(): Promise<void> {
  log("[startBrowserIfAllowed:] checking if the browser may be started");
  if (userPressedDisconnect) {
    log(
      "[startBrowserIfAllowed:] not starting the browser: the user pressed Disconnect",
    );
    return;
  }
  log("[startBrowserIfAllowed:] starting the browser and waiting for its extension");
  await launchBrowserAndWait();
}

/** Why there is no extension, phrased as the model's next step. */
function whyNoExtension(): string {
  if (userPressedDisconnect) {
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

function send(webSocket: WebSocket, message: ToExtension): void {
  webSocket.send(JSON.stringify(message));
}
