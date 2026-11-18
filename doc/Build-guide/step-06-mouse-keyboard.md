# Step 6: Mouse and keyboard

**Goal.** The model can click, hover, drag, scroll, type and press keys, with events the page cannot tell from a real user's. After this step an agent can operate a website by screenshot alone.

**Builds on.** Step 5.

## Files

```text
extension/src/keys.ts       modifierBits, keyInfo, splitChord: pure (new)
extension/src/input.ts      mouse, keyboard, settle                 (new)
extension/src/protocol.ts   + ClickArgs, TypeTextArgs, PressKeyArgs, ScrollArgs
extension/src/tools.ts      + click, type_text, press_key, scroll handlers
tools.ts                    + the four tools
test/keys.test.ts                                                   (new)
```

## Sub-tasks

**6.1 One mouse primitive.**

```ts
async function mouse(tabId, type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', point,
                     button: 'none' | 'left' | 'right' = 'none', clickCount = 0, modifiers = 0) {
  const buttons = button === 'left' && type !== 'mouseReleased' ? 1 : 0;
  await send({ tabId }, 'Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button, buttons, clickCount, modifiers });
}
```

**6.2 Gestures built from it.**

| Gesture | Sequence |
|---|---|
| click (count 1, 2, 3; left or right) | moved, then pressed + released once per count with `clickCount` 1, 2, 3 |
| hover | moved |
| drag | moved, pressed, 12 interpolated moves 20ms apart with the button held, 100ms pause, released |
| wheel | one `mouseWheel` event with `deltaX` / `deltaY`, then 150ms pause |

Scroll amount is "ticks" of 100 CSS pixels, default 3, clamped to 1..10.

**6.3 Modifiers.** A bitmask: `alt=1, ctrl=2, meta=4, shift=8`. `modifierBits("ctrl+shift")` parses names and aliases (`cmd`, `command`, `option`, `win`), and throws `BAD_ARGS` on an unknown name.

**6.4 Key lookup.** `keyInfo(name)` returns `{ key, code, vk, text? }` from, in order: a table of named keys with aliases (`enter`/`return`, `esc`, `tab`, `backspace`, `delete`, `space`, arrows, `home`, `end`, `pageup`, `pagedown`); `F1`..`F12` (`vk = 111 + n`); a single character (`code` is `KeyA` / `Digit1`, `vk` is the upper-case char code). Anything else: `BAD_ARGS` listing valid forms.

**6.5 `pressKey(tabId, name, bits)`.** Send `keyDown` (or `rawKeyDown` when there is no text) then `keyUp`. Three rules:

1. If any modifier other than Shift is held, send **no text**: `ctrl+a` must not type "a".
2. With Shift and a single character, upper-case the key and text.
3. For `ctrl`/`meta` + `a c v x z`, pass `commands: ['selectAll' | 'copy' | 'paste' | 'cut' | 'undo']`. Shortcuts sent over CDP do not go through the OS menu, so the editing command has to be named.

**6.6 `pressChord` and `typeText`.**

- `pressChord("cmd+a")`: split on `+`, last part is the key, the rest are modifiers. `"cmd++"` means the plus key.
- Refuse page-zoom chords (`ctrl`/`cmd` with `= + - 0`) and point to screenshot zoom.
- Reload chords (`F5`, `cmd+r`, `ctrl+r` and shift variants) are browser shortcuts, not page events: call `chrome.tabs.reload` instead.
- `typeText`: one `pressKey` per character; `\n` is Enter, `\t` is Tab; a character outside the Basic Multilingual Plane goes through `Input.insertText`.

**6.7 `settle(tabId)`.** After every action that can navigate (click, key, type, drag): wait 100ms, then poll until the tab's status is not `loading`, for at most 10s.

**6.8 The tools.**

| Tool | Arguments | Notes |
|---|---|---|
| `click` | `tabId`, `coordinate`, optional `button`, `count`, `modifiers`, `hover: true`, `dragFrom` | Convert with `toCss(await viewOf(tabId), coordinate)`. Step 7 adds `ref` as an alternative to `coordinate`. |
| `type_text` | `tabId`, `text` | Types into whatever has focus |
| `press_key` | `tabId`, `keys` (space-separated chords), optional `repeat` 1..100 | |
| `scroll` | `tabId`, `direction`, optional `coordinate` (default: centre), `amount` | |

Add an optional `action_summary` string to `click`, `type_text` and `press_key`: a few words in which the model states the effect ("Opens the Filters menu"). Log it on the relay with a timestamp. It is an audit trail, and it costs nothing.

**6.9 Tests** for the pure parts, which live in `keys.ts` (sub-tasks 6.3, 6.4 and the chord splitting of 6.6): `modifierBits` (combinations, aliases, unknown name), `keyInfo` (named key, alias, function key, letter, digit, unknown), chord splitting including `"cmd++"`.

Reference: `input.ts:1-276`, `input.ts:454-467`, `computer.ts:119-233`, `relay.ts:420-428`.

## Contracts

```ts
// input.ts
export interface Point { x: number; y: number }                  // CSS viewport pixels
export function click(tabId: number, point: Point, options?: { button?: 'left' | 'right'; count?: number; modifiers?: number }): Promise<void>;
export function moveTo(tabId: number, point: Point): Promise<void>;
export function drag(tabId: number, from: Point, to: Point): Promise<void>;
export function wheel(tabId: number, point: Point, deltaX: number, deltaY: number): Promise<void>;
export function pressChord(tabId: number, chord: string): Promise<void>;
export function typeText(tabId: number, text: string): Promise<void>;
export function settle(tabId: number): Promise<void>;

// keys.ts
export interface KeyInfo { key: string; code: string; vk: number; text?: string }
export function modifierBits(modifiers: string | undefined): number;
export function keyInfo(name: string): KeyInfo;
export function splitChord(chord: string): { key: string; bits: number };
```

## Done when

- `[auto]` `npm run check`, `npm test` pass (key tests included).
- `[browser]` Take a screenshot of `example.com`, `click` the coordinates of its link: the tab navigates, and the result arrives after the load (settle).
- `[browser]` On a search page: `click` the search box, `type_text "hello"`, `press_key "Enter"`: results load.
- `[browser]` `press_key "cmd+a"` (or `ctrl+a`) in a text field selects all; `press_key "Backspace"` clears it.
- `[browser]` `scroll` down by 5 changes what the next screenshot shows.
- `[browser]` `click` with `count: 2` on a word selects it.
- `[browser]` Typing an emoji and a line break into a textarea produces both.
- `[browser]` `press_key "cmd+="` returns the zoom error; `press_key "F5"` reloads the page.
- `[browser]` All of the above work while the tab is in the background.

## Pitfalls

- **Coordinates must be CSS pixels by the time they reach CDP.** Passing frame pixels works on small viewports (ratio 1) and misses on large ones.
- **Parallel calls would interleave key and mouse sequences.** This is why step 3's queue is serial; do not relax it.
- **A drag that jumps straight to the target is often ignored** by drop targets. Keep the interpolated moves and the pause.

## Carry forward

- `click(tabId, point)` takes a CSS point. Step 7 produces such points from element refs and reuses everything here.
- Step 13's overlay hooks into `mouse()` to draw a cursor.
