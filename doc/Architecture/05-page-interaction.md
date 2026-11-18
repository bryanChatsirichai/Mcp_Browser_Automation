# 5. Page interaction: seeing and acting

The model has two ways to perceive a page and two ways to target an action. This file explains both pairs and the logic behind them.

| | By pixels | By structure |
|---|---|---|
| **See** | `computer screenshot` / `zoom` | `read_page`, `find`, `get_page_text` |
| **Target** | `coordinate: [x, y]` | `ref: "ref_12"` |

Both targeting styles end in the same place: a point in CSS pixels, then a real mouse event at that point.

```text
   coordinate: [x, y]                                  ref: "ref_7"
   (read off a screenshot)                             (read off read_page or find)
          |                                                   |
     viewOf(tab)                                         lookupRef -> {backendNodeId, sessionId}
     toCss(): frame px / ratio                           DOM.resolveNode -> objectId
          |                                              DOM.scrollIntoViewIfNeeded
          |                                              DOM.getContentQuads -> centre
          |                                              + offset of its iframe, if any
          |                                                   |
          +----------------------+     +----------------------+
                                 v     v
                          CSS point {x, y}
                                 |
                 Input.dispatchMouseEvent: moved, pressed, released
                                 |
                 overlay cursor follows  ->  settle() waits out a navigation
```

## Screenshots and the coordinate frame (`capture.ts`)

### The problem

A 2560x1440 viewport on a HiDPI screen produces a 5120x2880 image. That is far too many image tokens. The model must see a smaller picture, yet its click coordinates must still land correctly.

### The solution: one "frame" for everything the model sees and sends

```ts
// capture.ts:28-48
const MAX_EDGE = 1_568;
ratio  = Math.min(1, MAX_EDGE / Math.max(cssWidth, cssHeight));   // frame px per CSS px
width  = Math.round(cssWidth  * ratio);
height = Math.round(cssHeight * ratio);
```

Three coordinate spaces are in play:

```text
device pixels   = CSS pixels * devicePixelRatio          (what the screen has)
CSS pixels                                               (what CDP input events use)
frame pixels    = CSS pixels * ratio                     (what the model sees and sends)
```

```text
   DEVICE pixels                       CSS pixels                      FRAME pixels
   3840 x 2160                         1920 x 1080                     1568 x 882
   what the screen has                 what CDP input uses             what the model sees and sends

   +----------------------------+      +----------------+              +-------------+
   |                            |      |                |              |             |
   |                            | /dpr |       *        |   x ratio    |      *      |
   |                            | ---> |   (960, 540)   | -----------> |  (784, 441) |
   |                            |  /2  |                |   x 0.8167   |             |
   +----------------------------+      +----------------+              +-------------+
                                               ^                              |
                                               |          / ratio             |
                                               +------------------------------+
                                                 the model clicks [784, 441]
```

Worked example, a 1920x1080 CSS viewport at DPR 2:

