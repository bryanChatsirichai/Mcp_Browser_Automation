// Two stores with different lifetimes: settings must survive a browser restart, while the
// connection status must not (after a restart the worker reconnects and writes a fresh one).

export interface Settings {
  url: string;
  token: string;
  /** The user wants to be connected. */
  enabled: boolean;
  /**
   * Incremented on every button press. Storage fires a change event only when a value differs,
   * so without it "Reconnect" with unchanged settings would not wake the worker.
   */
  connectNonce: number;
  /** Where a new "MCP Browser" tab group is created. An existing group stays where it is. */
  tabWindow: TabWindow;
}

/**
 * incognito: a new private window, a clean session without the user's logins.
 * separate:  a new normal window of its own; shares the user's logins.
 * current:   the user's main window (the normal window they focused last).
 */
export type TabWindow = 'incognito' | 'separate' | 'current';

/** The settings the WebSocket depends on. Changing any other setting must not reconnect. */
const CONNECTION_KEYS = ['url', 'token', 'enabled', 'connectNonce'] as const;

/** True when a settings change needs a reconnect; also true for the first save, when there was no "before". */
export function connectionChanged(before: Partial<Settings> | undefined, after: Partial<Settings> | undefined): boolean {
  return !before || CONNECTION_KEYS.some((key) => before[key] !== after?.[key]);
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'unreachable' | 'unauthorized' | 'replaced';

export interface Status {
  state: ConnectionState;
  detail?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  url: 'http://127.0.0.1:8787',
  token: '',
  enabled: false,
  connectNonce: 0,
  tabWindow: 'separate',
};

/** Stored values merged over the defaults, so a setting added later has a value for existing users. */
export async function loadSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get<{ settings?: Partial<Settings> }>('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings });
}

export async function loadStatus(): Promise<Status> {
  const { status } = await chrome.storage.session.get<{ status?: Status }>('status');
  return status ?? { state: 'disconnected' };
}

export async function saveStatus(status: Status): Promise<void> {
  await chrome.storage.session.set({ status });
}
