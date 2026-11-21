# Step 13: Recording and the on-page overlay

**Goal.** The agent can record a tab as a WebM video, and the user can see at a glance which tab is being driven and where the agent is clicking.

**Builds on.** Step 9 (`PUT /upload`), step 6 (the mouse primitive), step 5 (captures). The two halves of this step are independent; do either first.

## Files

```text
extension/src/record.ts     start, stop, frames                      (new)
extension/src/offscreen.ts  WebM encoder                             (new)
extension/offscreen.html    loads dist/offscreen.js                  (new)
extension/src/overlay.ts    glow, cursor, hide during capture        (new)
extension/src/input.ts      the mouse primitive moves the cursor
extension/src/capture.ts    captures run with the overlay hidden
extension/src/tools.ts      activate the overlay in runOne; clear it on release; record handler
extension/manifest.json     + "offscreen"
relay/tools.ts              + record
```

## Part A: recording

A service worker has no DOM, and the browser's `MediaRecorder` needs one. An **offscreen document** (a hidden extension page, `chrome.offscreen`) provides it.

```text
 page --Page.screencastFrame--> service worker --runtime message--> offscreen document --PUT /upload--> relay
        (JPEG, base64)          ack, throttle                       decode, draw, encode
```

**13.1 Offscreen document lifecycle.** To open it: if `chrome.runtime.getContexts` already finds an offscreen document, use it; otherwise create one from `offscreen.html` with the reason `BLOBS` and a one-line justification. Close it when a recording ends or fails to start.

**13.2 Messages.** Define a small set of messages, each tagged `to: "offscreen"`: `start` (with the frame rate), `frame` (with the base64 JPEG), and `stop` (with the relay settings and a file name). The offscreen document's message listener ignores anything not addressed to it, and **returns true** from the listener so that Chrome keeps the reply channel open while the asynchronous `stop` finishes.

**13.3 Start.**

1. Refuse if a recording already exists: `ALREADY_RECORDING`.
2. Clamp the frame rate to 1 to 30 (default 10) and the maximum length to 1 to 300 seconds (default 60).
3. Open the offscreen document and send it `start`.
4. Start `Page.startScreencast` as JPEG at quality 70, with the maximum width and height set to the **CSS** viewport size (from `Page.getLayoutMetrics`). Otherwise a HiDPI screen quadruples the video's pixel count.
5. If starting the screencast throws, undo everything: close the document and clear the recording.

**13.4 Frame handling in the worker.** In an on-event listener for `Page.screencastFrame` on the root session:

1. Always acknowledge the frame with `Page.screencastFrameAck`. Chrome stops sending frames until it is acknowledged.
2. Throttle to the frame rate **without losing the newest frame**. Work out when the next frame is due (the time of the last forwarded frame plus one interval). Cancel any frame currently held back. If the slot is in the future, hold this frame and forward it when the slot arrives; otherwise forward it now. A burst of frames then ends with its last frame delivered, not dropped.

**13.5 Encoding in the offscreen document.**

- Decode each JPEG into an image bitmap. The first frame fixes the size of an offscreen canvas, rounded down to even numbers (video encoders need even dimensions).
- Draw the bitmap on the canvas, wrap the canvas in a `VideoFrame` with a real timestamp, and write it into a `MediaStreamTrackGenerator` of kind video. This is a Chrome-only API; TypeScript's DOM types do not include it, so declare its shape yourself.
- After the first frame, create a `MediaRecorder` on the generator's track, as `video/webm;codecs=vp8`, collecting data every second.
- Process frames one after another through a promise chain, so asynchronous decoding cannot reorder them.
- Every second, write the last frame again. The screencast sends nothing while the page is still, and without repeats the video would be shorter than the real time.

**13.6 Stop.** Stop the screencast. Tell the offscreen document to stop: it finishes the queued frames, writes one closing frame, waits 200 ms, stops the recorder, and then **uploads the video itself** to the relay (step 9) and replies with the file details. If there were no frames at all, reply with an error: "The tab produced no frames".

**13.7 Auto-stop.** A timer at the maximum length finishes the recording and keeps the result. A later `stop` call returns that kept result (marked as auto-stopped) instead of "not recording".

**13.8 Frames.** A simpler action, `record` with action `frames`: take N screenshots (at most 20) at an interval, uploading each, with the total span capped at 60 seconds. Return their URLs.

## Part B: overlay

**13.9 One self-contained page function** draws everything. Inject it with `Runtime.evaluate` as an immediately-called function, with its command passed as a JSON argument. The command can set: glow on or off, muted (hidden for a capture), a cursor position, and a press (for a click ripple).

The function must:

- do nothing unless it runs in the top window (not inside an iframe);
- keep its state on `window` under a global symbol (`Symbol.for` with a name unique to your project), so repeated injections update one overlay instead of stacking new ones;
- build a host `<div>` with a **closed shadow root**, style it with a constructed stylesheet (`new CSSStyleSheet()` plus adopted stylesheets), and create nodes with `createElement`. Never use `innerHTML` or an inline `<style>` element: a page's Content Security Policy and Trusted Types block them;
- give the host these styles: reset all inherited styles, fixed position covering the whole viewport, **no pointer events** (so clicks pass through), and the highest z-index;
- re-append the host if it is no longer in the document (some pages rewrite `<html>`).

**13.10 Lifecycle in the worker.**

| Function | Called from | Does |
|---|---|---|
| activate | `runOne`, for every call that has a tab | Shows the glow; restarts a 5-second idle timer that hides it |
| show | The first activation on a tab; the on-attach hook | Registers the overlay with `Page.addScriptToEvaluateOnNewDocument` so it survives navigation, then applies it to the current document |
| cursor | The mouse primitive (step 6) | Moves the drawn cursor; shows a ripple on press |
| hidden | Both capture functions (step 5) | Mutes the overlay, runs the capture, and unmutes in a `finally` |
| clear all | Release on disconnect | Hides the overlay on every tab |

Every overlay command is fire-and-forget with its error swallowed: the overlay must never fail a tool call.

## Done when

- `[auto]` `npm run check`, `npm test` pass.
- `[browser]` `record start`, a few clicks and scrolls, `record stop`: the returned URL plays a WebM whose length matches the reported seconds and whose last frame shows the final page state.
- `[browser]` Recording a page that does not change for 5 seconds yields a video about 5 seconds long, not a fraction of a second.
- `[browser]` `record start {maxSeconds: 3}`, wait 5 seconds, `record stop` returns the file marked as auto-stopped.
- `[browser]` A second `record start` during a recording returns `ALREADY_RECORDING`.
- `[browser]` `record frames {count: 3}` returns three image URLs.
- `[browser]` While tools run on a tab, it shows the border glow and a cursor that follows clicks; 5 seconds after the last call both disappear.
- `[browser]` The glow and cursor **do not appear in screenshots** returned to the model.
- `[browser]` The overlay appears on a site with a strict Content Security Policy, and survives a navigation.
- `[browser]` Clicks still reach elements under the overlay.

## Pitfalls

- **Dropping late frames instead of holding the newest** loses the final state, which is exactly what the viewer wants to see.
- **Sending the video back through runtime messages or the WebSocket** is slow and can exceed message size limits. Upload from the offscreen document.
- **Forgetting to hide the overlay during captures** puts a border and a fake cursor into every image the model reasons about.
- **Only one recording exists**, held in a worker variable. A worker restart mid-recording loses it. Accept that, or persist enough to report it.

## Carry forward

- The overlay is activated on every tool call with a tab; step 14's checklist verifies it never makes a call fail.
