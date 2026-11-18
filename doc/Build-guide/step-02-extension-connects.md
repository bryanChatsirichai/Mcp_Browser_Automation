# Step 2: The extension connects and stays connected

**Goal.** Pressing Connect in the popup opens a WebSocket from the extension to the relay. It survives relay restarts, service worker restarts and browser restarts, and the popup always shows the true state.

**Builds on.** Step 1.

## Files

```text
extension/src/protocol.ts     wire messages, close codes          (new)
extension/src/settings.ts     settings + status storage           (new)
extension/src/background.ts   connect, hello, ping, backoff
extension/src/popup.ts        (new)      extension/popup.html     (new)
extension/manifest.json       add an "action" whose default popup is popup.html
relay.ts                      WebSocket upgrade on /ext, accept the extension
```

## Sub-tasks

**2.1 `protocol.ts`: the wire format.** This file is the single definition of every message that crosses the WebSocket. Both halves import it: the relay imports it directly from `extension/src/protocol.ts` (Node can run it because it contains only erasable syntax, so no enums). Every message is a JSON object with a `type` field.

| Message | Direction | Fields |
|---|---|---|
| `hello` | extension → relay | `token` (empty string for now), `browser` (for example "Chrome"), `version` (the extension's) |
| `ready` | relay → extension | none |
| `ping` | either way | none |
| `pong` | either way | none |

Step 3 adds `call` (relay → extension) and `result` (extension → relay).

Define two WebSocket close codes in the private range 4000 to 4999:

| Code | Name | Meaning |
|---|---|---|
| 4401 | unauthorized | Bad token, or no `hello` in time. The extension must not retry |
| 4409 | replaced | Another browser connected and took over. The extension must not retry |

**2.2 Relay: accept the socket.** Create a WebSocket server (from `ws`) in "no server" mode, and handle the HTTP server's `upgrade` event yourself, so HTTP and WebSocket share one port. In the upgrade handler, destroy the raw socket unless the path is `/ext` and the request passes `isLocal`.

For each accepted socket:

1. Start a 5-second timer. If no `hello` arrives in time, close with 4401.
2. Parse every incoming text frame as JSON and validate it against a zod discriminated union on `type`. Silently drop anything that does not parse or validate.
3. On a valid `hello`: close any existing extension socket with 4409, store this socket in a module-level variable ("the extension"), send `ready`, and log the browser and version.
4. After that, every message restarts a 60-second idle timer that terminates the socket. Answer `ping` with `pong`.
5. On close: if this socket is the stored one, clear the variable.

**2.3 `settings.ts`: two stores.** They have different lifetimes on purpose.

| Key | Chrome store | Survives | Fields |
|---|---|---|---|
| `settings` | `chrome.storage.local` | Browser restarts | `url` (the relay's HTTP URL), `token`, `enabled` (the user wants to be connected), `connectNonce` (a counter, see 2.7) |
| `status` | `chrome.storage.session` | Until the browser closes | `state`, optional `detail` |

`state` is one of: `disconnected`, `connecting`, `connected`, `unreachable`, `unauthorized`, `replaced`.

The load function for settings merges the stored values over a defaults object, so a setting added in a later step gets a value for users who saved before it existed.

**2.4 `background.ts`: connect.** The `connect` routine:

1. Return at once if `enabled` is false or a socket already exists.
2. Derive the WebSocket URL from the saved relay URL: `http` becomes `ws`, `https` becomes `wss`, and the path is `/ext`.
3. Open the socket and set the status to `connecting`. Start an 8-second timer that drops the socket if `ready` has not arrived.
4. **On open:** send `hello`. Start a 20-second interval: if nothing has been heard from the relay for 30 seconds, drop the socket; otherwise send `ping`.
5. **On message:** record the time it was heard. On `ready`: status becomes `connected`, and the retry delay resets to 1 second. On `ping`: answer `pong`.
6. **On close**, by close code:
   - 4401: status `unauthorized`, no retry.
   - 4409: status `replaced`, no retry.
   - anything else: status `unreachable`, retry after the current delay, then double the delay up to a maximum of 30 seconds.

"Drop" means: close the socket **and run the close handling yourself** with code 1006 (abnormal closure). A relay that died never completes the closing handshake, so the socket's own close event may not come for a long time.

**2.5 Survive restarts.** Chrome stops an idle extension service worker after about 30 seconds, and all its variables are lost. When the worker starts:

- create a repeating alarm (`chrome.alarms`) every 30 seconds;
- on that alarm, and on browser startup (`chrome.runtime.onStartup`), call `resume`;
- call `resume` once directly.

`resume` does nothing when the stored status is `unauthorized` or `replaced` (the user must act), and otherwise calls `connect`. The alarm both wakes a stopped worker and retries a lost connection.

**2.6 Storage as the control channel.** The popup never messages the worker. It only writes `settings`. The worker listens for changes to `chrome.storage.local`, and when `settings` changes it disconnects and connects again with the new values. This works even when the worker was asleep: the change event wakes it.

**2.7 Popup.** A relay URL field, a Connect / Disconnect button, and a status line. Write one `render` function that recomputes the whole popup from three inputs: the form fields, the saved settings, and the stored status. Call it on every input event and whenever `chrome.storage.session` changes.

The button handler flips `enabled`, **increments `connectNonce`**, and saves the settings.

## Interfaces

| Name | Where | Shape |
|---|---|---|
| Settings | `settings.ts` | `{ url, token, enabled, connectNonce }` |
| Status | `settings.ts` | `{ state, detail? }`, `state` as listed in 2.3 |
| load / save settings, load / save status | `settings.ts` | Async functions over the two stores |
| Close codes | `protocol.ts` | 4401 unauthorized, 4409 replaced |

## Done when

- `[auto]` `npm run check`, `npm run build`, `npm test` pass.
- `[browser]` Relay running, press Connect: the relay logs "extension connected: Chrome v0.1.0" (with your version), and the popup shows Connected.
- `[browser]` Stop the relay: within about 30 seconds the popup shows that the relay is not responding. Start it again: the extension reconnects with no click.
- `[browser]` On `chrome://extensions`, stop the service worker (terminate it, or wait): within 30 seconds the alarm restarts it and the relay logs a new connection.
- `[browser]` Connect a second browser profile to the same relay: the first shows "Replaced". Press Reconnect in the first: it takes the relay back.
- `[browser]` Restart the browser with the extension left connected: it reconnects by itself.

## Pitfalls

- **The Reconnect button must change the stored value.** Storage fires a change event only when a value actually differs. Saving identical settings does nothing; incrementing `connectNonce` guarantees a change.
- **All module-level variables die with the service worker.** Anything that must survive goes in storage. Design every handler so that a cold start does the right thing.
- **Do not flip to `connecting` on every retry.** Keep showing `unreachable` during retries, or the popup flickers.
- **The browser `WebSocket` API cannot set headers**, which is why the token travels inside `hello` and not in an `Authorization` header.

## Carry forward

- Exactly one extension socket per relay; the newest wins.
- The worker reacts to settings through storage change events only.
- `status` in session storage is the single source of truth for the UI.
