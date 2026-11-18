# 4. Extension core

The extension has three execution contexts:

| Context | Entry | Lifetime | Has DOM? |
|---|---|---|---|
| Service worker | `background.ts` | Started and stopped by Chrome; kept alive by socket traffic | No |
| Popup | `popup.html` + `popup.ts` | While the popup is open | Yes |
| Offscreen document | `offscreen.html` + `offscreen.ts` | Only during a video recording | Yes |

There are **no content scripts**. Code that must run in a page is sent as a string through CDP (see "Running code in the page" below).

How the three contexts talk to each other. Note that the popup and the service worker never message each other directly:

```text
 +-------------------------------- the extension --------------------------------------------+
 |                                                                                            |
 |  POPUP (popup.ts)                 chrome.storage                 SERVICE WORKER            |
 |  alive while it is open                                          (background.ts)           |
 |                                                                                            |
 |   saveSettings()  ------------->  local:   settings  --------->  onChanged:                |
 |                                                                  disconnect, connect       |
 |                                                                                            |
 |   onChanged: render()  <--------  session: status    <---------  saveStatus()              |
 |                                                                                            |
 |                                   session: groupId, downloadsSince   (worker only)         |
 |                                                                                            |
 |  OFFSCREEN DOCUMENT (offscreen.ts)                                                         |
 |  alive while recording                                                                     |
 |                        <------ runtime.sendMessage: start, frame, stop ------  record.ts   |
 |                        ------- reply {ok, file} --------------------------->               |
 +--------------------------------------------------------------------------------------------+
        |  fetch PUT /upload (video)                                  |  WebSocket /ext
        v                                                             v
                                       relay.ts
```

## `background.ts`: transport only

This file knows about sockets, queues and timeouts and nothing about tools. Its public surface to the rest of the extension is one import: `runTool(tool, args)`.

Covered in [02-request-lifecycle.md](02-request-lifecycle.md): hello/ready handshake, ping, backoff, the serial queue, the per-call budget.

A subtle point about Manifest V3: all top-level state here (`socket`, `queue`, `backoff`) is lost whenever Chrome stops the worker. The design accepts that and makes restart cheap: the last lines of the file re-create the alarm and call `resume()`, which reads the persisted settings and status and reconnects (`background.ts:236-238`).

## `tools.ts`: dispatch, guard, batch

### Dispatch table

```ts
// tools.ts:153-168
const handlers: Record<Exclude<ToolName, 'browser_batch'>, Handler> = {
  tabs_context_mcp: tabsContext,
  navigate: navigateTool,
  computer: (args) => computer({ ...args, tabId: requireTab(args.tabId) }),
  ...
};
```

Typing the table as `Record<Exclude<ToolName, 'browser_batch'>, Handler>` means adding a name to `ToolName` in `protocol.ts` without a handler is a compile error.

### One path for every tool

```text
runTool(tool, args)                       tools.ts:260
  |- browser_batch?  -> batch(args)
  '- runOne(tool, args, inBatch=false)    tools.ts:196
        1. look up handler            -> UNKNOWN_TOOL
        2. await guard(tool, args)    -> BLOCKED
        3. activate(tabId)            (overlay glow)
        4. handler(args, inBatch)
     then append the "Tab Context" footer if the output is content
```

### `guard()` runs before every tool (`tools.ts:172-194`)

1. `navigate` to a URL: check the target URL.
2. `files download`: check the URL.
3. If the call names a `tabId`:
   - the tab must be in the MCP group, unless "other tabs" is on;
   - the tab's **current** URL must be allowed, except for `navigate` and `tabs_close_mcp` (leaving a page is always allowed).

```text
 guard(tool, args)
   |
   +-- navigate to a URL (not back/forward) ....... checkUrl(target URL) ........ -> BLOCKED
   +-- files download ............................. checkUrl(args.url) .......... -> BLOCKED
   |
   +-- args.tabId is not a number? ................ done, allowed
   +-- the tab does not exist? .................... done (the handler reports NO_TAB)
   |
   +-- "other tabs" is off AND the tab is not in the MCP group ................. -> BLOCKED
   |
   '-- tool is neither navigate nor tabs_close_mcp:
            checkUrl(the tab's CURRENT url) ................................... -> BLOCKED
```

