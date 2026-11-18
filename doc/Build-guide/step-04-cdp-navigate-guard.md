# Step 4: Debugger layer, navigation, and the per-call guard

**Goal.** The agent can open URLs in its own tabs, in the background, and cannot touch your other tabs or forbidden sites.

**Builds on.** Step 3.

The guard arrives in the same step as the first tool that can reach a web page. Do not postpone it.

## Files

```text
extension/src/cdp.ts        attach, send, state, events           (new)
extension/src/policy.ts     URL rules                             (new)
extension/src/tabs.ts       + navigate, withScheme, history
extension/src/tools.ts      + guard() in runOne, navigate handler, releaseAll
extension/src/settings.ts   + otherTabs, fileUrls, allowed, blocked
extension/src/popup.ts      + Advanced section
extension/src/background.ts + releaseAll() on disconnect
extension/manifest.json     + "debugger"
tools.ts                    + navigate
test/policy.test.ts                                               (new)
```

## Sub-tasks

**4.1 `cdp.ts`: typed commands.**

```ts
import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js';
type Commands = ProtocolMapping.Commands;

export interface Target { tabId: number; sessionId?: string }      // sessionId is used from step 11

async function raw<M extends keyof Commands>(target: Target, method: M, ...params: Commands[M]['paramsType']) {
  try { return await chrome.debugger.sendCommand({ tabId: target.tabId }, method, params[0]); }
  catch (error) { throw new ToolError('CDP_ERROR', `${method}: ${cdpMessage(error)}`); }
}

export async function send(target, method, ...params) {
  await attach(target.tabId);                // every command attaches lazily
  return raw(target, method, ...params);
}
```

**4.2 Lazy, shared attach.** Two maps: `states` (tab id to per-tab state; its presence means "attached") and `attaching` (tab id to the in-flight promise). `attach()` returns at once if attached, returns the in-flight promise if one exists, otherwise starts `attachNow()` and removes the promise in `finally`.

`attachNow(tabId)` in order:

1. Tab missing: `NO_TAB`.
2. URL is a browser-internal or store page (`chrome:`, `edge:`, `devtools:`, `chrome-extension:`, the web stores): `RESTRICTED_PAGE`.
3. `chrome.debugger.attach({tabId}, '1.3')`. If the message says "already attached", detach and attach again: that attachment is left over from before a worker restart.
4. Create the tab state.
5. `initSession`: `Page.enable`, `Runtime.enable`, and `Emulation.setFocusEmulationEnabled { enabled: true }` (ignore failure). Focus emulation is what lets a background tab paint and take input.
6. Wait 400ms for the debugging bar to settle the viewport size.

Also: `chrome.debugger.onDetach` deletes the state; `detachAll()` and `isAttached(tabId)` are exported.

**4.3 Hooks for later steps.** Add `onAttach(listener)` and `onEvent(listener)` now, as arrays of callbacks. `initSession` awaits every attach listener; one `chrome.debugger.onEvent` listener forwards to every event listener. Steps 10, 11 and 13 plug in here without editing the core.

**4.4 `policy.ts`.** `checkUrl(url, settings)` throws `ToolError('BLOCKED', ...)` for the first reason that applies:

```text
 "" or about:blank                              allowed
 not parseable by new URL()                     refused
 file:                                          refused unless settings.fileUrls
 any other scheme than http / https             refused
 link-local or cloud metadata host              refused   169.254.x.x, fe80::/10, ::ffff:a9fe:..., metadata.google.internal
 host is on, or a subdomain of, a blocked entry refused
 allowed list non-empty and host not covered    refused
 otherwise                                      allowed
```

Always compare hostnames produced by `new URL()`, lowercased, trailing dot removed. Also export `cleanSites(raw)` (normalise user entries to bare hosts) and `badSites(raw)` (entries that name no host).

The message must end with advice for the model: "The user sets this policy in the extension popup. Report it; do not work around it."

Tests (run against `extension/dist/policy.js` after a build): exact host, subdomain, blocked wins over allowed, `notexample.com` is not `example.com`, `169.254.169.254`, the decimal form `2852039166`, the IPv4-mapped IPv6 form, `javascript:`, `file:` on and off, `about:blank`.

**4.5 `guard()` in `runOne`, before the handler.**

