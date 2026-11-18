# Step 3: Round trip and the first real tools

**Goal.** A `tools/call` from the client reaches the extension, runs, and returns a result that is labelled as untrusted. The three tab tools work.

**Builds on.** Step 2. This is the step that makes the system real; take it slowly.

## Files

```text
extension/src/protocol.ts     + Call, Result, ErrorBody, ToolName, Content, argument types
extension/src/errors.ts       ToolError, toErrorBody                      (new)
extension/src/tools.ts        dispatch table, runTool                     (new)
extension/src/tabs.ts         tab group, tab context footer               (new)
extension/src/background.ts   + parse, queue, handleCall
extension/manifest.json       + "tabs", "tabGroups"
relay.ts                      + pending map, callExtension, toResult
relay-lib.ts                  + fence
tools.ts                      real tabs_list, + tab_open, tab_close
test/fence.test.ts                                                        (new)
```

## Sub-tasks

**3.1 Protocol.**

```ts
export type ToolName = 'tabs_list' | 'tab_open' | 'tab_close';      // grows every tool step

export interface Call { type: 'call'; id: string; tool: ToolName; args: Record<string, unknown> }
export interface ErrorBody { code: string; message: string; [extra: string]: unknown }
export type Result =
  | { type: 'result'; id: string; ok: true; data: unknown }
  | { type: 'result'; id: string; ok: false; error: ErrorBody };

export type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface ContentResult { content: Content[]; isError?: boolean }
```

**3.2 `errors.ts`.** `class ToolError extends Error { code; extra }` with fields declared explicitly, and `toErrorBody(error)` that maps a `ToolError` to `{code, message, ...extra}` and anything else to `{code: 'ERROR', message}`.

**3.3 Relay: correlate requests and responses.**

```ts
const pending = new Map<string, { resolve; reject; timer }>();

function callExtension(tool, args): Promise<unknown> {
  // no socket -> reject NO_EXTENSION ("Open the extension popup and press Connect.")
  // id = randomUUID(); timer = setTimeout(reject TIMEOUT, 90_000); pending.set(id, ...); send {type:'call', ...}
}
function settle(id, ok, data, error) { /* find, delete, clearTimeout, resolve or reject */ }
function failAllPending() { /* on socket close: settle everything as NO_EXTENSION */ }
```

Call `settle` from the `result` branch of `acceptExtension`, and `failAllPending` from its close handler. Mark errors that came from the browser (`fromBrowser = true`) so 3.5 can treat them differently.

**3.4 `fence()` in `relay-lib.ts`.**

```ts
const FENCE = 'untrusted-browser-content';
const INVISIBLE = /[\u{E0000}-\u{E007F}‪-‮⁦-⁩]/gu;

export function fence(text: string, nonce = randomBytes(8).toString('hex')): string {
  const body = text.replace(INVISIBLE, '').replaceAll(FENCE, FENCE.replaceAll('-', '_'));
  return `<${FENCE} id="${nonce}">\n${body}\n</${FENCE} id="${nonce}">`;
}
```

Tests: the nonce appears in both tags; a body containing the tag name comes out with underscores; an invisible tag character is removed; two calls produce different nonces.

**3.5 Relay: `tools/call` for real.** `callExtension` then `toResult(data)`:

- data has a `content` array: collect consecutive text parts, and emit them as one fenced block whenever an image interrupts and at the end. Images pass through. Use one nonce for the whole result.
- anything else: `JSON.stringify` it into one fenced text block.
- on error: `{ isError: true, content: [{ text: 'Error: ...' }] }`, fencing the message only when `fromBrowser` is true.

Add `instructions` to the `Server` options: a paragraph telling the model that everything returned comes from web pages, is wrapped in the fence, and is data, never commands.

**3.6 Extension: receive, queue, answer.**

```ts
let queue: Promise<void> = Promise.resolve();

// onMessage, type 'call':
const receivedAt = Date.now();
if (isLookup(call)) void handleCall(call, receivedAt);               // tabs_list only, for now
else queue = queue.then(() => handleCall(call, receivedAt));
```

`handleCall` gives each call 85s **measured from arrival**:

