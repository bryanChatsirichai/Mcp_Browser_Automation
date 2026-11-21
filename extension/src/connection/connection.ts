// The extension's WebSocket to the relay: connecting, the hello/ready handshake, keep-alive,
// and reconnecting with backoff.
//
// Chrome stops an idle service worker after about 30 seconds and every variable here is lost, so
// state that must survive lives in chrome.storage, and a cold start reconnects by itself.
//
// Lifecycle of one connection:
//   connect → socket opens: send hello, start pinging (onOpen)
//     → relay answers ready: connected, retry delay reset (onMessage → onReady)
//     → calls arrive: handed to calls.ts (onMessage → enqueueCall)
//     → closes, or is dropped when the relay goes silent (handleClose)
//         4401 refused / 4409 replaced: stop, the user must act; otherwise scheduleRetry
//   disconnect: closed on purpose after a settings change, with no retry.

import {
  CLOSE_BY_USER,
  CLOSE_REPLACED,
  CLOSE_UNAUTHORIZED,
} from "../shared/protocol.js";
import type { Call, ToExtension, ToRelay } from "../shared/protocol.js";
import { enqueueCall } from "./calls.js";
import { log } from "../shared/log.js";
import { loadSettings, loadStatus, saveStatus } from "../shared/settings.js";
import type { Settings } from "../shared/settings.js";

/** How long the relay has to answer hello with ready. */
const READY_TIMEOUT_MS = 8_000;
const PING_INTERVAL_MS = 20_000;
/** No frame from the relay for this long means it is gone, even if the socket still looks open. */
const SILENCE_LIMIT_MS = 30_000;
const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
/** The close code for a connection that ended without a closing handshake. */
const ABNORMAL_CLOSURE = 1006;

/** The socket to the relay, open or still opening; null when there is none. */
let relaySocket: WebSocket | null = null;
/** Wait before the next reconnect attempt. Doubles after each failure, up to MAX_RETRY_MS. */
let retryDelay = FIRST_RETRY_MS;
/** When the relay last sent anything (ms since epoch). The ping timer checks it. */
let lastHeardAt = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let readyTimer: ReturnType<typeof setTimeout> | undefined;
let pingTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Connects unless the last close needs the user to act first (refused or replaced).
 * Safe to call often: connect does nothing when a socket exists or the user chose to be
 * disconnected.
 */
export async function reconnectIfAllowed(): Promise<void> {
  const { state } = await loadStatus();
  if (state === "unauthorized" || state === "replaced") {
    return;
  }
  await connect();
}

/**
 * Applies new connection settings: closes the current socket and, when the user still wants to
 * be connected, opens a new one with the new settings.
 */
export async function restartWithNewSettings(): Promise<void> {
  disconnect();
  retryDelay = FIRST_RETRY_MS;
  const settings = await loadSettings();
  if (!settings.enabled) {
    await saveStatus({ state: "disconnected" });
    return;
  }
  await saveStatus({ state: "connecting" });
  await connect();
}

async function connect(): Promise<void> {
  const settings = await loadSettings();
  // Checked after the await, and the socket is stored with no await in between, so two
  // concurrent calls (the alarm and a start-up resume) cannot open two sockets.
  if (!settings.enabled || relaySocket) {
    return;
  }

  let url: string;
  try {
    url = socketUrl(settings.url);
  } catch {
    await saveStatus({
      state: "unreachable",
      detail: `Invalid relay URL: ${settings.url}`,
    });
    return;
  }

  const webSocket = new WebSocket(url);
  relaySocket = webSocket;
  log(`[connect:] connecting to ${url}`);
  // During automatic retries keep showing "unreachable", or the popup flickers.
  if ((await loadStatus()).state !== "unreachable") {
    await saveStatus({ state: "connecting" });
  }

  readyTimer = setTimeout(() => {
    log(`[connect:] no ready within ${READY_TIMEOUT_MS}ms; dropping`);
    dropConnection(webSocket);
  }, READY_TIMEOUT_MS);
  webSocket.onopen = () => onOpen(webSocket, settings);
  webSocket.onmessage = (event) => onMessage(webSocket, settings, event.data);
  webSocket.onclose = (event) => void handleClose(webSocket, event.code);
}

/** Says hello and starts the keep-alive. */
function onOpen(webSocket: WebSocket, settings: Settings): void {
  lastHeardAt = Date.now();
  send(webSocket, {
    type: "hello",
    token: settings.token,
    browser: browserName(),
    version: chrome.runtime.getManifest().version,
  });
  pingTimer = setInterval(() => pingOrDrop(webSocket), PING_INTERVAL_MS);
}

