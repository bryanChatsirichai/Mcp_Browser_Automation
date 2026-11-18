# Step 4: Debugger layer, navigation, and the per-call guard

**Goal.** The agent can open URLs in its own tabs, in the background, and cannot touch your other tabs or forbidden sites.

**Builds on.** Step 3.

The guard arrives in the same step as the first tool that can reach a web page. Do not postpone it.

## Background

`chrome.debugger` lets an extension attach to a tab and send it Chrome DevTools Protocol (CDP) commands, such as `Page.navigate` or `Input.dispatchMouseEvent`, and receive CDP events. It needs the `debugger` permission. While attached, Chrome shows a "started debugging this browser" bar. Unlike content scripts, CDP input events are trusted by the page, and CDP works on background tabs.

## Files

```text
extension/src/cdp.ts        attach, send, state, events           (new)
extension/src/policy.ts     URL rules                             (new)
extension/src/tabs.ts       + navigate, add a scheme, history
extension/src/tools.ts      + guard in runOne, navigate handler, release all
extension/src/settings.ts   + otherTabs, fileUrls, allowed, blocked
extension/src/popup.ts      + Advanced section
extension/src/background.ts + release all on disconnect
extension/manifest.json     + "debugger"
tools.ts                    + navigate
test/policy.test.ts                                               (new)
```

## Sub-tasks

**4.1 `cdp.ts`: one way to send a command.** Define a **target**: a tab id, plus an optional session id (used from step 11 for iframes). Write two functions:

- **raw send**: call `chrome.debugger.sendCommand` for the target. If it throws, rethrow as `ToolError` code `CDP_ERROR` with the method name and the message.
- **send**: attach to the tab first (4.2), then raw send. Every command attaches lazily, so no tool ever has to remember to attach.

Type it with the `devtools-protocol` package: it has a mapping from each command name to its parameter and return types, so a misspelt method or a wrong parameter fails the type-check. Import it as a type only, so nothing lands in the built extension.

**4.2 Lazy, shared attach.** Keep two maps keyed by tab id:

- **states**: the per-tab state. Its presence means "attached".
- **attaching**: the in-flight attach promise.

Attach returns at once if the tab has a state; returns the in-flight promise if there is one (so two calls never attach twice); otherwise starts a new attach and removes the promise from the map when it settles.

A new attach, in order:

1. Get the tab. Missing: `NO_TAB`.
2. If its URL is browser-internal or a web store (`chrome:`, `edge:`, `devtools:`, `chrome-extension:`, the Chrome and Edge extension stores), fail with `RESTRICTED_PAGE`. Chrome refuses to attach there.
3. Attach with protocol version `1.3`. If the error says the tab is already attached, detach and attach again: that attachment was left over from before a worker restart.
4. Create the tab's state.
5. Initialise the session: enable the `Page` and `Runtime` domains, and turn on focus emulation (`Emulation.setFocusEmulationEnabled`), ignoring a failure of that last one. Focus emulation is what lets a background tab paint and receive input as if it had focus.
6. Wait 400 milliseconds. The debugging bar changes the viewport size when it appears; waiting lets the size settle before the first screenshot.

Also: listen for `chrome.debugger.onDetach` and delete the tab's state; export "detach all" and "is attached".

**4.3 Hooks for later steps.** Add two lists of listeners now:

- **on attach**: called with the target during session initialisation, and awaited.
- **on event**: one `chrome.debugger.onEvent` listener forwards every event (target, method, parameters) to each of these.

Steps 10, 11 and 13 plug in here without editing the core.

**4.4 `policy.ts`: `checkUrl(url, settings)`.** Throws `ToolError` code `BLOCKED` for the first rule that applies:

```text
 empty, or about:blank                              allowed
 not parseable by the URL parser                    refused
 file:                                              refused unless the "allow file URLs" setting is on
 any scheme other than http or https                refused   (javascript:, data:, chrome:, ...)
 link-local or cloud metadata host                  refused   169.254.x.x, fe80::/10,
                                                              the IPv4-mapped form of 169.254.x.x,
                                                              metadata.google.internal
 host equals, or is a subdomain of, a blocked entry refused
 allowed list non-empty and host not covered by it  refused
 otherwise                                          allowed
```

Always compare host names **as produced by the URL parser**, lower-cased, with any trailing dot removed. The parser turns `2852039166` and `0xa9fea9fe` into `169.254.169.254`, so parsing first catches those disguises.

Also export two helpers for the popup:

- **clean sites**: turn the user's text (one entry per line, possibly with a scheme or path) into bare host names;
- **bad sites**: the entries that name no host.

The refusal message must end with advice for the model: "The user sets this policy in the extension popup. Report it; do not work around it."

