# 2. Life of a request

This file follows one tool call from the model to the page and back, then covers the wire protocol, the timeouts and the connection lifecycle.

## Trace: `computer {action: "left_click", coordinate: [400, 300], tabId: 12}`

```text
MCP client            relay.ts                      background.ts / tools.ts              page
    |                     |                                   |                             |
 1  |-- POST /mcp ------> |                                   |                             |
    |   tools/call        |                                   |                             |
 2  |                     | route(): local? token?            |                             |
 3  |                     | buildServer() + transport         |                             |
 4  |                     | logCall, checkUploads             |                             |
 5  |                     | callExtension(): id=uuid,         |                             |
    |                     |   pending.set(id), 90s timer      |                             |
 6  |                     |-- {type:call,id,tool,args} -----> |                             |
 7  |                     |                                   | parse, queue.then(handleCall)|
 8  |                     |                                   | runOne: guard(tab, URL)     |
 9  |                     |                                   | activate(tab) -> glow       |
10  |                     |                                   | computer(): viewOf, toCss   |
11  |                     |                                   |-- Input.dispatchMouseEvent ->|
    |                     |                                   |   moved, pressed, released  |
12  |                     |                                   | settle(): wait if loading   |
13  |                     |                                   | append "Tab Context" footer |
14  |                     | <-- {type:result,id,ok,data} ---- |                             |
15  |                     | settle(id): resolve promise       |                             |
16  |                     | toResult(): fence text            |                             |
17  | <-- JSON-RPC result |                                   |                             |
```

Step by step, with the code:

1. **HTTP in.** The client posts a JSON-RPC `tools/call` to `/mcp`.
2. **Gate.** `route()` rejects non-local requests when no token is set, otherwise checks the Bearer token (`relay.ts:608-628`).
3. **Fresh server.** `handleMcp` builds a new MCP `Server` and `StreamableHTTPServerTransport` for this one request (`relay.ts:514-524`).
4. **Pre-flight on the relay.** `logCall` writes an audit line including the model's `action_summary`. `checkUploads` validates `file_upload` paths, because only the relay can see the file system (`relay.ts:446-449`).
5. **Correlation.** `callExtension` creates a UUID, stores `{resolve, reject, timer}` under it in `pending`, and starts a 90s timer (`relay.ts:177-187`).
6. **Over the socket.** `{type: "call", id, tool, args}` goes to the extension.
7. **Queue.** `onMessage` chains the call onto a promise queue so calls run one at a time (`background.ts:107-112`).
8. **Guard.** `guard()` checks that tab 12 is in the MCP group and that its current URL is allowed (`tools.ts:172-194`).
9. **Overlay.** `activate(tabId)` turns on the glow border (`tools.ts:207`).
10. **Coordinates.** `locate()` converts the model's `[400, 300]` from the screenshot frame to CSS pixels (`computer.ts:42-67`).
11. **Real input.** `click()` sends `mouseMoved`, `mousePressed`, `mouseReleased` through CDP (`input.ts:157-170`). `send()` attaches the debugger first if needed.
12. **Settle.** `settle()` waits up to 10s while the tab reports `loading`, so a click that navigates finishes before the next call (`input.ts:455-467`).
13. **Footer.** `runTool` appends a "Tab Context" text block listing the tabs (`tools.ts:260-272`).
14. **Result back.** `{type: "result", id, ok: true, data}`.
15. **Match.** `settle(id, ...)` on the relay finds the pending entry, clears its timer and resolves (`relay.ts:190-203`).
16. **Fence.** `toResult` wraps all text in `<untrusted-browser-content id="NONCE">` (`relay.ts:333-363`).
17. **HTTP out.** The MCP SDK writes the JSON-RPC response; the per-request server is closed when the response closes.

## Wire protocol (`extension/src/protocol.ts`)

JSON text frames over one WebSocket. Six message types:

| Direction | Message | Meaning |
|---|---|---|
| ext -> relay | `{type:"hello", token, browser, version}` | First message. Authenticates the socket. |
| relay -> ext | `{type:"ready"}` | Hello accepted. |
| relay -> ext | `{type:"call", id, tool, args}` | Run a tool. |
| ext -> relay | `{type:"result", id, ok:true, data}` or `{..., ok:false, error:{code, message}}` | Answer to a call. |
| both | `{type:"ping"}`, `{type:"pong"}` | Liveness. The extension pings; the relay pongs. |

