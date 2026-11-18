# 6. Side features: inspect, record, files, overlay

These four modules are independent of each other. Each plugs into `cdp.ts` through `onAttach` and `onEvent` rather than being called by it.

## `inspect`: console, network, errors, cookies, storage (`inspect.ts`)

### Passive recording

On every attach, `inspect.ts` enables the `Network` and `Log` domains (`inspect.ts:129-131`). Its `onEvent` listener then files events into three per-tab ring buffers of 500 entries each (`inspect.ts:34-53`):

| CDP event | Buffer | Notes |
|---|---|---|
| `Runtime.consoleAPICalled` | `console` (+ `errors` if level is error) | Arguments rendered to text, 1,000 characters max |
| `Log.entryAdded` | `console` (+ `errors`) | Browser-generated messages (CSP, network) |
| `Runtime.exceptionThrown` | `errors` | With URL and line |
| `Network.requestWillBeSent` | `network` | Creates the entry; remembers the `sessionId` |
| `Network.responseReceived` | `network` | Adds status, MIME, declared size |
| `Network.loadingFinished` / `loadingFailed` | `network` | Adds transferred size or error text |

```text
 CDP events, per tab, from every session        ring buffers (500 entries each)       inspect {mode}

 Runtime.consoleAPICalled  ------------------>  console  ---------------------------> "console"
 Log.entryAdded            ------------------>  console
        (level "error" is also copied) ------>  errors   ---------------------------> "errors"
 Runtime.exceptionThrown   ------------------>  errors
 Page.javascriptDialogOpening -- accept it -->  console  (level "dialog")

 Network.requestWillBeSent ------------------>  network  (new entry) ---------------> "network"
 Network.responseReceived  ------------------>  network  (+ status, mime)               filter by url,
 Network.loadingFinished   ------------------>  network  (+ size)                       method, status
 Network.loadingFailed     ------------------>  network  (+ error)

 Asked live, not buffered:   network + bodyOf -> Network.getResponseBody
                             "cookies"        -> Network.getCookies
                             "storage"        -> a function run in the page
```

Because recording starts at attach, a tab used for the first time has an empty history. The tool adds a note telling the model to reload the tab to capture its page load (`inspect.ts:224`).

Buffers are deleted when the tab closes. They live in worker memory, so a worker restart also empties them.

### Queries

- `console` / `errors`: newest N entries (default 50) with `total` and `truncated`.
- `network`: filter by URL substring, method, status. The list is metadata only.
- `network` + `bodyOf: <requestId>`: one response body through `Network.getResponseBody`, sent to the **session that saw the request** (the reason `sessionId` is stored), capped at 25,000 characters.
- `cookies`: `Network.getCookies` for the tab URL, including `httpOnly` cookies, values cut to 200 characters.
- `storage`: `localStorage` and `sessionStorage` read by a page function, values cut to 500 characters.

This two-step design (cheap list, then fetch one body by id) keeps token use low.

### Dialogs are handled here

An open `alert`, `confirm` or `prompt` freezes the page and every later CDP call. On `Page.javascriptDialogOpening` the module accepts it at once and writes a `dialog` entry to the console buffer so the model can see what happened (`inspect.ts:89-95`). The consequence is that every `confirm()` is answered "OK".

## `record`: video of a tab (`record.ts` + `offscreen.ts`)

### Why two contexts

Encoding video needs `MediaRecorder`, which needs a DOM. A service worker has none. Manifest V3's answer is an **offscreen document**: an invisible page the extension creates on demand (`record.ts:36-46`).

```text
 page  --Page.screencastFrame (JPEG)-->  service worker  --runtime.sendMessage-->  offscreen document
                                         record.ts                                 offscreen.ts
                                         throttle to fps                           JPEG -> canvas -> VideoFrame
                                                                                   -> MediaStreamTrackGenerator
                                                                                   -> MediaRecorder (VP8 WebM)
                                                                                   -> PUT /upload on the relay
```

