# Build status

Where this implementation stands against the [build guide](../Build-guide/README.md), as of 2026-11-18. Every claim below was checked against the code in `relay/`, `extension/` and `test/`. Checks marked **NOT RUN** still need a person in the browser.

## Summary

Steps 0 to 2 are complete. Step 3 is mostly done: the round trip works end to end and all three tab tools exist, but `tab_close` has not been checked in a browser yet. Steps 4 to 14 have not started, apart from two pieces of step 12 (browser auto-launch and the build stamp) that were built early.

The agent can open and list tabs in its own tab group. It cannot yet navigate, read or click a page.

```text
 FOUNDATION        0  Project skeleton                  DONE
                   1  Relay speaks MCP                  DONE
                   2  Extension connects                DONE
                   3  Round trip, first tools           PARTIAL  (browser checks not run)
 DRIVING A PAGE    4  Debugger, navigate, guard         not started   <- next
                   5  Screenshots                       not started
                   6  Mouse and keyboard                not started
                   7  Reading the page                  not started
                   8  JS, forms, batch                  not started
 AROUND THE PAGE   9  Files                             not started
                  10  Inspect                           not started
                  11  Iframes                           not started
                  12  Remote access                     PARTIAL  (auto-launch, stamp only)
                  13  Recording, overlay                not started
 FINISH           14  Hardening                         not started
```

## Tools

| Tool | Step | Status |
|---|---|---|
| `tabs_list` | 1, 3 | Done. Lists the "MCP Browser" group; `createIfEmpty` creates it. |
| `tab_open` | 3 | Done. Opens a blank tab in the group, creating the group if needed. |
| `tab_close` | 3 | Built 2026-11-21. Closes a tab in the group; any other id returns `NOT_IN_GROUP`. Browser check **NOT RUN**. |
| `navigate` | 4 | Built 2026-11-22, minimal: `chrome.tabs.update`, no CDP or site policy yet. Group tabs only (`NOT_IN_GROUP`); http, https and about:blank only (`BLOCKED`); waits up to 30 s for the load. No back/forward. Browser check **NOT RUN**. |
| Later tools | 4+ | Not started. See [tool-roadmap.md](tool-roadmap.md) for difficulty, usefulness and build order. |

## Step by step

### Step 0: Project skeleton: DONE

- `package.json` scripts: `relay`, `build` (`tsc -p extension && node stamp.ts`), `check`, `test`. Node 22.18 or newer.
- Two `tsconfig.json` files: the root one only type-checks, `extension/tsconfig.json` emits to `extension/dist/`.
- `extension/manifest.json`: MV3, permissions `storage`, `alarms`, `tabs`, `tabGroups`; module service worker; Chrome 125 or newer.
- `.gitignore`: `node_modules/`, `extension/dist/`, `files/`, `.env`.
- The placeholder smoke test was replaced by real tests (see Verification).

### Step 1: Relay speaks MCP: DONE

- `relay/relay.ts`: `http` server on `127.0.0.1`, port from `PORT` (default 8787), `route()` with the local-only gate first.
- `relay/relay-lib.ts`: `isLocal()` refuses a non-loopback address, a forged `Host`, forwarding headers and a web `Origin`.
- MCP over Streamable HTTP, stateless: a new `McpServer` and transport per request, no session id. Uses `@modelcontextprotocol/server` and `@modelcontextprotocol/node`, with Zod schemas in `relay/tools.ts`.
- Difference from the guide: an unknown tool name returns a JSON-RPC error (`-32602 Tool nope not found`) from the SDK, not a result with `"isError": true`. Clients still see a failed call.

### Step 2: Extension connects: DONE

- `extension/src/protocol.ts`: one definition of every wire message, imported by both halves. Close codes `CLOSE_UNAUTHORIZED` (4401), `CLOSE_REPLACED` (4409), `CLOSE_BY_USER`.
- The relay accepts the WebSocket on `/ext` behind the same `isLocal` gate, requires `hello` within 5 s, and drops a silent socket after 60 s. The newest browser replaces the older one.
- `extension/src/settings.ts`: settings in `chrome.storage.local` (survive a restart), status in `chrome.storage.session` (do not).
- `extension/src/background.ts`: connect, `ready` handshake (8 s), ping every 20 s, backoff retry from 1 s to 30 s, a 30 s alarm that wakes a stopped worker, and resume on start-up.
- Storage is the control channel: the popup only writes settings and the worker reacts. A reconnect happens only when `url`, `token`, `enabled` or `connectNonce` changes (`connectionChanged`, tested).
- `extension/popup.html` / `src/popup.ts`: relay URL, Connect / Disconnect / Reconnect / Cancel button, status line, and the "start the relay" command with a Copy button.

