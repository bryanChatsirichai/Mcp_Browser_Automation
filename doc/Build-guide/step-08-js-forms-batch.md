# Step 8: JavaScript, forms, batching

**Goal.** The model can run code in the page, set any form control reliably, and send several actions in one call. This completes the core product.

**Builds on.** Step 7.

## Files

```text
extension/src/inspect.ts    runJs                                    (new; grows in step 10)
extension/src/input.ts      + setValue and its page functions
extension/src/tools.ts      + run_js, set_field handlers; batch()
extension/src/protocol.ts   + RunJsArgs, SetFieldArgs, BatchArgs; 'batch' in ToolName
tools.ts                    + run_js, set_field, batch
relay.ts                    logCall covers batch items
test/batch-names.test.ts                                             (new)
```

## Sub-tasks

### `run_js`

**8.1 Evaluate with REPL semantics.** `Runtime.evaluate` with `replMode: true`, `awaitPromise: true`, `returnByValue: true`, `userGesture: true`. REPL mode gives top-level `await` and returns the value of the last expression.

**8.2 Accept `return` too.** If the exception text contains "Illegal return", run the code again wrapped as `(async () => {\n<code>\n})()` with `replMode: false`.

**8.3 Time limit: 45s, by race.** The script cannot be cancelled. The timeout message must say so: "It may still be running in the page: check its effects before starting another script. For long jobs, start them without awaiting and poll a window variable." Give the abandoned promise a no-op `catch`.

**8.4 Shape the output.** `undefined` prints as `undefined`; strings as themselves; everything else through `JSON.stringify`. Cut at 25,000 characters with a `[TRUNCATED]` marker. On an exception throw `JS_ERROR` with the message and at most two stack frames.

### `set_field`

**8.5 Find the real control.** A ref may point at a text node or a `<label>`. Run a page function on the ref that returns the element itself if it is a control, else `label.control`, else the element.

**8.6 Classify, then act.** One page function returns the kind; the handler branches:

```text
 kind      how it is set                                                  verification
 --------  -------------------------------------------------------------  ---------------------------
 select    match an <option> by value, or by visible text ignoring case;  no match -> NO_OPTION
           set .value; dispatch input + change (bubbling)
 check     already in the wanted state -> nothing.                        still wrong -> CHECK_FAILED
           otherwise a REAL click at its centre (if it has no box,
           click the element the ref pointed at, e.g. a styled label)
 file      refuse: "Use upload_file"
 date, time, datetime-local, month, week, color, range
           call HTMLInputElement.prototype's value setter, then           value differs -> NOT_SET
           dispatch input + change
 text      DOM.focus (fall back to a click), select all, Backspace,       value differs -> NOT_SET
           typeText(value), dispatch change
 other     BAD_ARGS: "not a form control that takes a value"
```

**8.7 Read back and tell the truth.** After setting, read the control's value. If it differs from what was asked, throw `NOT_SET` naming the actual value and likely causes: readonly, disabled, or a limit on format, range or length. Finish with `settle(tabId)`.

### `batch`

**8.8 One loop over `runOne`.** `batch { actions: [{ name, input }] }` runs items in order through the same `runOne(name, input, true)` as single calls, so every item passes `guard()`.

```ts
for (const [index, item] of args.actions.entries()) {
  const name = String(item?.name ?? '').split('__').pop()!;       // accepts "mcp__server__click"
  const label = `[${name}]`;
  try {
    if (name === 'batch') throw new ToolError('BAD_ARGS', 'batch cannot be nested.');
    const output = await runOne(name, item.input ?? {}, true);
    // text parts get the label as a prefix; images pass through; plain objects are stringified
  } catch (error) {
    // push `${label} Error: <message> Batch stopped: N remaining actions were not executed.`
    isError = true;
    break;
  }
}
content.push({ type: 'text', text: await tabContext(lastTab) });    // one footer for the whole batch
```

**8.9 Rules inside a batch.** `navigate` without a `tabId` is refused (`inBatch` is why handlers receive that flag). Put the name normalisation in a small exported function and test it: plain name, prefixed name, empty name.

**8.10 Relay.** `logCall` loops over batch items so each action and its `action_summary` gets its own log line.

Reference: `inspect.ts:229-287`, `input.ts:278-431`, `extension/src/tools.ts:132-141`, `extension/src/tools.ts:212-258`, `relay.ts:365-372`, `relay.ts:420-428`.

## Contracts

```ts
// inspect.ts
export function runJs(tabId: number, code: string): Promise<string>;

// input.ts
export function setValue(handle: ElementHandle, value: string | boolean | number): Promise<string>;

// protocol.ts
export interface BatchArgs { actions: Array<{ name: string; input: Record<string, unknown> }> }
```

## Done when

- `[auto]` `npm run check`, `npm test` pass.
- `[browser]` `run_js "document.title"` returns the title; `"await fetch(location.href).then(r => r.status)"` returns 200; `"return 1 + 1"` returns 2.
- `[browser]` `run_js "await new Promise(() => {})"` returns the timeout message after 45s, and the next call still works.
- `[browser]` `run_js "null.x"` returns a `JS_ERROR` with a short message.
- `[browser]` On a test form: `set_field` sets a text input (a React-controlled one if you have one), a `<select>` by its visible text, a checkbox to `true` then `false`, and a `<input type="date">`.
- `[browser]` `set_field` on a `readonly` input returns `NOT_SET` naming the unchanged value.
- `[browser]` `set_field` with a ref of the label text of a checkbox toggles the checkbox.
- `[browser]` A batch of `navigate`, `click`, `type_text`, `press_key "Enter"`, `screenshot` returns labelled texts, one image and one footer.
- `[browser]` A batch whose second item fails stops there and reports how many were skipped.
- `[browser]` A batch whose first item navigates to a blocked site is refused; a batch that lands a tab on a blocked site has its **next** item refused.

## Pitfalls

- **Assigning `.value` directly** does not update framework-controlled inputs. Typing does. That is the reason for the slow path.
- **Assigning `.checked`** does not fire the handlers a custom checkbox listens for. A real click does.
- **A batch must not have a second, shorter code path.** If it calls handlers directly it bypasses the guard.
- **`run_js` is the most powerful tool you have built.** On an allowed site it acts with the user's session. The site policy from step 4 is what bounds it.

## Carry forward

- The relay and the extension normalise tool names in a batch the same way. Step 9 depends on that for upload checks.
