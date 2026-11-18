# Step 2: The extension connects and stays connected

**Goal.** Pressing Connect in the popup opens a WebSocket from the extension to the relay. It survives relay restarts, service worker restarts and browser restarts, and the popup always shows the true state.

**Builds on.** Step 1.

## Files

```text
extension/src/protocol.ts     wire messages, close codes          (new)
extension/src/settings.ts     settings + status storage           (new)
extension/src/background.ts   connect, hello, ping, backoff
extension/src/popup.ts        (new)      extension/popup.html     (new)
extension/manifest.json       add "action": { "default_popup": "popup.html" }
relay.ts                      WebSocket upgrade on /ext, acceptExtension
```

## Sub-tasks

**2.1 `protocol.ts`.** The single definition of the wire format, imported by both halves (`relay.ts` imports `./extension/src/protocol.ts`). Erasable syntax only.

```ts
export interface Hello { type: 'hello'; token: string; browser: string; version: string }
export interface Ready { type: 'ready' }
export interface Ping  { type: 'ping' }
export interface Pong  { type: 'pong' }

export type ToRelay = Hello | Ping | Pong;          // step 3 adds Result
export type ToExtension = Ready | Ping | Pong;      // step 3 adds Call

export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_REPLACED = 4409;
```

**2.2 Relay: accept the socket.** `new WebSocketServer({ noServer: true })`, and handle `upgrade` on the HTTP server so both protocols share the port. Destroy the raw socket unless the path is `/ext` and the request passes `isLocal`.

`acceptExtension(socket)`:

1. Start a 5s timer; if no `hello` arrives, close with `4401`.
2. Validate every inbound frame (Zod discriminated union on `type`); drop what does not parse.
3. On a valid `hello`: close any existing extension socket with `4409`, store the new one in a module variable, send `ready`, log browser and version.
4. After that, every message resets a 60s idle timer that terminates the socket. Answer `ping` with `pong`.
5. On close: if this was the current socket, clear the variable.

**2.3 `settings.ts`.** Two stores with different lifetimes:

| Key | Store | Shape |
|---|---|---|
| `settings` | `chrome.storage.local` (survives restarts) | `{ url, token, enabled, connectNonce }` |
| `status` | `chrome.storage.session` (cleared on browser restart) | `{ state, detail? }` |

`loadSettings()` merges stored values over a `DEFAULTS` object so settings added in later steps get a value for existing users.

**2.4 `background.ts`: connect.**

```text
 connect():
   settings.enabled false, or a socket already exists -> return
   derive ws://host/ext from settings.url (http -> ws, https -> wss)
   open the socket; status = connecting; start an 8s "ready" timer that drops the socket
   onopen:    send hello; every 20s: if nothing heard for 30s drop(), else send ping
   onmessage: heardAt = now; ready -> status = connected, backoff = 1s; ping -> pong
   onclose:   4401 -> status = unauthorized (no retry)
              4409 -> status = replaced     (no retry)
              else -> status = unreachable; retry after backoff; backoff = min(backoff * 2, 30s)
```

`drop(socket)` closes the socket **and calls the close handler itself** with code 1006, because a dead relay never completes the closing handshake.

**2.5 Survive restarts.** At the bottom of `background.ts`: `chrome.alarms.create('reconnect', { periodInMinutes: 0.5 })`, an `onAlarm` listener and an `onStartup` listener that call `resume()`, then call `resume()` once. `resume()` returns early when the state is `unauthorized` or `replaced`, otherwise calls `connect()`.

**2.6 Storage as the control channel.** The worker listens to `chrome.storage.local.onChanged`; when `settings` changes it disconnects and connects with the new values. The popup never messages the worker.

**2.7 Popup.** A URL field, a Connect/Disconnect button, a status line. One `render()` recomputes everything from the form, the saved settings and the status; call it on every input event and on `chrome.storage.session.onChanged`. The button handler flips `enabled`, **increments `connectNonce`**, and saves.

Reference: `extension/src/protocol.ts`, `settings.ts`, `background.ts:115-238`, `popup.ts`, `relay.ts:211-280`, `relay.ts:657-666`.

## Contracts

```ts
// settings.ts
export interface Settings { url: string; token: string; enabled: boolean; connectNonce: number }
export interface Status {
  state: 'disconnected' | 'connecting' | 'connected' | 'unreachable' | 'unauthorized' | 'replaced';
  detail?: string;
}
export function loadSettings(): Promise<Settings>;
export function saveSettings(settings: Settings): Promise<void>;
export function loadStatus(): Promise<Status>;
export function saveStatus(status: Status): Promise<void>;
```

## Done when

- `[auto]` `npm run check`, `npm run build`, `npm test` pass.
- `[browser]` Relay running, press Connect: the relay logs "extension connected: Chrome v0.1.0" and the popup shows Connected.
- `[browser]` Stop the relay: within about 30s the popup shows "Relay not responding". Start it again: it reconnects with no click.
- `[browser]` On `chrome://extensions`, stop the service worker ("service worker" link > terminate, or wait): within 30s the alarm restarts it and the relay logs a new connection.
- `[browser]` Connect a second browser profile to the same relay: the first shows "Replaced". Press Reconnect in the first: it takes the relay back.
- `[browser]` Restart the browser with the extension left connected: it reconnects by itself.

## Pitfalls

- **The Reconnect button must change the stored value.** Storage fires a change event only when a value differs. The reference re-saves identical settings in the `replaced` state, which probably does nothing; `connectNonce` exists to avoid that.
- **All module-level variables die with the service worker.** Anything that must survive goes in storage. Design every handler so that a cold start does the right thing.
- **Do not flip to "connecting" on every retry.** Keep showing "unreachable" during retries, or the popup flickers.
- **The browser `WebSocket` API cannot set headers**, which is why the token travels inside `hello`.

## Carry forward

- Exactly one extension socket per relay; the newest wins.
- The worker reacts to settings through storage change events only.
- `status` in session storage is the single source of truth for the UI.