### Service worker side (`record.ts`)

- `start`: opens the offscreen document, sends `start`, then `Page.startScreencast` capped at the CSS viewport size so a HiDPI screen does not quadruple the video (`record.ts:135-143`).
- Each `Page.screencastFrame` is acknowledged immediately (CDP stops sending otherwise).
- **Throttle that keeps the last frame.** The screencast can outrun the requested fps. Instead of dropping frames that arrive too early, the newest one is held on a timer and sent when its slot opens. A newer frame replaces the held one. So the final state always lands in the video (`record.ts:58-68`).
  ```text
  fps = 2, so one frame may be forwarded every 500 ms

  time (ms)           0        300   380   450   500                 1200
  screencast frame    A         B     C     D                          E
  forwarded           A                           D                    E

  B arrives too early and is held. C replaces B. D replaces C.
  At 500 ms the slot opens and the newest held frame, D, is sent.
  ```
- `maxSeconds` (default 60, max 300) starts a timer that finishes the recording by itself. The result is kept in `finishing`, so a later `stop` call returns the already-finished file (`record.ts:155-166`).
- Only one recording at a time (module-level `recording`).

### Offscreen side (`offscreen.ts`)

- The first frame fixes the canvas size, rounded down to even numbers because encoders require it (`bitmap.width & ~1`).
- Frames are drawn to an `OffscreenCanvas`, wrapped in a `VideoFrame` with a real timestamp, and written to a `MediaStreamTrackGenerator` (a Chrome-only API, declared by hand at `offscreen.ts:11-15`).
- **Promise queue for ordering.** JPEG decoding is async, so frames are chained on a queue to keep them in order (`offscreen.ts:30-31`).
- **Keepalive.** A screencast emits nothing while the page is still. A 1s interval re-writes the last frame so the video keeps its real duration (`offscreen.ts:79-83`).
- `stop`: drain the queue, write a closing frame, wait 200ms for the encoder, stop the recorder, and upload the blob to the relay **directly from the offscreen document**. The video never travels over the WebSocket.
- The message listener returns `true` to keep the response channel open for the async `stop` reply (`offscreen.ts:134-135`).

### The whole recording, start to stop

```text
 model            service worker (record.ts)          offscreen document            relay
   |                       |                                  |                       |
   |-- record start ------>| create offscreen document ------>|                       |
   |                       |-- {cmd: start, fps} ------------>| new track + writer    |
   |                       | Page.startScreencast             |                       |
   |<-- {recording: true} -|                                  |                       |
   |                       |<== Page.screencastFrame (JPEG)   |                       |
   |   (the model keeps    | ack, throttle to fps             |                       |
   |    clicking and       |-- {cmd: frame, data} ----------->| decode, draw, encode  |
   |    typing meanwhile)  |            ... repeats ...       | every 1s: repeat the  |
   |                       |                                  | last frame            |
   |-- record stop ------->| Page.stopScreencast              |                       |
   |                       |-- {cmd: stop, relay, name} ----->| finish the WebM       |
   |                       |                                  |-- PUT /upload ------->|
   |                       |<-- {ok, file: {url,name,size}} --|<-- {url, name, size} -|
   |                       | close offscreen document         |                       |
   |<-- {url, seconds} ----|                                  |                       |
```

### `frames` action

A simpler alternative: N screenshots (max 20) at a fixed interval, each uploaded, total span capped at 60s (`record.ts:168-186`).

## `files`: downloads and PDF (`files.ts`)

| Action | How |
|---|---|
| `download` | `chrome.downloads.download`, so the request carries the browser's cookies. Waits for `complete` or `interrupted` (80s). |
| `downloads_list` | `chrome.downloads.search` limited to this session |
| `pdf` | `Page.printToPDF` with backgrounds, uploaded to the relay as `<title>.pdf` |
| `path` (internal) | Returns the on-disk path of a download so the relay can serve it |

