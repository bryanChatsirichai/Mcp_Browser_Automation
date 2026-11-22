// The popup: the window that opens when the user clicks the extension's icon (manifest.json
// "action" → popup.html, which loads this file). Chrome runs it fresh on every open.
//
// The popup never messages the worker. It writes settings to storage, which background.ts reacts
// to, and re-renders when storage changes: settings in `local`, the worker's status in `session`.
//
// Flow: start → load settings, status and relay command → render
//   button click / tab window change → saveSettings → background.ts reconnects
//   site list / file:// change → saveSettings (no reconnect; read on every tool call)
//   storage change (onStorageChanged) → render

import { parseSites } from "../policy/policy.js";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  loadStatus,
  saveSettings,
} from "../shared/settings.js";
import type { Settings, Status, TabWindow } from "../shared/settings.js";
import { claudeCodeCommand, siteAccessSummary, STATUS_COPY } from "./view.js";

const urlInput = document.querySelector<HTMLInputElement>("#url")!;
const connectButton = document.querySelector<HTMLButtonElement>("#connect")!;
const statusTitle = document.querySelector<HTMLParagraphElement>("#status-title")!;
const statusDetail =
  document.querySelector<HTMLParagraphElement>("#status-detail")!;
const relayHost = document.querySelector<HTMLSpanElement>("#relay-host")!;
const startup = document.querySelector<HTMLDetailsElement>("#startup")!;
const commandText = document.querySelector<HTMLElement>("#command")!;
const clientCommandText =
  document.querySelector<HTMLElement>("#client-command")!;
const advanced = document.querySelector<HTMLDetailsElement>("#advanced")!;
const copyButtons = [
  ...document.querySelectorAll<HTMLButtonElement>("button[data-copy]"),
];
const tabWindowInputs = [
  ...document.querySelectorAll<HTMLInputElement>('input[name="tabWindow"]'),
];
const incognitoWarning =
  document.querySelector<HTMLParagraphElement>("#incognito-warning")!;
const TAB_WINDOWS: readonly TabWindow[] = ["current", "separate", "incognito"];
const blockedSitesInput = document.querySelector<HTMLTextAreaElement>("#blocked-sites")!;
const allowedSitesInput = document.querySelector<HTMLTextAreaElement>("#allowed-sites")!;
const sitesWarning = document.querySelector<HTMLParagraphElement>("#sites-warning")!;
const allowFileUrlsInput = document.querySelector<HTMLInputElement>("#allow-file-urls")!;
const siteSummary = document.querySelector<HTMLSpanElement>("#site-summary")!;

/** The settings as last saved; the URL field may hold an unsaved draft. */
let savedSettings: Settings;
/** The worker's connection status, as it last saved it. */
let workerStatus: Status;

type ButtonAction = "Connect" | "Reconnect" | "Cancel" | "Disconnect";

for (const input of tabWindowInputs) {
  input.addEventListener("change", () => onTabWindowChange(input));
}
for (const button of copyButtons) {
  button.addEventListener("click", () => void onCopyClick(button));
}
for (const input of [blockedSitesInput, allowedSitesInput]) {
  input.addEventListener("change", () => void onSitesChange());
}
// Site policy changes never disconnect: checkToolCall reads them on every tool call.
allowFileUrlsInput.addEventListener("change", () =>
  void saveSettings({ ...savedSettings, allowFileUrls: allowFileUrlsInput.checked }),
);
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
  // Filled once, not in render(), so a status change never overwrites what the user is typing.
  blockedSitesInput.value = savedSettings.blockedSites.join("\n");
  allowedSitesInput.value = savedSettings.allowedSites.join("\n");
  commandText.textContent = command;
  document.querySelector("#version")!.textContent =
    `v${chrome.runtime.getManifest().version}`;
  // Set once per open, not in render(), so a status change never folds it under the user.
  startup.open = workerStatus.state !== "connected";
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

  const copy = STATUS_COPY[workerStatus.state];
  const urlInvalid = !urlOk && draftUrl !== "";

  connectButton.dataset.kind =
    action === "Disconnect" || action === "Cancel" ? "secondary" : "primary";
  document.body.dataset.state = workerStatus.state;
  statusTitle.textContent = copy.title;
  statusDetail.textContent = urlInvalid
    ? "Enter an http:// or https:// URL."
    : copy.detail;
  statusDetail.classList.toggle("error", urlInvalid);
  // Keep a bad URL visible: the message points at a field inside Advanced.
  if (urlInvalid) {
    advanced.open = true;
  }
  relayHost.textContent = hostOf(savedSettings.url);
  clientCommandText.textContent = claudeCodeCommand(savedSettings.url);
  for (const input of tabWindowInputs) {
    input.checked = input.value === savedSettings.tabWindow;
  }
  allowFileUrlsInput.checked = savedSettings.allowFileUrls;
  siteSummary.textContent = siteAccessSummary(savedSettings);
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

/**
 * Saves both site lists, or neither while any entry is not a site. Dropping a bad entry instead
 * could leave the allowed list empty, and an empty list allows every site.
 */
async function onSitesChange(): Promise<void> {
  const blocked = parseSites(blockedSitesInput.value);
  const allowed = parseSites(allowedSitesInput.value);
  const bad = [...blocked.bad, ...allowed.bad];
  sitesWarning.hidden = bad.length === 0;
  sitesWarning.textContent = `Not saved. Not a site: ${bad.join(", ")}`;
  if (bad.length > 0) {
    return;
  }
  await saveSettings({
    ...savedSettings,
    blockedSites: blocked.sites,
    allowedSites: allowed.sites,
  });
  // Show what was saved: host names only, e.g. "https://www.example.com/a" → "www.example.com".
  blockedSitesInput.value = blocked.sites.join("\n");
  allowedSitesInput.value = allowed.sites.join("\n");
}

/** Copies the text of the <code> named by the button's data-copy attribute. */
async function onCopyClick(button: HTMLButtonElement): Promise<void> {
  const label = button.querySelector<HTMLSpanElement>(".copy-label")!;
  const source = document.getElementById(button.dataset.copy ?? "");
  try {
    await navigator.clipboard.writeText(source?.textContent ?? "");
    button.dataset.copied = "";
    label.textContent = "Copied";
  } catch {
    label.textContent = "Failed";
  }
  setTimeout(() => {
    delete button.dataset.copied;
    label.textContent = "Copy";
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

/** "127.0.0.1:8787" for the label under the relay node; empty if the URL doesn't parse. */
function hostOf(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
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