function onMessage(
  webSocket: WebSocket,
  settings: Settings,
  data: unknown,
): void {
  lastHeardAt = Date.now();
  const message = parseToExtension(data);
  if (message?.type === "ready") {
    onReady(settings);
  } else if (message?.type === "ping") {
    send(webSocket, { type: "pong" });
  } else if (message?.type === "call") {
    enqueueCall(webSocket, message);
  }
}

/** The relay accepted the hello: the connection is up. */
function onReady(settings: Settings): void {
  clearTimeout(readyTimer);
  retryDelay = FIRST_RETRY_MS;
  log("[onReady:] connected");
  void saveStatus({ state: "connected", detail: settings.url });
}

/** Pings the relay, or drops the connection when the relay has been silent too long. */
function pingOrDrop(webSocket: WebSocket): void {
  log("[pingOrDrop:] checking relay silence");
  const silentFor = Date.now() - lastHeardAt;
  if (silentFor > SILENCE_LIMIT_MS) {
    log(`[pingOrDrop:] relay silent for ${silentFor}ms; dropping`);
    dropConnection(webSocket);
  } else {
    log(`[pingOrDrop:] relay heard within ${silentFor}ms`);
    send(webSocket, { type: "ping" });
  }
}

/**
 * Closes the socket and runs the close handling at once. A relay that died never completes
 * the closing handshake, so the socket's own close event could arrive much later.
 */
function dropConnection(webSocket: WebSocket): void {
  webSocket.onclose = null;
  webSocket.close();
  void handleClose(webSocket, ABNORMAL_CLOSURE);
}

async function handleClose(webSocket: WebSocket, code: number): Promise<void> {
  // An old socket that was already replaced or closed on purpose: nothing to do.
  if (relaySocket !== webSocket) {
    return;
  }
  relaySocket = null;
  stopConnectionTimers();
  log(`[handleClose:] closed with code ${code}`);

  // Refused or replaced: retrying would fail the same way, so wait for the user.
  if (code === CLOSE_UNAUTHORIZED) {
    await saveStatus({
      state: "unauthorized",
      detail:
        "The relay refused this browser (wrong token, or no hello in time).",
    });
    return;
  }
  if (code === CLOSE_REPLACED) {
    await saveStatus({
      state: "replaced",
      detail: "Another browser connected to this relay.",
    });
    return;
  }

  const settings = await loadSettings();
  if (!settings.enabled) {
    await saveStatus({ state: "disconnected" });
    return;
  }
  await saveStatus({
    state: "unreachable",
    detail: `Relay not responding at ${settings.url}`,
  });
  scheduleRetry();
}

/** Tries connect again after retryDelay, then doubles the delay for the next failure. */
function scheduleRetry(): void {
  log(`[scheduleRetry:] retrying in ${retryDelay}ms`);
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => void connect(), retryDelay);
  retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
}

/**
 * Closes the socket on purpose, without retrying. Sends CLOSE_BY_USER, which tells the relay
 * not to auto-start the browser until this extension's next hello.
 */
function disconnect(): void {
  clearTimeout(retryTimer);
  stopConnectionTimers();
  const webSocket = relaySocket;
  relaySocket = null;
  if (webSocket) {
    log("[disconnect:] disconnecting");
    webSocket.onclose = null;
    webSocket.close(CLOSE_BY_USER, "Disconnected by the user");
  }
}

/** Stops the ready and ping timers of the current connection. The retry timer is separate. */
function stopConnectionTimers(): void {
  clearTimeout(readyTimer);
  clearInterval(pingTimer);
}

function send(webSocket: WebSocket, message: ToRelay): void {
  webSocket.send(JSON.stringify(message));
}

/** A message from the relay, or null for anything that is not valid JSON of a known shape. */
function parseToExtension(data: unknown): ToExtension | null {
  if (typeof data !== "string") {
    return null;
  }
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof message !== "object" || message === null) {
    return null;
  }
  switch (message.type) {
    case "ready":
    case "ping":
    case "pong":
      return message as unknown as ToExtension;
    case "call":
      return typeof message.id === "string" &&
        typeof message.tool === "string" &&
        typeof message.args === "object" &&
        message.args !== null &&
        !Array.isArray(message.args)
        ? (message as unknown as Call)
        : null;
    default:
      return null;
  }
}

/** http://host:port -> ws://host:port/ext, https -> wss. Throws on an unparseable URL. */
function socketUrl(relayUrl: string): string {
  const url = new URL("/ext", relayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

function browserName(): string {
  return navigator.userAgent.includes("Edg/") ? "Edge" : "Chrome";
}