| Quantity | Value |
|---|---|
| `ratio` | 1568 / 1920 = 0.8167 |
| Frame size | 1568 x 882 |
| Screenshot `clip.scale` | `ratio / dpr` = 0.408 (CDP's scale 1 would give device pixels, `capture.ts:60-61`) |
| Model clicks `[784, 441]` | CSS point = `784 / ratio, 441 / ratio` = `(960, 540)`, the centre |

The conversion back is one division (`computer.ts:42-51`). A coordinate outside the frame is rejected with a message that tells the model the frame size and to take a screenshot.

A viewport whose longer edge is 1568 or less has `ratio = 1`, and frame pixels equal CSS pixels.

### `scale` and `zoom`

- `scale` (0.1 to 1) shrinks the returned image further to save tokens, but **coordinates stay in the full frame**. The result text reminds the model of the frame size (`computer.ts:78-94`).
- `zoom` captures a region given in frame coordinates at **device resolution** as PNG, so small text comes back magnified (`capture.ts:74-105`). The result is scaled down only if its longer edge would exceed 1,568 pixels. It is the model's magnifying glass.

Screenshots are JPEG quality 80; zooms are PNG. The overlay is hidden during capture (`hidden()`, see [06-side-features.md](06-side-features.md)).

## Mouse (`input.ts:114-194`)

All input goes through `Input.dispatchMouseEvent`. These are trusted, browser-level events: the page cannot tell them from a real mouse, and hover states, drag handlers and focus all work.

| Action | Sequence |
|---|---|
| Click | `mouseMoved` -> (`mousePressed`, `mouseReleased`) x count, with `clickCount` 1, 2, 3 for double and triple click |
| Hover | `mouseMoved` |
| Drag | move, press, 12 interpolated moves 20ms apart, 100ms pause over the target, release |
| Scroll | one `mouseWheel` event of `ticks * 100` px, then 150ms pause |

The drag's interpolation and pause exist because drop targets often ignore an instant jump (`input.ts:185`).

Modifiers are a bitmask (`ALT=1, CTRL=2, META=4, SHIFT=8`), parsed from strings like `"ctrl+shift"` (`input.ts:116-128`).

## Keyboard (`input.ts:196-276`)

`keyInfo()` turns a name into `{key, code, vk, text}`:

- named keys from a table (`enter`, `tab`, `arrowdown`...), with aliases (`esc`, `del`, `left`);
- `F1`..`F12` computed (`vk = 111 + n`);
- any single character.

`pressKey()` sends `keyDown` (or `rawKeyDown` when the key produces no text) followed by `keyUp`. Three details show real-world experience:

1. **Shortcuts produce no text.** If any modifier other than Shift is held, `text` is omitted so `ctrl+a` does not type an "a".
2. **Edit commands are named explicitly.** A shortcut sent over CDP bypasses the OS menu, so `cmd+a`, `c`, `v`, `x`, `z` pass `commands: ['selectAll']` and so on (`input.ts:61-68`).
3. **Reload is special-cased.** `F5` / `cmd+r` are browser shortcuts, not page events, so the `key` action calls `chrome.tabs.reload` instead (`computer.ts:144-146`). Page zoom shortcuts are rejected with a pointer to the `zoom` action.

`typeText()` presses one key per character, mapping `\n` to Enter and `\t` to Tab. Characters outside the Basic Multilingual Plane (emoji) have no single key event, so they go through `Input.insertText` (`input.ts:268-276`).

## The accessibility tree (`snapshot.ts`)

### Why the accessibility tree and not the DOM

The DOM is huge and full of layout wrappers. The accessibility (AX) tree is what a screen reader uses: it already has roles (`button`, `link`, `textbox`), computed names, and states (`checked`, `expanded`, `disabled`). That is very close to how a model should think about a page.

### `collect()`: one flat, ordered list (`snapshot.ts:148-222`)

`Accessibility.getFullAXTree` returns nodes for one frame. `collect()` walks them depth-first into a flat `Entry[]` in document order, recursing into iframes.

Filtering rules:

| Rule | Reason |
|---|---|
| Skip ignored nodes and roles in `SKIP` (`generic`, `none`, `paragraph`, `InlineTextBox`...) | Layout noise |
| Keep a node only if it has a name, or is `INTERACTIVE`, or is `STRUCTURAL` | A nameless `div` says nothing; a nameless `button` or `table` still matters |
| Skipped nodes do not increase depth | The output tree is shallower than the real one |
| `StaticText` whose text is already in its parent's name is dropped | Avoids `button "Save"` followed by `text "Save"` |
| `row` names are blanked | A row's name is just its cells concatenated |
| Iframes are followed up to 3 levels deep | Bounds the work |

What the filtering does to a small page (illustrative):

```text
 raw accessibility tree                              entries kept, as read_page prints them

 RootWebArea "Shop"            skipped role
  generic                      skipped role
   navigation "Main"           kept ..............>  navigation "Main" [ref_1]
    generic                    skipped role
     link "Home"               kept ..............>   link "Home" [ref_2]
      StaticText "Home"        repeats its parent
   generic                     skipped role
    button "Buy"               kept ..............>  button "Buy" [ref_3]
     StaticText "Buy"          repeats its parent
    StaticText "In stock"      kept as text ......>  text "In stock"
    Iframe ""                  kept (structural) .>  Iframe [ref_4]
     (its own AX tree is fetched and walked here)     button "Pay" [ref_5]

 The "Home" link sits at depth 4 in the raw tree and depth 1 in the output: skipped nodes add no indentation.
```

Each entry also carries `context`: the last 300 characters of its ancestors' roles and names, lowercased. `find` uses it for queries like "button in the login form".

### `read_page` output

```text
navigation "Main" [ref_1]
 link "Home" [ref_2] href="https://example.com/"
form [ref_3]
 textbox "Email" [ref_4] required
 textbox "Password" [ref_5]
 checkbox "Remember me" [ref_6] checked
 button "Sign in" [ref_7]
 text "Forgot your password?"

Viewport: 1280x720
```

(Format reconstructed from `line()` at `snapshot.ts:228-237` and `describeState()` at `121-140`; not captured from a live run.)

Options: `filter: "interactive"` keeps only interactive roles and flattens indentation; `ref_id` returns one subtree; `depth` limits depth (default 15); `max_chars` (default 50,000) truncates at a line boundary and says how to get the rest.

### `ref_N`: stable handles

`refOf()` asks `cdp.ts` for a ref for the node's `backendNodeId`. Refs are created lazily, only for entries that are printed. See [04-extension-core.md](04-extension-core.md) for lifetime rules.

To act on a ref (`resolveRef`, `snapshot.ts:482-498`): look up `{backendNodeId, sessionId}`, call `DOM.resolveNode` to get a live `objectId`, and return an `ElementHandle`. Any failure becomes `STALE_REF`.

The life of a ref:

```text
 CREATED by read_page / find                        USED by computer{ref}, form_input, file_upload

   refFor(session, backendNodeId)                     lookupRef(tab, "ref_7")
     node seen before -> the same "ref_N"                 not in the map -> STALE_REF
     new node         -> "ref_N", then N + 1              |
          |                                               v
          v                                           DOM.resolveNode(backendNodeId)
   TabState.refs      "ref_7" -> {node, session}          node no longer exists -> STALE_REF
   TabState.refByNode "session:node" -> "ref_7"           |
                                                          v
                                                      ElementHandle {tabId, sessionId, objectId, ref}

 ALL refs of a tab are dropped when:
   - its main frame navigates to a new document
   - the debugger detaches from the tab
   - the service worker restarts (the maps live in memory)
```

### From ref to click point (`centerOf`, `input.ts:93-112`)

1. `DOM.scrollIntoViewIfNeeded`.
2. `DOM.getContentQuads` gives the element's corners; the centre is the average of the four points.
3. If the element is in an out-of-process iframe, add `frameOffset()`: the position of that iframe in its parent, computed recursively up the `sessions` chain (`input.ts:79-91`).

The result is a CSS point in the top-level viewport, and from here a ref click is identical to a coordinate click. `scroll_to` is simply `centerOf()` with the result thrown away.

## `find`: search without an LLM (`snapshot.ts:286-466`)

The tool is described to the model as "natural language" search, but the implementation is deterministic keyword scoring over the same `Entry[]` list. This is a good example of replacing a model call with a cheap heuristic.

```text
 "submit button in the login form"
        |
   parseQuery ------------------> { subject: [submit, button], container: [login, form], phrases: [] }
                                                  |
 collect(tab) -> Entry[] ---- score(entry, query) for each ----> points
                                                  |
                                   drop entries with 0 points
                                   keep entries with >= 70% of the best score
                                   sort by points, then by page order
                                   show the first 20
                                                  |
                                                  v
                     Found 1 matching element

                     - ref_7: button "Submit"
```

### Parse the query (`parseQuery`, `snapshot.ts:426-436`)

`"submit button in the login form"` becomes:

```text
subject   = ["submit", "button"]      (before in/inside/within/under)
container = ["login", "form"]         (after)
phrases   = []                        (anything in "double quotes")
```

Stopwords (`the`, `a`, `element`, `containing`...) are removed.

### Score each entry (`matchToken` + `score`)

Per subject token:

| Match | Points |
|---|---|
| Token is a role word for this entry's role (`ROLE_WORDS`: "dropdown" -> combobox, listbox, menu) | 2, and marks "is that kind" |
| Whole word in the name or state | 2 |
| Substring in the name or state | 1 |
| Found only in an ancestor (`context`) | 0.5 |

Then:

- each container token found in `context`: +1;
- each quoted phrase found in the name: +5;
- interactive role: +1;
- the query names a kind of control and this entry is a different kind: x0.6.

An entry scores 0 when fewer than half of the required tokens hit, when nothing but its kind matched (unless the query only names a kind, like "first button"), or when it matches only the container words (it **is** the form, not the thing inside it).

Small touches: plural forms are folded (`buttons` -> `button`), and position words (`first`, `top`, `main`) improve ranking but are never required.

### Rank and cut

Keep entries scoring at least 70% of the best score, sort by score then page order, show at most 20. A clear winner pushes weak matches out; ties keep document order.

## Forms (`input.ts:278-431`)

`form_input` sets a control "the way a user would" and then **verifies** the result.

```text
setValue(ref, value)
  owningElement()      a ref may point at a text node or a <label>; find the real control
  controlKind()        select | check | file | text | date/time/color/range | none
  |
  |- select  -> chooseOption(): match by value or by visible text, set, fire input + change
  |- check   -> if state differs: real click at the centre (or the label's centre if the
  |             input is hidden), then re-read; still wrong -> CHECK_FAILED
  |- file    -> error: "Use file_upload"
  |- date, time, color, range...
  |          -> setNativeValue(): call the HTMLInputElement.prototype value setter, fire events
  '- text    -> focus, select all, Backspace, type character by character, fire change
  |
  read the value back; differs -> NOT_SET ("may be readonly, disabled, or limit what it accepts")
```

Why each branch exists:

- **Typing instead of assigning** for text fields: frameworks such as React listen to real input events. Typed keys behave like a user.
- **The prototype setter** for native pickers: those inputs cannot be typed into, and frameworks that wrap the `value` property only notice the prototype's setter (`input.ts:311-318`).
- **A real click** for checkboxes: custom checkboxes react to clicks, not to `.checked = true`.
- **Read-back verification**: the tool reports the truth instead of assuming success. The error names likely causes so the model can adapt.

## File upload (`input.ts:433-452`)

Clicking a file input opens an OS dialog that nothing can drive. Instead, `DOM.setFileInputFiles` assigns paths to the input directly. `fileInputWithin()` accepts the input itself, a label for it, or a container holding one.

The paths were already validated and symlink-resolved by the relay ([07-security.md](07-security.md)). After setting, the code reads back names and sizes, and warns when a size is 0, because the browser accepts a non-existent path and hands the page an empty file.

## Page text and JavaScript

**`get_page_text`** (`tools.ts:90-112`) returns `innerText` of the first of `<article>`, `<main>` / `[role=main]`, or `<body>`, with a title/URL header, capped at 50,000 characters.

**`javascript_tool`** (`runJs`, `inspect.ts:231-287`):

- Uses `Runtime.evaluate` with `replMode: true`, which gives top-level `await` and returns the last expression's value.
- If the code fails with "Illegal return", it is retried wrapped in `(async () => { ... })()`, so both styles work.
- 45s limit by `Promise.race`. The message warns that the script may still be running and suggests polling a `window` variable for long jobs.
- Output over 25,000 characters is truncated with a marker. An exception is cut to its message plus two stack frames.