Custom close codes: `4401` (unauthorized) and `4409` (replaced by another browser) (`protocol.ts:61-62`). The extension treats these two as "do not retry"; any other close triggers a reconnect.

### Two result shapes

`data` in a successful result is one of:

- **Ready-made MCP content**: `{content: [{type:"text"...}, {type:"image"...}], isError?}`. Used by the tools mirrored from Claude in Chrome.
- **Plain JSON**: any object. Used by `inspect`, `record`, `files`.

The relay tells them apart by `Array.isArray(data.content)` (`relay.ts:338`). Plain JSON is stringified into one text block.

### Validation at each end

- The relay validates inbound frames with a Zod discriminated union and silently drops anything that does not parse (`relay.ts:110-126`, `222-233`).
- The extension validates by hand, with no library, to stay dependency-free (`background.ts:37-58`).
- Tool **arguments** are not validated against `schemas.ts` anywhere. Each handler checks what it needs and throws `ToolError('BAD_ARGS', ...)`.

## Timeouts, layered

The limits are nested so the inner one fires first and produces the more useful error.

```text
100s  idle limit of common tunnels (cloudflared, etc.)         <- the reason for everything below
 90s  relay: CALL_TIMEOUT_MS per call               relay.ts:36
 85s  extension: CALL_BUDGET_MS, measured from when the call ARRIVED   background.ts:19
 80s  files.download waits for completion            files.ts:10
 45s  javascript_tool                                inspect.ts:231
 30s  navigation load wait                           tabs.ts:9
 10s  settle() after an input action                 input.ts:456
```

The same thing on a timeline, for a call that waited 60s behind earlier calls:

```text
 call arrives at the extension (receivedAt)
 |
 |------------ waiting in the queue -----------|------ running ------|
 0s                                           60s                   85s   90s        100s
                                                                     |     |          |
                         extension answers TIMEOUT ("abandoned") ----+     |          |
                         relay would answer TIMEOUT -----------------------+          |
                         a tunnel would cut the HTTP request -------------------------+

 Still queued at 85s?  It is answered BUSY ("not run; retry it") without starting.
```

Two details are worth studying in `handleCall` (`background.ts:62-90`):

- **The budget starts at arrival, not at execution.** A call that waited 60s in the queue has 25s left. If nothing is left it fails with `BUSY` and a message saying it was not run and can be retried.
- **Timeout by `Promise.race`, not cancellation.** CDP work cannot be cancelled. On timeout the call is reported as abandoned ("its effects may still land in the page") and the queue moves on. The orphaned promise gets a no-op `.catch` so its later failure does not become an unhandled rejection. The trade-off: an abandoned action can still be running while the next one starts.

## Serial execution

```ts
// background.ts:28-29
// Calls run one at a time: mouse and key sequences from parallel calls would interleave.
let queue: Promise<void> = Promise.resolve();
```

A promise chain is the whole scheduler: `queue = queue.then(() => handleCall(...))`. Two calls skip the queue because they touch no page (`background.ts:92-95`): `tabs_context_mcp`, and the internal `files {action:"path"}` lookup the relay uses to serve a download.

```text
 calls arriving on the socket            the queue (one promise chain)             page

   A  computer:left_click  ---+
   B  computer:type           +------>  [ A ] --> [ B ] --> [ C ]  ----------->  CDP, one at a time
   C  computer:screenshot  ---+

   tabs_context_mcp      -------------- runs at once, beside the queue ------->  (no page touched)
   files {action:"path"} -------------- runs at once, beside the queue ------->  (no page touched)
```

## Connection lifecycle

State machine of the extension side, as stored in `chrome.storage.session` under `status` (`settings.ts:13-16`):

```text
                   user presses Connect
  disconnected  ------------------------>  connecting  --- ready --->  connected
       ^                                       |                          |
       | user presses Disconnect               | no "ready" within 8s     | close (any other code),
       |                                       | or socket error          | or 30s of silence
       |                                       v                          v
       +------------------------------  unreachable  <--------------------+
                                           |   ^
                                           +---+  retry with backoff 1s, 2s, 4s ... max 30s

  close 4401 -> unauthorized   (stays down until settings change)
  close 4409 -> replaced       (stays down until the user presses Reconnect)
```

