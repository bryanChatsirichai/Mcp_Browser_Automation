// Service worker: keeps one WebSocket open to the relay.
// Chrome stops an idle worker after about 30 seconds and every variable here is lost, so all
// state that must survive lives in chrome.storage, and a cold start reconnects by itself.
//
// Connection lifecycle:
//   resume / settings change ─► connect ─► open: send hello, start pinging
//     ─► 'ready' received: connected (retry delay reset)
//     ─► close / drop ─► onClosed: 4401 and 4409 stop here; otherwise retry with backoff
// A call: onmessage 'call' ─► queue ─► handleCall ─► runTool (tools.ts) ─► one 'result' back.
// Logs go to this worker's console (chrome://extensions › Inspect views: service worker) and
// carry the same short call id as the relay log.

import { ToolError, toErrorBody } from "./errors.js";
import {
  CLOSE_BY_USER,
  CLOSE_REPLACED,
  CLOSE_UNAUTHORIZED,
} from "./protocol.js";
import type { Call, Result, ToExtension, ToRelay } from "./protocol.js";
import {
  connectionChanged,
  loadSettings,
  loadStatus,
  saveStatus,
} from "./settings.js";
import type { Settings } from "./settings.js";
import { runTool } from "./tools.js";

const READY_TIMEOUT_MS = 8_000;
const PING_INTERVAL_MS = 20_000;
const SILENCE_LIMIT_MS = 30_000;
const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
const ABNORMAL_CLOSURE = 1006;
// Nested inside the relay's 90 s call timeout, which is inside the ~100 s idle limit of common
// tunnels, so the innermost limit fires first and the model gets the most specific message.
const CALL_BUDGET_MS = 85_000;

// Calls run one at a time, in arrival order: two concurrent calls could otherwise each find no
// tab group and each create one.
let queue: Promise<void> = Promise.resolve();

let socket: WebSocket | null = null;
let retryDelay = FIRST_RETRY_MS;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let readyTimer: ReturnType<typeof setTimeout> | undefined;
let pingTimer: ReturnType<typeof setInterval> | undefined;
let heardAt = 0;

function log(message: string): void {
  console.info(`[bridge] ${message}`);
}

function send(ws: WebSocket, message: ToRelay): void {
  ws.send(JSON.stringify(message));
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

function expiresAfter(ms: number): Promise<never> {
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

/** Runs one call and always sends exactly one result, on the socket the call came from. */
async function handleCall(
  ws: WebSocket,
  call: Call,
  receivedAt: number,
): Promise<void> {
  const tag = `call ${call.id.slice(0, 8)} ${call.tool}`; // same short id as the relay log
  log(`${tag}: start (queued ${Date.now() - receivedAt}ms)`);
  let result: Result;
  try {
    // The budget counts from arrival, so time spent waiting in the queue is included.
    const left = receivedAt + CALL_BUDGET_MS - Date.now();
    if (left <= 0) {
      throw new ToolError(
        "BUSY",
        "The browser was busy with earlier calls. This call was not run; retry it.",
      );
    }
    const work = runTool(call.tool, call.args);
    // A call that loses the race may still fail later; that failure must not go unhandled.
    work.catch(() => undefined);
    result = {
      type: "result",
      id: call.id,
      ok: true,
      data: await Promise.race([work, expiresAfter(left)]),
    };
  } catch (error) {
    result = {
      type: "result",
      id: call.id,
      ok: false,
      error: toErrorBody(error),
    };
  }
  const elapsed = Date.now() - receivedAt;
  if (ws.readyState !== WebSocket.OPEN) {
    log(`${tag}: result dropped, socket closed after ${elapsed}ms`);
    return;
  }
  log(`${tag}: ${result.ok ? "ok" : result.error.code} in ${elapsed}ms`);
  send(ws, result);
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

function clearTimers(): void {
  clearTimeout(readyTimer);
  clearInterval(pingTimer);
}

async function connect(): Promise<void> {
  const settings = await loadSettings();
  // Checked after the await, and the socket is stored with no await in between, so two
  // concurrent calls (the alarm and a start-up resume) cannot open two sockets.
  if (!settings.enabled || socket) {
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

  const ws = new WebSocket(url);
  socket = ws;
  log(`connecting to ${url}`);
  // During automatic retries keep showing "unreachable", or the popup flickers.
  if ((await loadStatus()).state !== "unreachable") {
    await saveStatus({ state: "connecting" });
  }

  readyTimer = setTimeout(() => drop(ws), READY_TIMEOUT_MS);

  ws.onopen = () => {
    heardAt = Date.now();
    send(ws, {
      type: "hello",
      token: settings.token,
      browser: browserName(),
      version: chrome.runtime.getManifest().version,
    });
    pingTimer = setInterval(() => {
      if (Date.now() - heardAt > SILENCE_LIMIT_MS) {
        drop(ws);
      } else {
        send(ws, { type: "ping" });
      }
    }, PING_INTERVAL_MS);
  };

  ws.onmessage = (event) => {
    heardAt = Date.now();
    const message = parseToExtension(event.data);
    if (message?.type === "ready") {
      clearTimeout(readyTimer);
      retryDelay = FIRST_RETRY_MS;
      log("connected");
      void saveStatus({ state: "connected", detail: settings.url });
    } else if (message?.type === "ping") {
      send(ws, { type: "pong" });
    } else if (message?.type === "call") {
      const receivedAt = Date.now();
      queue = queue.then(() => handleCall(ws, message, receivedAt));
    }
  };

  ws.onclose = (event) => void onClosed(ws, event.code);
}

/**
 * Closes the socket and runs the close handling at once. A relay that died never completes
 * the closing handshake, so the socket's own close event could arrive much later.
 */
function drop(ws: WebSocket): void {
  ws.onclose = null;
  ws.close();
  void onClosed(ws, ABNORMAL_CLOSURE);
}

async function onClosed(ws: WebSocket, code: number): Promise<void> {
  if (socket !== ws) {
    return;
  }
  socket = null;
  clearTimers();
  log(`closed with code ${code}`);

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
  log(`retrying in ${retryDelay}ms`);
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
  clearTimers();
  const ws = socket;
  socket = null;
  if (ws) {
    log("disconnecting");
    ws.onclose = null;
    ws.close(CLOSE_BY_USER, "Disconnected by the user");
  }
}

/** Reconnects unless the last close needs the user to act first (refused or replaced). */
async function resume(): Promise<void> {
  const { state } = await loadStatus();
  // The user must act first.
  if (state === "unauthorized" || state === "replaced") {
    return;
  }
  await connect();
}

// The popup never messages the worker: it saves settings, and this listener reacts.
// The change event also wakes a stopped worker.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) {
    return;
  }
  if (
    !connectionChanged(
      changes.settings.oldValue as Partial<Settings> | undefined,
      changes.settings.newValue as Partial<Settings> | undefined,
    )
  ) {
    return;
  }
  disconnect();
  retryDelay = FIRST_RETRY_MS;
  void (async () => {
    const settings = await loadSettings();
    if (!settings.enabled) {
      await saveStatus({ state: "disconnected" });
      return;
    }
    await saveStatus({ state: "connecting" });
    await connect();
  })();
});

// The alarm wakes a worker that Chrome stopped and retries a lost connection.
chrome.alarms.create("reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "reconnect") {
    void resume();
  }
});
chrome.runtime.onStartup.addListener(() => void resume());
void resume();
