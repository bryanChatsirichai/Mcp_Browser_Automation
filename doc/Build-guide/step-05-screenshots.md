# Step 5: Screenshots and the coordinate frame

**Goal.** The model can see a tab, at a size that fits its image budget, in a coordinate system that step 6 can click in.

**Builds on.** Step 4.

## Files

```text
extension/src/frame.ts      frameOf, toCss: pure, no chrome                 (new)
extension/src/capture.ts    View, viewOf, captureViewport, captureRegion    (new)
extension/src/snapshot.ts   evaluate()                                      (new; grows in step 7)
extension/src/protocol.ts   + ScreenshotArgs
extension/src/tools.ts      + screenshot handler
tools.ts                    + screenshot
test/frame.test.ts                                                          (new)
```

## Sub-tasks

**5.1 `evaluate()`.** The helper for running an expression in the page.

```ts
export async function evaluate<T>(target: Target, expression: string): Promise<T> {
  const { result, exceptionDetails } = await send(target, 'Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true, userGesture: true,
  });
  if (exceptionDetails) throw new ToolError('JS_ERROR', firstLineOf(exceptionDetails));
  return result.value as T;
}
```

**5.2 The frame.** Three pixel spaces exist; the model only ever deals with the third.

```text
 device px  = CSS px x devicePixelRatio      what the screen has
 CSS px                                      what CDP input events use
 frame px   = CSS px x ratio                 what the model sees and sends
```

Put the arithmetic in `frame.ts`, which imports nothing but `errors.ts`, so a test can load it:

```ts
const MAX_EDGE = 1_568;

// frameOf(1920, 1080) -> { ratio: 0.8167, width: 1568, height: 882 }
export function frameOf(cssWidth: number, cssHeight: number) {
  const ratio = Math.min(1, MAX_EDGE / Math.max(cssWidth, cssHeight));
  return { ratio, width: Math.round(cssWidth * ratio), height: Math.round(cssHeight * ratio) };
}
```

`viewOf(tabId)` reads `[innerWidth, innerHeight, devicePixelRatio]` with `evaluate`, reads `cssVisualViewport.pageX/pageY` from `Page.getLayoutMetrics`, and returns a `View`.

**5.3 `captureViewport(tabId, view, scale = 1)`.** `Page.captureScreenshot` as JPEG quality 80 with a clip of the visible viewport. The clip `scale` is `(view.ratio * scale) / view.dpr`, because a clip scale of 1 means device pixels.

**5.4 `captureRegion(tabId, view, [x0, y0, x1, y1], scale = 1)`**, the zoom. Convert the region from frame to CSS pixels (divide by `ratio`), reject an empty rectangle, and capture as PNG at device resolution, scaled down only so the longer edge stays within `MAX_EDGE`:

```ts
const factor = Math.min(scale, MAX_EDGE / (Math.max(width, height) * view.dpr));
```

**5.5 The `screenshot` tool.** Arguments: `tabId`, optional `region` (zoom), optional `scale` in 0.1 to 1. Return a text part and an image part:

- the text states the image size and, when `scale < 1`, the full frame size, with a reminder that coordinates are always in the full frame;
- the image is `{ type: 'image', data: <base64>, mimeType }`.

**5.6 Tests.** `frameOf`: a viewport at or under 1568 has ratio 1; 1920x1080 gives 1568x882; a tall viewport is limited by height. Add `toCss` now (step 6 needs it): frame `[784, 441]` on 1920x1080 gives CSS `(960, 540)`; a point outside the frame throws.

Reference: `capture.ts`, `computer.ts:41-117`, `snapshot.ts:66-78`.

## Contracts

```ts
// capture.ts
export interface View {
  cssWidth: number; cssHeight: number; dpr: number; pageX: number; pageY: number;
  ratio: number;          // frame px per CSS px
  width: number; height: number;      // the frame
}
export function viewOf(tabId: number): Promise<View>;
export function captureViewport(tabId: number, view: View, scale?: number): Promise<Shot>;
export function captureRegion(tabId: number, view: View, region: [number, number, number, number], scale?: number): Promise<Shot>;

// frame.ts
export function frameOf(cssWidth: number, cssHeight: number): { ratio: number; width: number; height: number };
export function toCss(view: View, point: [number, number]): { x: number; y: number };   // throws BAD_ARGS outside the frame
```

## Done when

- `[auto]` `npm run check`, `npm test` pass (frame tests included).
- `[browser]` `screenshot` of `example.com` returns an image whose longer edge is at most 1568 pixels, and the text reports the same dimensions.
- `[browser]` On a HiDPI display the image is not 2x the frame size.
- `[browser]` `screenshot` with `region` around the page heading returns a sharper, magnified crop.
- `[browser]` `screenshot` with `scale: 0.5` returns an image half the width, and the text still states the full frame size.
- `[browser]` A screenshot of a tab that is not the active tab in its window is not blank.

## Pitfalls

- **Getting clip scale wrong** produces images that are right on a normal display and double-sized on HiDPI. Test on both if you can.
- **The first screenshot after attach can have the wrong size** if you skip the 400ms settle from step 4: the debugging bar shrinks the viewport.
- **Images are not fenced.** Text inside a screenshot reaches the model unlabelled. Record this as a known limit.

## Carry forward

- The model reads and writes frame pixels only. Every tool that takes a coordinate converts with `toCss` and never accepts CSS or device pixels.
- Step 13 wraps captures so the overlay is hidden while they run.