```text
 navigate to a URL (not back/forward) ..... checkUrl(withScheme(url))
 no numeric tabId ......................... allowed
 tab does not exist ....................... allowed (the handler reports NO_TAB)
 otherTabs off and tab not in the group ... BLOCKED
 tool is not navigate or tab_close ........ checkUrl(the tab's CURRENT url)
```

The last line is the important one: the live URL is re-checked on every call, because pages redirect and links get clicked.

**4.6 `navigate(tabId, target)`.**

1. Start a `chrome.tabs.onUpdated` watcher **before** triggering anything.
2. `Page.navigate` raced against 30s. If CDP throws, fall back to `chrome.tabs.update`. `errorText` other than `net::ERR_ABORTED` becomes `NAVIGATE_FAILED`.
3. Wait for status `complete` (max 30s). A same-document move never reports `loading`: accept it after 1.5s.
4. Return `Navigated to <final url>`, plus `(still loading)` if the wait ran out.

`withScheme(url)`: add `https://`, or `http://` for `localhost` / `127.x` / `[::1]`.

Back and forward: `Page.getNavigationHistory`, pick the entry, `checkUrl` it, `Page.navigateToHistoryEntry`. (`chrome.tabs.goBack` skips pages the user never interacted with, which is all of them here.)

The tool handler: with a `tabId`, navigate it. Without one, use the first tab of `ensureGroup()` and append `contextJson()` so the model learns the id.

**4.7 Popup: Advanced.** Two checkboxes (use my other tabs; allow `file://`), two textareas (allowed sites, blocked sites). If `badSites` finds anything, name the entries and **disable the button**: silently dropping a bad "allowed" entry could empty the list, and an empty allowed list means any site.

**4.8 Release.** On an explicit disconnect call `detachAll()`.

Reference: `cdp.ts:1-167`, `policy.ts`, `tabs.ts:144-265`, `extension/src/tools.ts:170-210`, `popup.ts:105-153`.

## Contracts

```ts
// cdp.ts
export function send<M extends keyof Commands>(target: Target, method: M, ...params): Promise<Commands[M]['returnType']>;
export function attach(tabId: number): Promise<void>;
export function isAttached(tabId: number): boolean;
export function detachAll(): Promise<void>;
export function onAttach(listener: (target: Target) => Promise<void>): void;
export function onEvent(listener: (target: Target, method: string, params: unknown) => void): void;

// policy.ts
export function checkUrl(url: string, settings: Settings): void;      // throws ToolError BLOCKED
export function cleanSites(raw: string): string[];
export function badSites(raw: string): string[];
```

## Done when

- `[auto]` `npm run check`, `npm run build`, `npm test` pass (policy tests included).
- `[browser]` `navigate {url: "example.com"}` with no tab id opens it in the group and returns the final URL; your current window keeps focus.
- `[browser]` The "debugging this browser" bar appears on first use.
- `[browser]` `navigate {url: "http://169.254.169.254/"}` returns "Blocked by ... policy" and does not load.
- `[browser]` With allowed = `example.com`: `navigate` to `wikipedia.org` is blocked; `example.com` works.
- `[browser]` `navigate` with the id of one of your own tabs is blocked; ticking "use my other tabs" lifts it.
- `[browser]` `navigate {url: "back"}` then `"forward"` return to the same pages.
- `[browser]` `navigate` to `chrome://settings` on a group tab: the next page tool on that tab returns `RESTRICTED_PAGE`, not a crash.
- `[browser]` Press Disconnect: the debugging bar disappears.

## Pitfalls

- **Do not string-match URLs.** `http://2852039166/` is `169.254.169.254`. Parse first.
- **Private addresses (`192.168.x.x`, `10.x`, `localhost`) are allowed** by these rules, as in the reference. Decide deliberately whether your version should refuse them by default.
- **A redirect to a refused site still loads.** The guard stops the agent on its next call; it does not stop the request.
- **Only `cdp.ts` calls `chrome.debugger`.** Keep that true and attach bugs stay in one file.

## Carry forward

- `send()` is the only way to issue a CDP command, and it always attaches first.
- `guard()` runs before every handler, including every item of a batch (step 8).
- New tools that take a URL (step 9's download) must call `checkUrl` in `guard()`.