Step 3 is the important design point. Checking only the target of `navigate` is not enough, because pages redirect and links get clicked. Re-checking the live URL on every call means a tab that drifted onto a blocked site is frozen on the next call.

### `browser_batch` (`tools.ts:216-258`)

Runs `{name, input}` items in order through the same `runOne`, so each step gets the same guard. Details:

- Names are normalised with `.split('__').pop()`, so `mcp__browser__computer` works.
- Nested batches are rejected.
- Each text part is prefixed with a label such as `[computer:left_click]`; images are passed through in order.
- On the first error the batch stops and the error text says how many actions were not executed.
- One "Tab Context" footer is added at the end, for the last tab touched.

```text
 browser_batch { actions: [ navigate, computer:left_click, computer:type, computer:screenshot ] }

   for each item, in order:
        runOne(name, input, inBatch = true)       same guard, same handler as a single call
           |
           +-- ok ----> add its output, labelled "[computer:type] ..."
           '-- error -> add "[name] Error: ...  Batch stopped: N remaining actions were not executed."
                        isError = true, stop

   finally: add ONE "Tab Context" footer  ->  one result with texts and images interleaved
```

Why batching matters: each tool call is a full model round trip. Letting the model send "click, type, press Enter, screenshot" in one call is a large latency win.

### The "Tab Context" footer

Every content result ends with the list of tabs in the group and which tab the call ran on (`tabs.ts:112-122`). The model always has current tab ids and URLs without spending a call to ask.

## `cdp.ts`: the debugger layer

Everything that talks to a page goes through here.

### Lazy, de-duplicated attach

```ts
export async function send(target, method, ...params) {   // cdp.ts:80
  await attach(target.tabId);
  return raw(target, method, ...params);
}

export function attach(tabId) {                           // cdp.ts:145
  if (states.has(tabId)) return Promise.resolve();
  let pending = attaching.get(tabId);
  if (!pending) { pending = attachNow(tabId).finally(...); attaching.set(tabId, pending); }
  return pending;
}
```

`attaching` holds the in-flight promise so concurrent callers share one attach.

```text
 any feature:  send({tabId}, 'Some.method')
                    |
                    v
              attach(tabId)
                    |
        states.has(tabId)? ---- yes ----> nothing to do
                    | no
        attach already in flight? -- yes --> await the same promise
                    | no
                    v
              attachNow(tabId)
                1. tab exists?            no -> NO_TAB
                2. restricted URL?        yes -> RESTRICTED_PAGE
                3. chrome.debugger.attach   ("already attached" -> detach, attach again)
                4. create TabState
                5. initSession: Page, Runtime, focus emulation, iframe auto-attach,
                                + every onAttach listener (inspect: Network, Log; overlay: glow)
                6. wait 400ms for the debugging bar
                    |
                    v
              chrome.debugger.sendCommand(...)
```

`attachNow` (`cdp.ts:107-143`):

1. Refuse restricted pages (`chrome://`, the extension stores...) with a clear `RESTRICTED_PAGE` error.
2. `chrome.debugger.attach`. If it says "already attached" (a leftover from before a service worker restart), detach and attach again.
3. Create the per-tab state.
4. `initSession`.
5. Sleep 400ms: the debugging bar appears and shrinks the viewport, and the first screenshot must report the size later clicks will use.

### `initSession` (`cdp.ts:90-105`)

Run for the tab and again for each out-of-process iframe:

| Command | Why |
|---|---|
| `Page.enable`, `Runtime.enable` | Receive frame and execution-context events |
| `Emulation.setFocusEmulationEnabled` | The page behaves as focused and visible. This is how a background tab paints and accepts input without stealing the user's focus. |
| `Target.setAutoAttach` with `flatten: true`, filtered to iframes | Chrome attaches to cross-origin iframes automatically and gives each a `sessionId` |
| every `onAttach` listener | Other modules add their own setup (`inspect.ts` enables `Network` and `Log`; `overlay.ts` re-registers the glow) |

### Targets, sessions, frames

