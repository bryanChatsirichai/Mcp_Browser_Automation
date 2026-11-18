# Step 13: Recording and the on-page overlay

**Goal.** The agent can record a tab as a WebM video, and the user can see at a glance which tab is being driven and where the agent is clicking.

**Builds on.** Step 9 (`PUT /upload`), step 6 (`mouse()`), step 5 (captures). The two halves of this step are independent; do either first.

## Files

```text
extension/src/record.ts     start, stop, frames                      (new)
extension/src/offscreen.ts  WebM encoder                             (new)
extension/offscreen.html    loads dist/offscreen.js                  (new)
extension/src/overlay.ts    glow, cursor, hidden()                   (new)
extension/src/input.ts      mouse() calls cursor()
extension/src/capture.ts    captures run inside hidden()
extension/src/tools.ts      activate() in runOne; clearAll() in releaseAll; record handler
extension/manifest.json     + "offscreen"
tools.ts                    + record
```

## Part A: recording

A service worker has no DOM, and `MediaRecorder` needs one. An offscreen document provides it.

```text
 page --Page.screencastFrame--> service worker --runtime.sendMessage--> offscreen document --PUT /upload--> relay
        (JPEG, base64)          ack, throttle                           decode, draw, encode
```

**13.1 Offscreen document lifecycle.** `openOffscreen()`: return if `chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })` finds one, else `chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS'], justification })`. Close it when the recording ends or fails to start.

**13.2 Messages.** A typed union: `{ to: 'offscreen', cmd: 'start', fps }`, `{ ..., cmd: 'frame', data }`, `{ ..., cmd: 'stop', relay, name }`. The offscreen listener ignores anything without `to: 'offscreen'` and **returns `true`** so the reply channel stays open for the asynchronous `stop`.

**13.3 `start`.** Refuse if a recording exists (`ALREADY_RECORDING`). Clamp `fps` to 1..30 (default 10) and `maxSeconds` to 1..300 (default 60). Open the offscreen document, send `start`, then `Page.startScreencast { format: 'jpeg', quality: 70, maxWidth, maxHeight }` with the CSS viewport size from `Page.getLayoutMetrics`, so a HiDPI screen does not quadruple the video. If starting the screencast throws, undo everything.

**13.4 Frame handling in the worker.** In an `onEvent` listener for `Page.screencastFrame` on the root session:

1. Always send `Page.screencastFrameAck`; the screencast stalls without it.
2. Throttle without losing the last frame:

```ts
const wait = active.lastFrameAt + 1000 / active.fps - Date.now();
clearTimeout(active.held);
if (wait > 0) active.held = setTimeout(() => forward(active, frame.data), wait);     // newest frame waits for its slot
else forward(active, frame.data);
```

**13.5 Encoding in the offscreen document.**

- Decode with `createImageBitmap(blob)`. The first frame fixes an `OffscreenCanvas` size, rounded down to even numbers (`width & ~1`).
- Draw, wrap the canvas in a `VideoFrame` with a real timestamp, write it to the writer of a `MediaStreamTrackGenerator({ kind: 'video' })` (a Chrome-only API you must declare yourself for TypeScript).
- Create the `MediaRecorder` on that track after the first frame: `video/webm;codecs=vp8`, collecting chunks every second.
- Chain every frame on a promise queue so asynchronous decoding cannot reorder them.
- A 1s interval re-writes the last frame: the screencast is silent while the page is still, and the video must keep its real length.

**13.6 `stop`.** Stop the screencast; tell the offscreen document to stop: drain the queue, write a closing frame, wait 200ms, stop the recorder, then `uploadFile` the blob **from the offscreen document** and reply `{ ok, file }`. No frames at all: reply an error ("The tab produced no frames").

**13.7 Auto-stop.** A timer at `maxSeconds` finishes the recording and keeps the resulting promise. A later `stop` call returns that result instead of "not recording".

**13.8 `frames`.** A simpler action: N screenshots (max 20) at an interval, each uploaded, total span capped at 60s.

## Part B: overlay

**13.9 One self-contained page function**, `overlayPage(cmd)`, injected as `` `(${overlayPage.toString()})(${JSON.stringify(cmd)})` `` through `Runtime.evaluate`. `cmd` is `{ glow?, mute?, x?, y?, press? }`.

- Return at once unless `window === window.top`.
- Keep state on `window` under `Symbol.for('<your-name>.overlay')`, so repeated injections update one overlay.
- Build a host `<div>` with a **closed shadow root**; style with `new CSSStyleSheet()` + `replaceSync` + `adoptedStyleSheets`; create nodes with `createElement`. Never use `innerHTML` or an inline `<style>`: page Content Security Policy and Trusted Types block them.
- Host style: `all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647`.
- If the host is no longer connected (the page rewrote `<html>`), append it again.

**13.10 Lifecycle in the worker.**

| Function | Called from | Does |
|---|---|---|
| `activate(tabId)` | `runOne`, for every call with a tab | Shows the glow; restarts a 5s idle timer that hides it |
| `show(tabId)` | first activation; the `onAttach` hook | `Page.addScriptToEvaluateOnNewDocument` so the glow survives navigations, then apply to the current document |
| `cursor(tabId, point, press)` | `mouse()` in `input.ts` | Moves the fake cursor; ripple on press |
| `hidden(tabId, work)` | `captureViewport`, `captureRegion` | Mute, run the capture, unmute in `finally` |
| `clearAll()` | `releaseAll` on disconnect | Hide everywhere |

Every overlay command is fire-and-forget with a swallowed error: the overlay must never fail a tool call.

Reference: `record.ts`, `offscreen.ts`, `offscreen.html`, `overlay.ts`, `capture.ts:50-64`, `input.ts:150`.

## Done when

- `[auto]` `npm run check`, `npm test` pass.
- `[browser]` `record start`, a few clicks and scrolls, `record stop`: the returned URL plays a WebM whose length matches the reported `seconds` and whose last frame shows the final page state.
- `[browser]` Recording a page that does not change for 5 seconds yields a video about 5 seconds long, not a fraction of a second.
- `[browser]` `record start {maxSeconds: 3}`, wait 5s, `record stop` returns the file with `autoStopped: true`.
- `[browser]` A second `record start` during a recording returns `ALREADY_RECORDING`.
- `[browser]` `record frames {count: 3}` returns three image URLs.
- `[browser]` While tools run on a tab, it shows the border and a cursor that follows clicks; 5s after the last call both disappear.
- `[browser]` The border and cursor **do not appear in screenshots** returned to the model.
- `[browser]` The overlay appears on a site with a strict Content Security Policy, and survives a navigation.
- `[browser]` Clicks still reach elements under the overlay.

## Pitfalls

- **Dropping early frames instead of holding the newest** loses the final state: the last thing that happened is exactly what the viewer wants to see.
- **Sending the video back through `runtime.sendMessage` or the WebSocket** is slow and can exceed message limits. Upload from the offscreen document.
- **Forgetting `hidden()`** puts a yellow border and a fake cursor into every image the model reasons about.
- **Only one recording exists**, held in a worker variable. A worker restart mid-recording loses it. Accept that or persist enough to report it.

## Carry forward

- `activate()` runs for every tool call with a tab; step 14's checklist verifies it never throws.
