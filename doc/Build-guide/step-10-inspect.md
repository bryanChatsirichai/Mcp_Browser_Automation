# Step 10: Inspect: console, network, dialogs

**Goal.** The model can read a tab's console output, errors, network requests, cookies and storage, and a JavaScript dialog can never freeze the session.

**Builds on.** Step 4 (the on-attach and on-event hooks) and step 8 (`inspect.ts` exists). Independent of step 9.

## Files

```text
extension/src/inspect.ts    + buffers, event recorder, the inspect tool
extension/src/protocol.ts   + inspect arguments
extension/src/tools.ts      + inspect handler
relay/tools.ts              + inspect
test/ring.test.ts                                                    (new)
```

## Sub-tasks

**10.1 Per-tab ring buffers.** A map from tab id to three lists: console, errors, network. Cap each at 500 entries: add the new entry, and drop the oldest if the list is over the cap. Delete a tab's buffers when the tab closes (`chrome.tabs.onRemoved`).

**10.2 Enable the domains on attach.** Register an on-attach listener (step 4) that enables the CDP `Network` and `Log` domains. `Page` and `Runtime` are already enabled by the attach itself.

**10.3 Record events** with one on-event listener:

| CDP event | Goes to | Keep |
|---|---|---|
| `Runtime.consoleAPICalled` | console; also errors when its type is `error` | level, the arguments joined as text, up to 1,000 characters |
| `Log.entryAdded` | console; also errors when its level is `error` | level, text, URL |
| `Runtime.exceptionThrown` | errors | description, URL, line |
| `Network.requestWillBeSent` | network (new entry) | request id, method, URL (500 characters), resource type |
| `Network.responseReceived` | update the entry | status, MIME type, declared length |
| `Network.loadingFinished` | update the entry | transferred size, falling back to the declared length for cached responses |
| `Network.loadingFailed` | update the entry | error text |

To find the entry to update, search from the **end** of the list for the request id: one id repeats across the hops of a redirect, and the newest hop is the one being updated.

**10.4 Dialogs.** On `Page.javascriptDialogOpening`, immediately answer with `Page.handleJavaScriptDialog`: accept it, and for a prompt use its default text. Then add a console entry with level `dialog` and the dialog's message, so the model can see what happened. An open `alert`, `confirm` or `prompt` blocks the page and every later CDP call to it, so this cannot wait for the model.

**10.5 The `inspect` tool.** It returns plain data (not content parts), so the relay converts it to JSON and fences it. Arguments: `tabId`, `mode`, and the optional filters below.

| `mode` | Returns |
|---|---|
| `console`, `errors` | The newest `limit` entries (default 50), the `total`, and `truncated: true` when there are more |
| `network` | The same, after filtering by a `url` substring, `method` and `status` |
| `network` with `bodyOf` set to a request id | One response body, from `Network.getResponseBody`, capped at 25,000 characters, with a flag saying whether it is base64 |
| `cookies` | `Network.getCookies` for the tab's URL, each value cut to 200 characters |
| `storage` | `localStorage` and `sessionStorage`, read by a page function, each value cut to 500 characters |

If the tab was not attached before this call, recording only starts now. Add a note: "Recording started with this call. Reload the tab to capture its page load."

**10.6 Tests.** Move the ring buffer's "add" and the "newest N with total and truncated flag" shaping into a chrome-free module and test them: the cap, the order, and the truncated flag.

## Interfaces

| Name | Where | Shape |
|---|---|---|
| inspect | `inspect.ts` | tab id, arguments → plain data |
| Inspect arguments | `protocol.ts` | `mode` (console, network, errors, cookies, storage), `tabId`; optional `url`, `method`, `status`, `bodyOf`, `limit` |

## Done when

- `[auto]` `npm run check`, `npm test` pass.
- `[browser]` `run_js "console.log('hi'); console.error('bad')"`, then `inspect console` shows both and `inspect errors` shows the second.
- `[browser]` `run_js "setTimeout(() => { throw new Error('boom') })"`, then `inspect errors` shows an exception entry.
- `[browser]` Reload a page, then `inspect network` lists its requests with status and size; filtering by `status: 404` narrows it; `bodyOf` returns one body.
- `[browser]` `inspect cookies` and `inspect storage` return data for a site that has some.
- `[browser]` `run_js "alert('x'); 'after'"` returns `after` instead of hanging, and `inspect console` shows the auto-accepted dialog.
- `[browser]` On a tab never used before, the first `inspect console` includes the "Reload the tab" note.

## Pitfalls

- **Unbounded buffers** grow until the worker is killed. Cap them.
- **Returning bodies in the list** floods the model's context. List metadata; fetch one body by id.
- **Auto-accepting means every `confirm()` is answered OK**, including "Delete this?". This is a real trade-off against freezing. State it in the tool description, and consider a setting to dismiss instead.
- **`cookies` includes `httpOnly` cookies.** Together with `run_js`, this gives a hijacked model the user's session on any allowed site. The allowed list is the control.

## Carry forward

- Step 11 makes the on-attach hook run for iframe sessions too. Store the session id on each network entry now (it is empty until then), because `Network.getResponseBody` must be sent to the session that saw the request.
