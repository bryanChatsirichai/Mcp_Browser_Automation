# Step 6: Mouse and keyboard

**Goal.** The model can click, hover, drag, scroll, type and press keys, with events the page cannot tell from a real user's. After this step an agent can operate a website by screenshot alone.

**Builds on.** Step 5.

## Files

```text
extension/src/keys.ts       modifier bits, key lookup, chord splitting: pure   (new)
extension/src/input.ts      mouse, keyboard, settle                            (new)
extension/src/protocol.ts   + argument types for the four tools
extension/src/tools.ts      + click, type_text, press_key, scroll handlers
relay/tools.ts              + the four tools
test/keys.test.ts                                                              (new)
```

## Sub-tasks

**6.1 One mouse primitive.** Every mouse action goes through one function that sends `Input.dispatchMouseEvent` to the tab. It takes:

| Input | Values |
|---|---|
| event type | `mouseMoved`, `mousePressed`, `mouseReleased` |
| point | x and y in **CSS** pixels |
| button | `none` (default), `left`, `right` |
| click count | 0 by default |
| modifiers | a bitmask (6.3), 0 by default |

Also set the `buttons` field: 1 while the left button is held (on moves and presses with the left button), otherwise 0. Some pages read `buttons`, not `button`, to detect a drag.

**6.2 Gestures built from it.**

| Gesture | Sequence |
|---|---|
| click (single, double or triple; left or right) | One move to the point, then a press and a release for each count, with the click count set to 1, 2, 3 in turn |
| hover | One move |
| drag | Move to the start, press, then 12 moves interpolated toward the end, 20 ms apart, with the button held; pause 100 ms; release |
| wheel | One `mouseWheel` event with horizontal and vertical deltas, then a 150 ms pause |

Scroll amounts are in "ticks" of 100 CSS pixels: 3 by default, clamped to 1 to 10.

**6.3 Modifiers.** CDP takes modifiers as a bitmask: Alt = 1, Ctrl = 2, Meta (Command / Windows key) = 4, Shift = 8. Write a function that turns a string such as `ctrl+shift` into the mask. Accept aliases: `cmd`, `command` and `win` for Meta, and `option` for Alt. Throw `BAD_ARGS` on an unknown name.

**6.4 Key lookup.** For a key name, produce the four values CDP needs: `key` (the DOM key value, such as `Enter` or `a`), `code` (the physical key, such as `Enter` or `KeyA`), the Windows virtual key code, and the text it types, if any. Look the name up in this order:

1. A table of named keys with aliases: `Enter` (alias `return`), `Escape` (`esc`), `Tab`, `Backspace`, `Delete`, `Space`, the four arrows, `Home`, `End`, `PageUp`, `PageDown`. Look up the virtual key codes in the CDP or Windows documentation; for example Enter is 13 and Escape is 27.
2. Function keys `F1` to `F12`: the virtual key code is 111 plus the number.
3. A single character: `code` is `Key` plus the upper-case letter, or `Digit` plus the digit; the virtual key code is the upper-case character's code.

Anything else: `BAD_ARGS`, listing the accepted forms.

**6.5 Pressing one key** (with a modifier mask). Send `Input.dispatchKeyEvent` twice: a key down, then a key up. Use type `keyDown` when the key produces text and `rawKeyDown` when it does not. Three rules:

1. If any modifier other than Shift is held, send **no text**: `ctrl+a` must not type "a".
2. With Shift and a single character, upper-case both the key and the text.
3. For Ctrl or Meta with `a`, `c`, `v`, `x` or `z`, also pass the matching editing command (`selectAll`, `copy`, `paste`, `cut`, `undo`) in the event's `commands` field. Shortcuts sent through CDP do not pass through the operating system's menu, so the command has to be named for the page's editor to act on it.

**6.6 Chords and typing.**

