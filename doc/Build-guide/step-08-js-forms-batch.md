# Step 8: JavaScript, forms, batching

**Goal.** The model can run code in the page, set any form control reliably, and send several actions in one call. This completes the core product.

**Builds on.** Step 7.

## Files

```text
extension/src/inspect.ts    run JS                                   (new; grows in step 10)
extension/src/input.ts      + set a form value, and its page functions
extension/src/tools.ts      + run_js, set_field handlers; batch
extension/src/protocol.ts   + run_js, set_field and batch arguments; "batch" in the tool names
relay/tools.ts              + run_js, set_field, batch
relay/relay.ts              call logging covers batch items
test/batch-names.test.ts                                             (new)
```

## Sub-tasks

### `run_js`

**8.1 Evaluate with REPL semantics.** Send `Runtime.evaluate` with `replMode` on, plus `awaitPromise`, `returnByValue` and `userGesture`. REPL mode is what the DevTools console uses: top-level `await` works, `let` and `const` can be redeclared, and the value of the last expression is returned.

**8.2 Accept `return` too.** Models often write `return x`. If the exception text contains "Illegal return", run the code again wrapped in an async arrow function that is called at once (the code on its own lines inside the body), with REPL mode off.

**8.3 Time limit: 45 seconds, by race.** A script cannot be cancelled once started. When the timer wins, say so: "It may still be running in the page: check its effects before starting another script. For long jobs, start them without awaiting and poll a window variable." Attach an empty error handler to the abandoned promise.

**8.4 Shape the output.** `undefined` prints as `undefined`; a string prints as itself; anything else goes through JSON. Cut at 25,000 characters with a `[TRUNCATED]` marker. On an exception, throw `JS_ERROR` with the message and at most two stack frames.

### `set_field`

Arguments: `tabId`, `ref`, and `value` (string, boolean or number).

**8.5 Find the real control.** A ref may point at a text node or a `<label>`. Run a page function on the ref's element that returns: the element itself if it is a form control; otherwise the label's associated control; otherwise the element.

**8.6 Classify, then act.** A second page function returns the control's kind; the handler branches on it:

```text
 kind      how it is set                                                  check afterwards
 --------  -------------------------------------------------------------  ---------------------------
 select    find an <option> by value, or by visible text ignoring case;   no match -> NO_OPTION
           set the select's value; fire bubbling input and change events
 check     already in the wanted state -> do nothing.                     still wrong -> CHECK_FAILED
 (checkbox otherwise a REAL click at its centre. If it has no box (hidden,
  radio)   styled by a label), click the element the ref pointed at
 file      refuse: "Use upload_file"
 date, time, datetime-local, month, week, color, range
           call the native value setter from the input element prototype  value differs -> NOT_SET
           (not the element's own property); fire input and change
 text      focus it (DOM.focus; fall back to a click), select all,        value differs -> NOT_SET
           Backspace, type the value as keys, fire change
 other     BAD_ARGS: "not a form control that takes a value"
```

**8.7 Read back and tell the truth.** After setting, read the control's value. If it differs from what was asked, throw `NOT_SET` naming the actual value and the likely causes: read-only, disabled, or a limit on format, range or length. Finish with settle (step 6).

### `batch`

Arguments: `actions`, a list of `{ name, input }`.

**8.8 One loop over `runOne`.** Run the items in order through the **same** `runOne` as single calls, with the in-batch flag set, so every item passes the guard. For each item:

1. Normalise the name: keep only the part after the last `__`. Clients sometimes send a tool's full prefixed name, such as `mcp__bridge__click`.
2. Label its output with the name in square brackets, such as `[click]`.
3. Refuse a nested `batch` with `BAD_ARGS`.
4. Run it. Prefix its text parts with the label; pass its images through; turn a plain-object result into labelled JSON text.
5. On failure: add a text "[name] Error: message. Batch stopped: N remaining actions were not executed.", mark the whole result as an error, and stop.

After the loop, add **one** tab context footer for the whole batch, for the last tab used.

**8.9 Rules inside a batch.** `navigate` without a `tabId` is refused inside a batch: the implicit tab choice (step 4) would be surprising mid-sequence. This is why handlers receive the in-batch flag. Put the name normalisation in a small exported chrome-free function and test it: a plain name, a prefixed name, an empty name.

**8.10 Relay.** The call logging from step 6 loops over batch items, so each action and its `action_summary` get their own log line.

## Interfaces

| Name | Where | Takes → returns |
|---|---|---|
| run JS | `inspect.ts` | tab id, code → output text |
| set value | `input.ts` | element handle, value → a short confirmation text |
| Batch arguments | `protocol.ts` | `actions`: list of `{ name, input }` |

## Done when

- `[auto]` `npm run check`, `npm test` pass.
- `[browser]` `run_js "document.title"` returns the title; `"await fetch(location.href).then(r => r.status)"` returns 200; `"return 1 + 1"` returns 2.
- `[browser]` `run_js "await new Promise(() => {})"` returns the timeout message after 45 seconds, and the next call still works.
- `[browser]` `run_js "null.x"` returns a `JS_ERROR` with a short message.
- `[browser]` On a test form: `set_field` sets a text input (a React-controlled one if you have one), a `<select>` by its visible text, a checkbox to `true` then `false`, and an `<input type="date">`.
- `[browser]` `set_field` on a `readonly` input returns `NOT_SET` naming the unchanged value.
- `[browser]` `set_field` with the ref of a checkbox's label text toggles the checkbox.
- `[browser]` A batch of `navigate`, `click`, `type_text`, `press_key "Enter"`, `screenshot` returns labelled texts, one image and one footer.
- `[browser]` A batch whose second item fails stops there and reports how many were skipped.
- `[browser]` A batch whose first item navigates to a blocked site is refused; a batch that lands a tab on a blocked site has its **next** item refused.

## Pitfalls

- **Assigning `.value` directly** does not update framework-controlled inputs (React tracks the value itself and ignores the assignment). Typing does. That is the reason for the slow path.
- **Assigning `.checked`** does not fire the handlers a custom checkbox listens for. A real click does.
- **A batch must not have a second, shorter code path.** If it calls handlers directly, it bypasses the guard.
- **`run_js` is the most powerful tool you have built.** On an allowed site it acts with the user's session. The site policy from step 4 is what bounds it.

## Carry forward

- The relay and the extension normalise tool names in a batch the same way. Step 9 depends on that for upload checks.