Tests (they import the **compiled** `extension/dist/policy.js` after a build): exact host; subdomain; blocked wins over allowed; `notexample.com` does not match `example.com`; `169.254.169.254`; its decimal form `2852039166`; the IPv4-mapped IPv6 form; `javascript:`; `file:` with the setting on and off; `about:blank`.

**4.5 The guard, in `runOne`, before the handler.** Checked in this order:

```text
 navigate to a URL (not back/forward) ..... checkUrl on the URL (with its scheme added)
 no numeric tabId ......................... allowed
 tab does not exist ....................... allowed (the handler reports NO_TAB)
 "other tabs" off and tab not in the group  BLOCKED
 tool is not navigate or tab_close ........ checkUrl on the tab's CURRENT url
```

The last line is the important one: the live URL is re-checked on every call, because pages redirect and links get clicked.

**4.6 Navigation.** To navigate a tab to a URL:

1. Start watching `chrome.tabs.onUpdated` for this tab **before** triggering anything, or a fast load can finish before you listen.
2. Send `Page.navigate`, raced against 30 seconds. If CDP throws, fall back to `chrome.tabs.update`. If CDP returns an `errorText` other than `net::ERR_ABORTED` (which a download or a same-page jump produces), fail with `NAVIGATE_FAILED` and that text.
3. Wait for the tab's status to become `complete`, for at most 30 seconds. A navigation within the same document never reports `loading`; if nothing has happened after 1.5 seconds, accept it.
4. Return "Navigated to" plus the final URL, and add "(still loading)" if the wait ran out.

**Adding a scheme:** if the URL has none, add `https://`, or `http://` for `localhost`, `127.x.x.x` and `[::1]`.

**Back and forward:** read the history with `Page.getNavigationHistory`, pick the previous or next entry, check its URL with `checkUrl`, then go there with `Page.navigateToHistoryEntry`. Do not use `chrome.tabs.goBack`: it skips pages the user never interacted with, which is every page the agent visits.

**The `navigate` tool:** with a `tabId`, navigate that tab. Without one, use the first tab from "ensure group", and append the context JSON so the model learns the tab id.

**4.7 Popup: an Advanced section.** Two checkboxes ("let the agent use my other tabs", "allow `file://` URLs") and two text areas (allowed sites, blocked sites, one per line). If "bad sites" finds anything, name the bad entries and **disable the Connect button**. Silently dropping a bad entry from the allowed list could leave it empty, and an empty allowed list means every site is allowed.

**4.8 Release.** When the user disconnects on purpose, detach from every tab, so the debugging bar disappears.

## Interfaces

| Name | Where | Takes → returns |
|---|---|---|
| Target | `cdp.ts` | `{ tabId, sessionId? }` |
| send | `cdp.ts` | target, CDP method, params → the method's typed result. Attaches first |
| attach / is attached / detach all | `cdp.ts` | tab id → nothing / boolean / nothing |
| on attach | `cdp.ts` | registers an async listener receiving the target |
| on event | `cdp.ts` | registers a listener receiving target, method, params |
| `checkUrl` | `policy.ts` | url, settings → nothing, or throws `BLOCKED` |
| clean sites / bad sites | `policy.ts` | raw text → list of host names / list of bad entries |

## Done when

- `[auto]` `npm run check`, `npm run build`, `npm test` pass (policy tests included).
- `[browser]` `navigate {url: "example.com"}` with no tab id opens it in the group and returns the final URL; your current window keeps focus.
- `[browser]` The "debugging this browser" bar appears on first use.
- `[browser]` `navigate {url: "http://169.254.169.254/"}` returns the policy refusal and does not load.
- `[browser]` With allowed = `example.com`: navigating to `wikipedia.org` is blocked; `example.com` works.
- `[browser]` `navigate` with the id of one of your own tabs is blocked; ticking "use my other tabs" lifts it.
- `[browser]` `navigate {url: "back"}`, then `"forward"`, return to the same pages.
- `[browser]` `navigate` to `chrome://settings` on a group tab: the next page tool on that tab returns `RESTRICTED_PAGE`, not a crash.
- `[browser]` Press Disconnect: the debugging bar disappears.

## Pitfalls

- **Do not string-match URLs.** `http://2852039166/` is `169.254.169.254`. Parse first.
- **Private addresses (`192.168.x.x`, `10.x.x.x`, `localhost`) are allowed** by these rules. Decide deliberately whether your version should refuse them by default (step 14 returns to this).
- **A redirect to a refused site still loads.** The guard stops the agent on its next call; it does not stop the request.
- **Only `cdp.ts` calls `chrome.debugger`.** Keep that true and attach bugs stay in one file.

## Carry forward

- `send` is the only way to issue a CDP command, and it always attaches first.
- The guard runs before every handler, including every item of a batch (step 8).
- New tools that take a URL (step 9's download) must call `checkUrl` in the guard.