- **A chord** such as `cmd+a`: split on `+`. The last part is the key; the rest are modifiers. `cmd++` means Command with the plus key.
- **Refuse page-zoom chords** (Ctrl or Command with `=`, `+`, `-` or `0`) with a message pointing to the screenshot zoom. Zooming the page would break the coordinate frame.
- **Reload chords** (`F5`, `cmd+r`, `ctrl+r` and their Shift variants) are browser shortcuts, not page events, so key events do not trigger them. Call `chrome.tabs.reload` instead.
- **Typing text:** press one key per character. A newline is Enter and a tab is Tab. A character outside the Basic Multilingual Plane (most emoji) cannot be sent as one key event; use `Input.insertText` for it.

**6.7 Settle.** After any action that can start a navigation (click, key, typing, drag): wait 100 ms, then poll the tab's status until it is not `loading`, for at most 10 seconds. This makes the result arrive after the page has reacted, so the model's next screenshot shows the new state.

**6.8 The tools.**

| Tool | Arguments | Notes |
|---|---|---|
| `click` | `tabId`, `coordinate`; optional `button`, `count`, `modifiers`, `hover: true`, `dragFrom` | Convert the coordinate to CSS with the tab's view (step 5). `hover` only moves; `dragFrom` drags from that coordinate to this one. Step 7 adds `ref` as an alternative to `coordinate` |
| `type_text` | `tabId`, `text` | Types into whatever has focus |
| `press_key` | `tabId`, `keys` (space-separated chords), optional `repeat` from 1 to 100 | |
| `scroll` | `tabId`, `direction`; optional `coordinate` (default: centre of the viewport), `amount` | |

Add an optional `action_summary` string to `click`, `type_text` and `press_key`: a few words in which the model states the intended effect ("Opens the Filters menu"). The relay logs it with a timestamp for every call. It is an audit trail and costs nothing.

**6.9 Tests** for the pure parts, which live in `keys.ts` (sub-tasks 6.3, 6.4 and the chord splitting of 6.6): modifier masks (combinations, aliases, an unknown name); key lookup (a named key, an alias, a function key, a letter, a digit, an unknown name); chord splitting, including `cmd++`.

## Interfaces

| Name | Where | Takes → returns |
|---|---|---|
| Point | `input.ts` | x, y in CSS viewport pixels |
| click | `input.ts` | tab id, point, optional button, count, modifier mask |
| move to / drag / wheel | `input.ts` | tab id and points (and deltas for wheel) |
| press chord / type text | `input.ts` | tab id, chord or text |
| settle | `input.ts` | tab id; resolves when the tab is not loading or after 10 s |
| Key info | `keys.ts` | key, code, virtual key code, optional text |
| modifier bits / key info / split chord | `keys.ts` | string → mask / key info / key name and mask |

## Done when

- `[auto]` `npm run check`, `npm test` pass (key tests included).
- `[browser]` Take a screenshot of `example.com`, then `click` the coordinates of its link: the tab navigates, and the result arrives after the load.
- `[browser]` On a search page: `click` the search box, `type_text "hello"`, `press_key "Enter"`: results load.
- `[browser]` `press_key "cmd+a"` (or `ctrl+a`) in a text field selects all; `press_key "Backspace"` clears it.
- `[browser]` `scroll` down by 5 changes what the next screenshot shows.
- `[browser]` `click` with `count: 2` on a word selects it.
- `[browser]` Typing an emoji and a line break into a textarea produces both.
- `[browser]` `press_key "cmd+="` returns the zoom refusal; `press_key "F5"` reloads the page.
- `[browser]` All of the above work while the tab is in the background.

## Pitfalls

- **Coordinates must be CSS pixels by the time they reach CDP.** Passing frame pixels works on small viewports (ratio 1) and misses on large ones.
- **Parallel calls would interleave key and mouse sequences.** This is why step 3's queue is serial; do not relax it.
- **A drag that jumps straight to the target is often ignored** by drop targets. Keep the interpolated moves and the pause.

## Carry forward

- `click` takes a CSS point. Step 7 produces such points from element refs and reuses everything here.
- Step 13's overlay hooks into the mouse primitive to draw a cursor.