```ts
interface Target { tabId: number; sessionId?: string }             // who to send a command to
interface Frame extends Target { frameId?: string; contextId?: number }   // where to evaluate JS
```

- A **same-process iframe** shares the tab's session; it is distinguished by its JS execution `contextId`.
- An **out-of-process iframe (OOPIF)** has its own `sessionId`.

Per tab, `TabState` tracks (`cdp.ts:24-31`):

| Map | Key -> value | Filled by |
|---|---|---|
| `frames` | frameId -> `{sessionId, contextId}` | `Runtime.executionContextCreated` (default contexts only) |
| `sessions` | child sessionId -> parent sessionId | `Target.attachedToTarget` |
| `refs` | `ref_N` -> `{backendNodeId, sessionId}` | `refFor()` |
| `refByNode` | `sessionId:backendNodeId` -> `ref_N` | `refFor()` |

A page with three iframes, and the state it produces (ids are made up for the example):

```text
 tab 12 ............................ root session        Target {tabId: 12}
  |
  +-- main frame F1 ................ contextId 3
  |    |
  |    +-- iframe, same site, F2 ... contextId 7         same session, another JS context
  |    |
  |    '-- iframe, other site, F3 .. sessionId "S-A"     its own session (out-of-process)
  |         |                        contextId 1
  |         '-- iframe, third site, F4  sessionId "S-B"  attached through S-A
  |                                  contextId 1

 frames   = { F1: {contextId 3},
              F2: {contextId 7},
              F3: {sessionId "S-A", contextId 1},
              F4: {sessionId "S-B", contextId 1} }

 sessions = { "S-A": undefined,      parent is the root session
              "S-B": "S-A" }         parent is S-A

 To run JS in F2:   send to {tabId: 12}                  with contextId 7
 To run JS in F4:   send to {tabId: 12, sessionId "S-B"} with contextId 1
 To place F4 on screen: offset of F4 in S-A  +  offset of F3 in the root   (frameOffset recursion)
```

`track()` (`cdp.ts:224-263`) keeps these in sync from CDP events. The `sessions` parent links are what let `input.ts` compute where a nested iframe sits on screen.

### Event fan-out

`chrome.debugger.onEvent` has one listener. It updates the tab state, then forwards to every listener registered with `onEvent()` (`cdp.ts:265-277`). `inspect.ts` and `record.ts` subscribe this way. This is a small publish/subscribe that keeps `cdp.ts` unaware of the features built on it.

### Element refs

`ref_N` ids are the handle the model uses to point at elements (see [05-page-interaction.md](05-page-interaction.md)). The rules live here:

- A ref maps to a CDP `backendNodeId`, which is stable for the life of a DOM node.
- The same node always gets the same ref (`refByNode`), so refs are stable across repeated `read_page` calls.
- All refs are cleared when the **main frame** navigates (`cdp.ts:254-262`).
- Refs live in service worker memory, so a worker restart also loses them. The model then gets `STALE_REF` with the instruction to read the page again.

## `tabs.ts`: the tab group and navigation

### The "MCP" group

The model works inside a tab group titled `MCP`, coloured orange, created in its own unfocused window (`tabs.ts:36-50`). This gives a visible boundary between the agent's tabs and the user's.

`findGroup()` first tries a group id cached in `storage.session`, then falls back to querying by title, because the id is lost on browser restart while the group itself can survive (`tabs.ts:15-28`).

### Navigation (`tabs.ts:146-265`)

`navigate()` is more careful than `chrome.tabs.update({url})`:

1. **Start watching before triggering.** `watchLoad` registers a `tabs.onUpdated` listener first, so a fast load is not missed.
2. **`Page.navigate` via CDP**, raced against a 30s timeout. A CDP result containing `errorText` becomes a `NAVIGATE_FAILED` error the model can read. `net::ERR_ABORTED` is tolerated because that is what a URL that turns into a download reports.
3. **Fallback to `chrome.tabs.update`** when the debugger cannot touch the page.
4. **Wait for `complete`.** Same-document navigations (hash, `pushState`) never report `loading`, so after a 1.5s grace period they are treated as done.
5. Return text such as `Navigated to <final URL>` or `... (still loading)`.

