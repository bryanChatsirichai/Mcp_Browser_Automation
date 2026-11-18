# Step 10: Inspect: console, network, dialogs

**Goal.** The model can read a tab's console output, errors, network requests, cookies and storage, and a JavaScript dialog can never freeze the session.

**Builds on.** Step 4 (the `onAttach` / `onEvent` hooks) and step 8 (`inspect.ts` exists). Independent of step 9.

## Files

```text
extension/src/inspect.ts    + buffers, event recorder, inspect()
extension/src/protocol.ts   + InspectArgs
extension/src/tools.ts      + inspect handler
tools.ts                    + inspect
test/ring.test.ts                                                    (new)
```

## Sub-tasks

**10.1 Per-tab ring buffers.** `Map<tabId, { console, errors, network }>`, each an array capped at 500 entries (push, then shift when over). Delete a tab's buffers in `chrome.tabs.onRemoved`.

**10.2 Enable the domains on attach.**

```ts
onAttach(async (target) => {
  await Promise.all([send(target, 'Network.enable', {}), send(target, 'Log.enable')]);
});
```

**10.3 Record events** with one `onEvent` listener:

| CDP event | Goes to | Keep |
|---|---|---|
| `Runtime.consoleAPICalled` | `console`; also `errors` when type is `error` | level, arguments joined as text, 1,000 characters |
| `Log.entryAdded` | `console`; also `errors` when level is `error` | level, text, url |
| `Runtime.exceptionThrown` | `errors` | description, url, line |
| `Network.requestWillBeSent` | `network` (new entry) | requestId, method, url (500 chars), type |
| `Network.responseReceived` | update the entry | status, MIME, declared length |
| `Network.loadingFinished` | update the entry | transferred size, falling back to the declared length for cached responses |
| `Network.loadingFailed` | update the entry | error text |

Find the entry to update with `findLast` on `requestId`: ids can repeat across redirects.

**10.4 Dialogs.** On `Page.javascriptDialogOpening`, immediately send `Page.handleJavaScriptDialog { accept: true, promptText: dialog.defaultPrompt }` and push a `console` entry with level `dialog` and the message. An open `alert`, `confirm` or `prompt` blocks the page and every later CDP call, so this cannot wait for the model.

**10.5 The `inspect` tool.** Returns plain JSON (not content), so the relay stringifies and fences it.

| `mode` | Returns |
|---|---|
| `console`, `errors` | The newest `limit` entries (default 50), `total`, and `truncated: true` when more exist |
| `network` | The same, after filtering by `url` substring, `method`, `status` |
| `network` + `bodyOf: <requestId>` | One body via `Network.getResponseBody`, capped at 25,000 characters, with `base64` flagged |
| `cookies` | `Network.getCookies` for the tab's URL; cut each value to 200 characters |
| `storage` | `localStorage` and `sessionStorage` read by a page function; cut each value to 500 characters |

If the tab was not attached before this call, add a note: "Recording started with this call. Reload the tab to capture its page load."

**10.6 Tests.** Extract the ring `push` and the `recent(entries, limit)` shaping into a chrome-free module and test: the cap, the order, the `truncated` flag.

Reference: `inspect.ts:1-227`.

## Contracts

```ts
// inspect.ts
export function inspect(tabId: number, args: InspectArgs): Promise<unknown>;

// protocol.ts
export interface InspectArgs {
  mode: 'console' | 'network' | 'errors' | 'cookies' | 'storage';
  tabId: number;
  url?: string; method?: string; status?: number; bodyOf?: string; limit?: number;
}
```

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
- **`cookies` includes `httpOnly` cookies.** Together with `run_js` this gives a hijacked model the user's session on any allowed site. The allowed list is the control.

## Carry forward

- Step 11 makes `onAttach` run for iframe sessions too. Store the `sessionId` on each network entry now (it is `undefined` until then), because `Network.getResponseBody` must be sent to the session that saw the request.
