// The popup never messages the worker. It writes settings to storage, which background.ts reacts
// to, and re-renders when storage changes: settings in `local`, the worker's status in `session`.

import { DEFAULT_SETTINGS, loadSettings, loadStatus, saveSettings } from './settings.js';
import type { Settings, Status, TabWindow } from './settings.js';

const urlInput = document.querySelector<HTMLInputElement>('#url')!;
const button = document.querySelector<HTMLButtonElement>('#connect')!;
const statusLine = document.querySelector<HTMLParagraphElement>('#status')!;
const statusDot = document.querySelector<HTMLSpanElement>('#dot')!;
const startBox = document.querySelector<HTMLDivElement>('#start')!;
const commandText = document.querySelector<HTMLElement>('#command')!;
const copyButton = document.querySelector<HTMLButtonElement>('#copy')!;
const tabWindowInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="tabWindow"]')];
const incognitoWarning = document.querySelector<HTMLParagraphElement>('#incognito-warning')!;
const TAB_WINDOWS: readonly TabWindow[] = ['current', 'separate', 'incognito'];

/** Written by stamp.ts at build time; missing if the extension was built without it. */
async function relayCommand(): Promise<string> {
  try {
    const response = await fetch(chrome.runtime.getURL('dist/install.json'));
    const { relay } = (await response.json()) as { relay?: unknown };
    if (typeof relay === 'string' && relay) return `node "${relay}"`;
  } catch {
    // fall through to the generic command
  }
  return 'npm run relay';
}

let saved: Settings;
let status: Status;

type Action = 'Connect' | 'Reconnect' | 'Cancel' | 'Disconnect';

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function actionFor(draftUrl: string): Action {
  if (!saved.enabled) return 'Connect';
  if (draftUrl !== saved.url || status.state === 'unauthorized' || status.state === 'replaced') return 'Reconnect';
  return status.state === 'connected' ? 'Disconnect' : 'Cancel';
}

const STATUS_TEXT: Record<Status['state'], string> = {
  disconnected: 'Not connected.',
  connecting: 'Connecting…',
  connected: 'Connected.',
  unreachable: 'Relay not responding, retrying automatically.',
  unauthorized: 'The relay refused this browser.',
  replaced: 'Another browser took over the relay. Press Reconnect to take it back.',
};

function render(): void {
  const draftUrl = urlInput.value.trim();
  const action = actionFor(draftUrl);
  const urlOk = isHttpUrl(draftUrl);

  button.textContent = action;
  button.disabled = (action === 'Connect' || action === 'Reconnect') && !urlOk;

  statusDot.dataset.state = status.state;
  statusLine.textContent = urlOk || draftUrl === ''
    ? STATUS_TEXT[status.state] + (status.state === 'connected' && status.detail ? ` ${status.detail}` : '')
    : 'Enter an http:// or https:// URL.';
  startBox.hidden = status.state === 'connected';
  for (const input of tabWindowInputs) input.checked = input.value === saved.tabWindow;
  // Re-checked on every render: the user may enable incognito access while the popup is open.
  void chrome.extension.isAllowedIncognitoAccess().then((allowed) => {
    incognitoWarning.hidden = allowed || saved.tabWindow !== 'incognito';
  });
}

// Saved at once, apart from the Connect button. Any setting change also disconnects
// (enabled: false), so the user presses Connect again to resume with the new setting.
for (const input of tabWindowInputs) {
  input.addEventListener('change', () => {
    const tabWindow = TAB_WINDOWS.find((value) => value === input.value);
    if (input.checked && tabWindow) void saveSettings({ ...saved, tabWindow, enabled: false });
  });
}

copyButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(commandText.textContent ?? '');
    copyButton.textContent = 'Copied';
  } catch {
    copyButton.textContent = 'Failed';
  }
  setTimeout(() => { copyButton.textContent = 'Copy'; }, 1500);
});

button.addEventListener('click', async () => {
  const action = actionFor(urlInput.value.trim());
  const enabled = action === 'Connect' || action === 'Reconnect';
  await saveSettings({
    ...saved,
    url: enabled ? urlInput.value.trim() : saved.url,
    enabled,
    connectNonce: saved.connectNonce + 1,
  });
});

urlInput.addEventListener('input', render);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.status) status = (changes.status.newValue as Status | undefined) ?? { state: 'disconnected' };
  else if (area === 'local' && changes.settings) saved = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue as Partial<Settings> | undefined) };
  else return;
  render();
});

let command: string;
[saved, status, command] = await Promise.all([loadSettings(), loadStatus(), relayCommand()]);
urlInput.value = saved.url;
commandText.textContent = command;
render();
