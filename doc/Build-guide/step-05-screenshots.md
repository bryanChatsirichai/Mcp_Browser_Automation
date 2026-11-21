# Step 5: Screenshots and the coordinate frame

**Goal.** The model can see a tab, at a size that fits its image budget, in a coordinate system that step 6 can click in.

**Builds on.** Step 4.

## Files

```text
extension/src/frame.ts      frame size, frame-to-CSS conversion: pure, no chrome   (new)
extension/src/capture.ts    view of a tab, viewport capture, region capture        (new)
extension/src/snapshot.ts   evaluate                                               (new; grows in step 7)
extension/src/protocol.ts   + screenshot arguments
extension/src/tools.ts      + screenshot handler
relay/tools.ts              + screenshot
test/frame.test.ts                                                                 (new)
```

## Sub-tasks

**5.1 `evaluate(target, expression)`.** A helper for running a JavaScript expression in the page and getting its value back. Send `Runtime.evaluate` with:

| Parameter | Value | Why |
|---|---|---|
| `returnByValue` | true | Get the value as JSON, not a remote object handle |
| `awaitPromise` | true | An expression that returns a promise is awaited |
| `userGesture` | true | The page treats it as user-initiated (needed for some APIs, such as clipboard or fullscreen) |

If the response has `exceptionDetails`, throw `ToolError` code `JS_ERROR` with the first line of the exception text. Otherwise return the value.

**5.2 The frame.** Three pixel spaces exist. The model only ever deals with the third.

```text
 device px  = CSS px x devicePixelRatio      what the screen has
 CSS px                                      what CDP input events use
 frame px   = CSS px x ratio                 what the model sees and sends
```

The **frame** is the viewport scaled so its longer edge is at most **1,568 pixels**, a size vision models handle without further downscaling. The ratio is 1,568 divided by the longer CSS edge, capped at 1 (small viewports are never enlarged).

Worked example: a 1920 x 1080 CSS viewport has ratio 1568 / 1920 = 0.8167, so the frame is 1568 x 882.

Put this arithmetic in `frame.ts`, which imports nothing but `errors.ts`, so a test can load it. It holds two functions:

- **frame of** (CSS width, CSS height) → ratio, frame width, frame height (rounded).
- **to CSS** (view, frame point) → CSS point: divide each coordinate by the ratio. Throw `BAD_ARGS` if the point is outside the frame, and say what the frame's size is.

**5.3 The view of a tab.** Collect, for a tab: the CSS viewport width and height and the device pixel ratio (read `innerWidth`, `innerHeight` and `devicePixelRatio` with `evaluate`); the page's scroll position (`cssVisualViewport.pageX` and `pageY` from `Page.getLayoutMetrics`); and the frame from 5.2. Call this the tab's **view**.

**5.4 Capture the viewport** (view, scale from 0.1 to 1, default 1). Send `Page.captureScreenshot` as JPEG at quality 80, with a clip covering the visible viewport (at the scroll position, CSS size). The clip's `scale` is in **device pixels per CSS pixel**, so to get frame pixels set it to the ratio times the requested scale, divided by the device pixel ratio.

Worked example: ratio 0.8167, scale 1, device pixel ratio 2 → clip scale 0.408. The image comes out at 1568 x 882, not 3136 x 1764.

**5.5 Capture a region (zoom)** (view, region as frame coordinates x0, y0, x1, y1, scale). Convert the region from frame to CSS pixels (divide by the ratio). Refuse an empty rectangle with `BAD_ARGS`. Capture it as PNG at **device** resolution, which is sharper than the frame, but scaled down if needed so that its longer edge stays within 1,568 pixels. In other words, the clip scale is the smaller of the requested scale and 1,568 divided by (the region's longer CSS edge times the device pixel ratio).

**5.6 The `screenshot` tool.** Arguments: `tabId`; optional `region` (four numbers, for a zoom); optional `scale` from 0.1 to 1. Return two content parts:

- a text part stating the image size and, when the scale is below 1, the full frame size, with a reminder that coordinates are always given in the full frame;
- an image part: type `image`, the base64 data, and its MIME type.

**5.7 Tests.** For "frame of": a viewport at or under 1,568 has ratio 1; 1920 x 1080 gives 1568 x 882; a tall viewport is limited by its height. For "to CSS" (step 6 needs it): frame point (784, 441) on a 1920 x 1080 viewport gives CSS (960, 540); a point outside the frame throws.

## Interfaces

| Name | Where | Shape |
|---|---|---|
| View | `capture.ts` | CSS width and height, device pixel ratio, page scroll x and y, ratio (frame px per CSS px), frame width and height |
| view of | `capture.ts` | tab id → view |
| capture viewport | `capture.ts` | tab id, view, optional scale → image data, MIME type, width, height |
| capture region | `capture.ts` | tab id, view, region, optional scale → the same |
| frame of | `frame.ts` | CSS width, CSS height → ratio, width, height |
| to CSS | `frame.ts` | view, frame point → CSS point, or throws `BAD_ARGS` |

## Done when

- `[auto]` `npm run check`, `npm test` pass (frame tests included).
- `[browser]` A `screenshot` of `example.com` returns an image whose longer edge is at most 1,568 pixels, and the text reports the same dimensions.
- `[browser]` On a HiDPI display the image is not twice the frame size.
- `[browser]` `screenshot` with a `region` around the page heading returns a sharper, magnified crop.
- `[browser]` `screenshot` with `scale: 0.5` returns an image half the width, and the text still states the full frame size.
- `[browser]` A screenshot of a tab that is not the active tab in its window is not blank.

## Pitfalls

- **Getting the clip scale wrong** produces images that are right on a normal display and double-sized on HiDPI. Test on both if you can.
- **The first screenshot after attach can have the wrong size** if you skip the 400-millisecond settle from step 4: the debugging bar shrinks the viewport.
- **Images are not fenced.** Text inside a screenshot reaches the model unlabelled. Record this as a known limit.

## Carry forward

- The model reads and writes frame pixels only. Every tool that takes a coordinate converts it with "to CSS" and never accepts CSS or device pixels.
- Step 13 wraps the captures so the on-page overlay is hidden while they run.