Results carry a relay URL: `/files/dl/<id>` for downloads (served from the browser's download folder), `/files/<id>/<name>` for PDFs.

### The session watermark

`markSession()` stores `downloadsSince = Date.now()` in `storage.session` when the relay sends `ready`, only if not already set (`files.ts:15-19`). Every lookup rejects downloads that started before it. So the agent can list and fetch only what was downloaded since it connected, never the user's earlier downloads. The mark survives worker restarts and reconnects, and is cleared on an explicit disconnect.

```text
 time ----------------------------------------------------------------------------------------->

   user's own downloads        | "ready" from the relay            explicit Disconnect |
   report.pdf, taxes.xlsx      | downloadsSince = now               mark removed       |
                               |                                                       |
   never listed, never served  |  listed by downloads_list, served at /files/dl/<id>   |
                               |  (also across worker restarts and reconnects)         |
```

### Redirect check after the fact

The URL is policy-checked before the download starts, but a redirect can leave the allowed sites. After completion `item.finalUrl` is checked again; on failure the download is cancelled, the file removed and the record erased (`files.ts:96-105`).

## `upload.ts`

Thirty lines shared by the service worker and the offscreen document: `uploadFile()` does `fetch(PUT /upload/<name>)` with the Bearer token when one is set, and `base64ToBlob()` converts CDP's base64 payloads.

Large binary data (video, PDF, saved screenshots) takes this HTTP side channel and only the resulting URL goes back through the WebSocket. Plain screenshots are the exception: they travel inline as base64 image content, because the model needs to see them.

## `overlay.ts`: showing the user what the agent is doing

When a tab is being driven, the page shows a pulsing yellow border, a fake cursor that follows the injected mouse events, and a ripple on each click. It is purely visual feedback for the human.

### How it is built

- One self-contained function, `overlayPage(cmd)`, injected as a string through `Runtime.evaluate` (`overlay.ts:171-177`).
- It keeps its state on `window` under `Symbol.for('browser-bridge.overlay')`, so repeated injections update the same overlay instead of stacking new ones.
- The UI lives in a **closed shadow root** on a host element with `all: initial` and maximum `z-index`, so page CSS cannot restyle it and it cannot leak styles into the page.
- **Everything is created through DOM and CSSOM calls** (`createElement`, `CSSStyleSheet.replaceSync`, `adoptedStyleSheets`), never `innerHTML` or inline `<style>`, because a page's Content Security Policy and Trusted Types would block those (`overlay.ts:17-19`).
- `pointer-events: none` everywhere, so it never intercepts a click.
- It runs only in the top frame (`window !== window.top` returns early).
- If a page rewrites `<html>` and drops the host, the next render re-attaches it.

### Lifecycle

| Function | When | Effect |
|---|---|---|
| `activate(tabId)` | Before every tool call with a tab | Shows the glow; (re)starts a 5s idle timer that hides it |
| `show()` | First activation, and after every re-attach | Registers the script with `Page.addScriptToEvaluateOnNewDocument` so the glow survives navigations, and applies it to the current document |
| `cursor(tabId, point, press)` | From `input.ts` after each mouse event | Moves the fake cursor; ripple on press |
| `hidden(tabId, work)` | Around every screenshot | Sets `mute`, runs the capture, restores. Keeps the overlay out of the image the model sees. |
| `clearAll()` | On disconnect | Hides everything |

```text
                 activate(tab)                              5s with no tool call
    hidden  ------------------------>  glowing  ------------------------------------>  hidden
                                        |    ^                                    (script unregistered)
                    a screenshot starts |    | the screenshot is done
                                        v    |
                                        muted
                              (display: none, state kept)

    While glowing:  each mouse event moves the fake cursor; a press adds a ripple.
                    each new document gets the glow again (registered script).
```

`hidden()` is a small but important piece of correctness: without it the model would see the border and fake cursor in its screenshots.