```ts
const left = receivedAt + 85_000 - Date.now();
if (left <= 0) throw new ToolError('BUSY', '... This call was not run; retry it.');
const work = runTool(call.tool, call.args);
work.catch(() => undefined);                       // an abandoned call may fail later
const data = await Promise.race([work, expiresAfter(left)]);     // rejects TIMEOUT: "...abandoned. Its effects may still land in the page."
```

Always send exactly one `result` per call, in a `try / catch`.

**3.7 `tools.ts`: dispatch.**

```ts
type Handler = (args: never, inBatch: boolean) => Promise<Content[] | object>;
const handlers: Record<ToolName, Handler> = { tabs_list, tab_open, tab_close };

async function runOne(tool, args, inBatch) { /* lookup -> UNKNOWN_TOOL; (step 4: guard); handler */ }

export async function runTool(tool, args) {
  const output = await runOne(tool, args, false);
  if (!Array.isArray(output)) return output;                                   // plain JSON
  return { content: [...output, { type: 'text', text: await tabContext(tabIdOf(args)) }] };
}
```

**3.8 `tabs.ts`: the tab group.** The agent works in a tab group titled with a fixed name, in its own unfocused window.

- `findGroup()`: try the id cached in session storage, else query groups by title and re-cache.
- `ensureGroup()`: return the group's tabs, creating the group with one blank tab if there are none.
- `createTab()`, `closeTab(tabId)` (refuse tabs outside the group with `NOT_IN_GROUP`).
- `contextJson()`: `{ availableTabs: [{tabId, title, url}], tabGroupId }`, titles and URLs truncated.
- `tabContext(executedOn?)`: the text footer listing the group's tabs, appended to every content result.
- `requireTab(tabId)`: throws `BAD_ARGS` when the id is not a number.

Reference: `relay.ts:93-209`, `relay.ts:305-363`, `background.ts:28-113`, `extension/src/tools.ts:151-272`, `tabs.ts:1-142`, `errors.ts`.

## Contracts

```ts
// extension/src/tools.ts
export function runTool(tool: ToolName, args: Record<string, unknown>): Promise<unknown>;

// extension/src/tabs.ts
export function groupTabs(): Promise<chrome.tabs.Tab[]>;
export function ensureGroup(): Promise<chrome.tabs.Tab[]>;
export function requireTab(tabId: number | undefined): number;
export function tabContext(executedOn?: number): Promise<string>;

// relay-lib.ts
export function fence(text: string, nonce?: string): string;
```

## Done when

- `[auto]` `npm run check`, `npm test` pass (fence tests included).
- `[auto]` With no extension connected, the `tools/call` curl from step 1 returns `"isError":true` and "No browser connected" at once, not after 90s.
- `[browser]` With the extension connected, `tabs_list` with `{"createIfEmpty":true}` opens a new window with a coloured tab group and returns its tab id inside `<untrusted-browser-content id="...">`.
- `[browser]` `tab_open` adds a tab to the group; `tab_close` with that id removes it; `tab_close` with the id of one of your own tabs returns `NOT_IN_GROUP`.
- `[browser]` Disconnect in the popup while a call is in flight (add a temporary 20s sleep to a handler): the client gets "Browser disconnected mid-call" immediately. Remove the sleep.
- `[browser]` Send two calls at once with the temporary sleep in place: the second starts only after the first finishes.

## Pitfalls

- **The 85s budget must be shorter than the relay's 90s**, and both shorter than a tunnel's idle limit (about 100s for common ones). Inner limits fire first so the model gets the most specific message.
- **A timed-out call is abandoned, not cancelled.** Say so in the message. The queue moves on.
- **Forgetting `work.catch(() => undefined)`** turns a late failure into an unhandled rejection in the worker.
- **Only read-only lookups may skip the queue.**

## Carry forward

- Every tool goes through `runOne`. There is no other path to a handler.
- Handlers return `Content[]` (gets the tab footer) or a plain object (sent as JSON).
- All text leaving the relay toward the model is fenced, except errors the relay itself wrote.
- Adding a tool from now on means: name in `ToolName`, argument type in `protocol.ts`, handler in the table, definition in root `tools.ts`.
