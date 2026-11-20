// The popup: the window that opens when the user clicks the extension's icon (manifest.json
// "action" → popup.html, which loads this file). Chrome runs it fresh on every open.
//
// The popup never messages the worker. It writes settings to storage, which background.ts reacts
// to, and re-renders when storage changes: settings in `local`, the worker's status in `session`.
//
// Flow: start → load settings, status and relay command → render
//   button click / tab window change → saveSettings → background.ts reconnects
//   storage change (onStorageChanged) → render

import {
  DEFAULT_SETTINGS,
  loadSettings,
  loadStatus,
  saveSettings,
} from "./settings.js";
import type { Settings, Status, TabWindow } from "./settings.js";

const urlInput = document.querySelector<HTMLInputElement>("#url")!;
const connectButton = document.querySelector<HTMLButtonElement>("#connect")!;
const statusLine = document.querySelector<HTMLParagraphElement>("#status")!;
const statusDot = document.querySelector<HTMLSpanElement>("#dot")!;
const startBox = document.querySelector<HTMLDivElement>("#start")!;
const commandText = document.querySelector<HTMLElement>("#command")!;
const copyButton = document.querySelector<HTMLButtonElement>("#copy")!;
const tabWindowInputs = [
  ...document.querySelectorAll<HTMLInputElement>('input[name="tabWindow"]'),
];
const incognitoWarning =
  document.querySelector<HTMLParagraphElement>("#incognito-warning")!;
const TAB_WINDOWS: readonly TabWindow[] = ["current", "separate", "incognito"];

const STATUS_TEXT: Record<Status["state"], string> = {
  disconnected: "Not connected.",
  connecting: "Connecting…",
  connected: "Connected.",
  unreachable: "Relay not responding, retrying automatically.",
  unauthorized: "The relay refused this browser.",
  replaced:
    "Another browser took over the relay. Press Reconnect to take it back.",
};

/** The settings as last saved; the URL field may hold an unsaved draft. */
let savedSettings: Settings;
/** The worker's connection status, as it last saved it. */
let workerStatus: Status;

type ButtonAction = "Connect" | "Reconnect" | "Cancel" | "Disconnect";

for (const input of tabWindowInputs) {
  input.addEventListener("change", () => onTabWindowChange(input));
}
copyButton.addEventListener("click", () => void onCopyClick());
connectButton.addEventListener("click", () => void onConnectClick());
urlInput.addEventListener("input", render);
chrome.storage.onChanged.addListener(onStorageChanged);
await start();

/** Loads what the popup shows, then draws it. */
async function start(): Promise<void> {
  let command: string;
  [savedSettings, workerStatus, command] = await Promise.all([
    loadSettings(),
    loadStatus(),
    relayCommand(),
  ]);
  urlInput.value = savedSettings.url;
  commandText.textContent = command;
  render();
}

/** Updates every element from savedSettings, workerStatus and the URL field. */
function render(): void {
  const draftUrl = urlInput.value.trim();
  const action = buttonActionFor(draftUrl);
  const urlOk = isHttpUrl(draftUrl);

  connectButton.textContent = action;
  connectButton.disabled =
    (action === "Connect" || action === "Reconnect") && !urlOk;

  statusDot.dataset.state = workerStatus.state;
  statusLine.textContent =
    urlOk || draftUrl === ""
      ? STATUS_TEXT[workerStatus.state] +
        (workerStatus.state === "connected" && workerStatus.detail
          ? ` ${workerStatus.detail}`
          : "")
      : "Enter an http:// or https:// URL.";
  startBox.hidden = workerStatus.state === "connected";
  for (const input of tabWindowInputs) {
    input.checked = input.value === savedSettings.tabWindow;
  }
  // Re-checked on every render: the user may enable incognito access while the popup is open.
  void chrome.extension.isAllowedIncognitoAccess().then((allowed) => {
    incognitoWarning.hidden =
      allowed || savedSettings.tabWindow !== "incognito";
  });
}

/** What the main button does now, given the URL typed in the field. */
function buttonActionFor(draftUrl: string): ButtonAction {
  if (!savedSettings.enabled) {
    return "Connect";
  }
  if (
    draftUrl !== savedSettings.url ||
    workerStatus.state === "unauthorized" ||
    workerStatus.state === "replaced"
  ) {
    return "Reconnect";
  }
  return workerStatus.state === "connected" ? "Disconnect" : "Cancel";
}

/**
 * Saved at once, apart from the Connect button. Any setting change also disconnects
 * (enabled: false), so the user presses Connect again to resume with the new setting.
 */
function onTabWindowChange(input: HTMLInputElement): void {
  const tabWindow = TAB_WINDOWS.find((value) => value === input.value);
  if (input.checked && tabWindow) {
    void saveSettings({ ...savedSettings, tabWindow, enabled: false });
  }
}

async function onCopyClick(): Promise<void> {
  try {
    await navigator.clipboard.writeText(commandText.textContent ?? "");
    copyButton.textContent = "Copied";
  } catch {
    copyButton.textContent = "Failed";
  }
  setTimeout(() => {
    copyButton.textContent = "Copy";
  }, 1500);
}

/** Saves the button's action; background.ts sees the change and connects or disconnects. */
async function onConnectClick(): Promise<void> {
  const action = buttonActionFor(urlInput.value.trim());
  const enabled = action === "Connect" || action === "Reconnect";
  await saveSettings({
    ...savedSettings,
    url: enabled ? urlInput.value.trim() : savedSettings.url,
    enabled,
    connectNonce: savedSettings.connectNonce + 1,
  });
}

function onStorageChanged(
  changes: Record<string, chrome.storage.StorageChange>,
  area: string,
): void {
  if (area === "session" && changes.status) {
    workerStatus = (changes.status.newValue as Status | undefined) ?? {
      state: "disconnected",
    };
  } else if (area === "local" && changes.settings) {
    savedSettings = {
      ...DEFAULT_SETTINGS,
      ...(changes.settings.newValue as Partial<Settings> | undefined),
    };
  } else {
    return;
  }
  render();
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Written by stamp.ts at build time; missing if the extension was built without it. */
async function relayCommand(): Promise<string> {
  try {
    const response = await fetch(chrome.runtime.getURL("dist/install.json"));
    const { relay } = (await response.json()) as { relay?: unknown };
    if (typeof relay === "string" && relay) {
      return `node "${relay}"`;
    }
  } catch {
    // fall through to the generic command
  }
  return "npm run relay";
}
