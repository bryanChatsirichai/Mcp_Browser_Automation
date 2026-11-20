// Service worker entry point (manifest.json "background"). Chrome runs this file when the browser
// starts, when the extension is loaded or reloaded, and again whenever one of the events below
// wakes a worker it had stopped. It only wires those events to connection.ts.
//
// Files, in the order one tool call passes through them:
//   connection.ts  the WebSocket to the relay: connect, hello/ready, ping, retry
//   calls.ts       runs each call from the relay, one at a time, and sends one result back
//   tools.ts       the handler for each tool name
//   tabs.ts        the Chrome work: the "MCP Browser" tab group and its tabs
// Logs: chrome://extensions › Browser Bridge › Inspect views: service worker. Lines about a call
// carry the same short call id as the relay log.

import { reconnectIfAllowed, restartWithNewSettings } from "./connection.js";
import { connectionChanged } from "./settings.js";
import type { Settings } from "./settings.js";

main();

/**
 * Registers the event listeners and connects. Chrome requires the listeners to be registered
 * while this file first runs, so main() is called at top level, not after an await.
 */
function main(): void {
  // The popup never messages the worker: it saves settings, and this listener reacts.
  // The change event also wakes a stopped worker.
  chrome.storage.onChanged.addListener(onStorageChanged);
  // The alarm wakes a worker that Chrome stopped and retries a lost connection.
  chrome.alarms.create("reconnect", { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener(onAlarm);
  chrome.runtime.onStartup.addListener(() => void reconnectIfAllowed());
  void reconnectIfAllowed();
}

/** Reconnects with the new settings, but only when a setting the connection uses changed. */
function onStorageChanged(
  changes: Record<string, chrome.storage.StorageChange>,
  area: string,
): void {
  if (area !== "local" || !changes.settings) {
    return;
  }
  const before = changes.settings.oldValue as Partial<Settings> | undefined;
  const after = changes.settings.newValue as Partial<Settings> | undefined;
  if (connectionChanged(before, after)) {
    void restartWithNewSettings();
  }
}

function onAlarm(alarm: chrome.alarms.Alarm): void {
  if (alarm.name === "reconnect") {
    void reconnectIfAllowed();
  }
}