```text
 navigate(tabId, target)
   |
   watchLoad(tabId)                              <- the listener goes in first
   |
   +-- "back" / "forward"
   |      Page.getNavigationHistory -> pick the entry -> checkUrl(entry.url)
   |      Page.navigateToHistoryEntry          (cannot attach? chrome.tabs.goBack / goForward)
   |
   '-- a URL
          withScheme(url)
          Page.navigate --- CDP refuses the page ---> chrome.tabs.update({url})
               |
               +-- no answer in 30s ......... return "Navigating to ... (still loading: the server
               |                                      has not answered yet)"
               +-- errorText, not ERR_ABORTED  -> NAVIGATE_FAILED
               '-- ok
   |
   wait until the tab reports "complete"        (max 30s; a same-document move passes after 1.5s)
   |
   return "Navigated to <final URL>"            (+ " (still loading)" if the wait ran out)
```

`withScheme()` adds `https://` to bare hosts, but `http://` for `localhost` and `127.x`, since local servers rarely have TLS (`tabs.ts:184-191`).

**History.** Back and forward use `Page.getNavigationHistory` + `Page.navigateToHistoryEntry` rather than `chrome.tabs.goBack`, because the browser's own back skips entries the user never interacted with, which is every page a model opens (`tabs.ts:193-218`). The target entry's URL is policy-checked first.

## Running code in the page

With no content scripts, in-page logic is written as normal TypeScript functions and shipped by `toString()`:

```ts
// snapshot.ts:81-99
export async function callOn<T>(target, objectId, fn, args = []) {
  await send(target, 'Runtime.callFunctionOn', {
    objectId,                                 // becomes `this` inside fn
    functionDeclaration: fn.toString(),
    arguments: args.map((value) => ({ value })),
    returnByValue: true, awaitPromise: true, userGesture: true,
  });
}

// usage, input.ts:290-292
function isChecked(this: Element): boolean { ... }
await callOn<boolean>(element, element.objectId, isChecked);
```

Two forms exist:

| Helper | CDP method | Use |
|---|---|---|
| `evaluate(frame, expression)` | `Runtime.evaluate` | Run an expression in a frame, e.g. `` `(${pageText.toString()})()` `` |
| `callOn(target, objectId, fn, args)` | `Runtime.callFunctionOn` | Run a function with `this` bound to a specific element |

The benefit: page functions are type-checked and live next to the code that calls them. The rule: they must be **self-contained**, because only their source text crosses over. They cannot reference imports or outer variables. `userGesture: true` makes the page treat the code as user-initiated, which some APIs require.

## `settings.ts`

| Data | Store | Why that store |
|---|---|---|
| `settings` (URL, token, enabled, guardrail options) | `chrome.storage.local` | Must survive browser restarts |
| `status` (connection state) | `chrome.storage.session` | Must reset when the browser restarts |
| `groupId`, `downloadsSince` | `chrome.storage.session` | Same |

`loadSettings` merges stored values over `DEFAULTS`, so a new setting added later has a value for existing users (`settings.ts:28-32`).

## `popup.ts`

Plain DOM code, no framework. One `render()` function recomputes the whole UI from three inputs: the form (`draft()`), the saved settings, and the status. Every input event calls `render()`.

Things worth noting:

- **Two panels.** Before connecting it shows the command to start the relay; once connected it shows the command to add the server to Claude Code or Cursor, with the token filled in (`popup.ts:78-90`).
- **Shell quoting.** `quote()` leaves safe strings alone and single-quotes the rest, escaping embedded quotes, so the copied command is correct for any token (`popup.ts:55-57`).
- **Button label is derived**, not stored: Connect / Reconnect / Cancel / Disconnect depending on `enabled`, dirty state and connection state (`popup.ts:98-103`).
- **Anti-flicker.** A refused connection fails in milliseconds, so "Connecting..." is held for at least 600ms after a click (`popup.ts:92-96`).
- **Fail closed on bad site lists.** If an allowed/blocked entry does not parse to a host, the button is disabled and the entry is named. Dropping it silently would widen the policy (`popup.ts:136-139`, `policy.ts:38-41`).