### Step 3: Round trip: PARTIAL

Done:

- Calls are matched to results by id. Each call times out after 90 s in the relay and 85 s in the extension. A socket that closes fails its pending calls at once ("Browser disconnected mid-call").
- With no extension connected, a call fails at once with "No browser connected…".
- `relay-lib.ts` `fence()` wraps browser text in `<untrusted-browser-content id="…">` with a fresh random id. It defangs the tag inside the body and strips invisible and bidi characters.
- `extension/src/errors.ts`: `ToolError` with a code, and `toErrorBody()`.
- The extension runs calls one at a time, in arrival order, and always sends exactly one result.
- `extension/src/tools.ts`: dispatch table (own keys only, so `toString` is refused).
- `extension/src/tabs.ts`: the "MCP Browser" group (orange). The group id is cached in session storage, with a fallback lookup by title. New tabs open inactive, so they never steal focus.
- `tab_close` (2026-11-21): `closeTab()` refuses any id not in the group, including the user's tabs and already-closed tabs, with `NOT_IN_GROUP`. It returns `closedTabId` plus the remaining tabs. Closing the last tab removes the group.

Missing:

- The "runs inside a batch" flag on handlers (3.7). It is only needed from step 8.

### Step 12: Remote access: PARTIAL (built early)

Done:

- Browser auto-launch: when a call arrives and no extension is connected, the relay starts the browser (`BROWSER_LAUNCH`, platform default, `off` disables it). It waits up to 20 s with a 60 s cooldown. It does not relaunch after the user pressed Disconnect.
- `stamp.ts` writes `extension/dist/install.json`, so the popup can show the exact `node "<path>/relay/relay.ts"` command.

Not done:

- **Token auth.** `settings.token` exists and the extension sends it in `hello`, but the relay never checks it, and the popup has no token field.
- Tunnels and remote mode.

## Beyond the guide

These were added on purpose and are not in the step files:

- **"Open agent tabs in" setting** (`tabWindow`): the main window, a separate window (the default), or an incognito window. It applies when the group is created; an existing group stays where it is. Incognito needs "Allow in Incognito", and the tool returns `INCOGNITO_NOT_ALLOWED` without it.
- **Changing that setting disconnects.** The popup saves `enabled: false`, so the user must press Connect again. The guide's step 2.6 assumes a settings change reconnects; this one turns the connection off instead.
- **Tool descriptions** for `tabs_list` and `tab_open` say that a closed group is recreated with a new `tabGroupId`, and that ids of closed tabs must not be reused.

## Verification

Run on 2026-11-18:

| Check | Result |
|---|---|
| `npm run check` | Pass |
| `npm run build` | Pass; writes `extension/dist/` and `install.json` |
| `npm test` | 22 pass, 0 fail (`errors` 3, `relay-lib` 15, `settings` 4) |
| `initialize` (curl) | Returns `browser-bridge` 0.1.0 |
| `tools/list` without `initialize` (curl) | Lists `tabs_list`, `tab_open` |
| `tools/call` with no extension (curl) | `isError: true`, "No browser connected", in 0 ms |
| Unknown tool (curl) | JSON-RPC error -32602 (see step 1) |
| Forged `Host`, web `Origin`, `X-Forwarded-For` | 403, 403, 403 |
| `GET /mcp`, `GET /nope` | 405, 404 |
| `tab_open` through Claude Code | Opens a tab in the group; after the group was closed, a new group with a new id was created |

The curl checks ran against a separate relay on port 8799 with auto-launch off.

Run on 2026-11-21, after adding `tab_close`: `npm run check` passes, and `npm test` gives 22 pass, 0 fail. On a relay at port 8799 (curl), `tools/list` lists `tabs_list`, `tab_open` and `tab_close`. `tab_close` with a string `tabId` returns an input validation error, and with no extension connected it returns `NO_EXTENSION`.

**NOT RUN** (browser checks from the guide):

- Step 2: relay stop and restart reconnects with no click; a terminated worker restarts within 30 s; a second profile shows "Replaced" and Reconnect takes the relay back; a browser restart reconnects.
- Step 3: `tab_close` with a group tab's id removes it, and with the id of one of your own tabs returns `NOT_IN_GROUP`; `tabs_list` `{"createIfEmpty": true}` opens a new window; disconnect during a slow call returns "Browser disconnected mid-call"; two calls at once run in order.
- Popup: changing "Open agent tabs in" disconnects and shows Connect.

## Next

1. Finish step 3: run the step 3 browser checks, including `tab_close`.
2. Step 4: the debugger layer, `navigate`, the per-call guard and site policy.