**Probable bug, not reproduced.** In the `replaced` state the popup button reads "Reconnect" and the handler re-saves the settings (`popup.ts:190-192`). The service worker only reconnects from the `storage.local` change event (`background.ts:221-227`), and the 30s alarm skips `replaced` on purpose. If the settings are unchanged, the saved value is identical, and Chrome's storage reports a change only for values that differ, so no event would fire and nothing would reconnect. Pressing Disconnect then Connect changes `enabled` and would work. I did not run the extension to confirm this.

### Handshake at a glance

```text
 extension (background.ts)                                   relay (acceptExtension)
        |                                                            |
        |  connect(): start readyTimer (8s)                          |
        |---- WebSocket upgrade, GET /ext -------------------------->|  no token: must pass isLocal()
        |                                                            |  start helloTimer (5s)
        |---- {hello, token, browser, version} --------------------->|  wrong token -> close 4401
        |                                                            |  older socket, if any -> close 4409
        |<--- {ready} -----------------------------------------------|  start idle timer (60s)
        |  status = connected, backoff reset to 1s,                  |
        |  download watermark set                                    |
        |                                                            |
        |---- {ping} ------------- every 20s ----------------------->|  idle timer reset
        |<--- {pong} ------------------------------------------------|
        |  heardAt updated                                           |
        |                                                            |
        |  nothing heard for 30s -> drop the socket, retry           |  nothing heard for 60s -> terminate
```

### Handshake (relay side, `relay.ts:211-280`)

1. On upgrade to `/ext`, a 5s `helloTimer` starts.
2. The first valid message must be `hello` with the right token, else close `4401`.
3. If another extension socket exists, it is closed with `4409`. **One browser per relay, last one wins.**
4. `ready` is sent, and anything waiting in `onConnected` (see `BROWSER_LAUNCH`) is notified.
5. Every later message resets a 60s idle timer; when it fires the socket is terminated.

### Keeping it alive (extension side)

- Ping every 20s; if nothing has been heard for 30s, drop the socket without waiting for the close handshake, because a dead relay never completes it (`background.ts:134-139`, `184-187`).
- A `chrome.alarms` alarm every 30s calls `resume()`. This restarts the connection if Chrome stopped the service worker despite the pings (`background.ts:229-238`).
- `chrome.runtime.onStartup` is registered so the worker starts when the browser launches.

### Settings are the control channel

The popup never messages the service worker. It writes `settings` to `chrome.storage.local`; the worker listens to `onChanged`, disconnects, and reconnects with the new values (`background.ts:221-227`). Status flows the other way through `storage.session`, which the popup listens to (`popup.ts:223`). Storage is the message bus, and it also survives a worker restart.

### What disconnect cleans up (`background.ts:197-209`)

`releaseAll()` removes overlays and detaches the debugger from every tab; `endSession()` forgets the download watermark. A network drop does not run this path: the debugger stays attached to the tabs it was driving, and the reconnect reuses those attachments. If the worker itself was restarted, its attach bookkeeping is gone, and the next call takes the "already attached" branch in `cdp.ts` (detach, then attach again).

### On the relay when the socket drops

`failAllPending()` rejects every in-flight call with `NO_EXTENSION: Browser disconnected mid-call` (`relay.ts:205-209`), so clients get an immediate error instead of waiting 90s.

### Waking the browser (`relay.ts:135-161`)

If `BROWSER_LAUNCH` is set and no extension is connected, `wakeBrowser()` spawns the command detached and waits up to 20s for a hello. The promise is stored in `waking` and shared (`waking ??= ...`), so ten calls arriving together trigger one launch.

## Error flow

```text
extension: throw new ToolError('STALE_REF', 'Element ref_7 not found...')
        -> toErrorBody() -> {code, message}                       errors.ts:14-20
        -> {type:"result", ok:false, error}
relay:  settle() -> reject(new ExtensionError(body, fromBrowser=true))
        -> CallTool handler catches -> {isError:true, text:"Error: <fenced message>"}
```

Errors that came from the browser are fenced too, because they can quote page content such as URLs or script exceptions (`relay.ts:455-458`). Errors raised by the relay itself (no extension, blocked upload) are not fenced, since the relay wrote them.

Error messages are written **for the model**: they say what happened and what to do next ("get fresh refs with read_page or find", "This call was not run; retry it"). That is a deliberate interface choice, since the reader is an LLM that will act on the text.
