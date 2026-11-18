# Step 7: Reading the page: tree, refs, find

**Goal.** The model can read a page as a compact tree of roles and names, point at any element with a short stable id (`ref_N`), and search for elements by description. Clicks can target a ref instead of a pixel.

**Builds on.** Step 6. Main frame only; iframes come in step 11.

## Files

```text
extension/src/cdp.ts        + refs in the tab state, refFor, lookupRef, clear on navigation
extension/src/query.ts      parseQuery, score, rank: pure            (new)
extension/src/snapshot.ts   + callOn, collect, readPage, find, resolveRef
extension/src/input.ts      + centerOf
extension/src/protocol.ts   + ReadPageArgs, FindArgs
extension/src/tools.ts      + read_page, find, page_text; click accepts ref
tools.ts                    + the three tools; ref on click
test/find.test.ts                                                    (new)
```

## Sub-tasks

**7.1 Refs in `cdp.ts`.** Add to the tab state: `refs: Map<string, {backendNodeId}>`, `refByNode: Map<string, string>`, `nextRef = 1`.

- `refFor(target, backendNodeId)`: return the existing ref for that node, or mint `ref_${nextRef++}` and store both directions. The same node always gets the same ref.
- `lookupRef(tabId, ref)`.
- On `Page.frameNavigated` for the main frame (`!frame.parentId`), clear both maps: a new document invalidates every ref.

**7.2 `callOn()`.** Run a function with `this` bound to a page object. Only the function's source text crosses over, so it must reference nothing outside itself.

```ts
export async function callOn<T>(target: Target, objectId: string, fn: (...args: never[]) => unknown, args: unknown[] = []): Promise<T> {
  const { result, exceptionDetails } = await send(target, 'Runtime.callFunctionOn', {
    objectId, functionDeclaration: fn.toString(), arguments: args.map((value) => ({ value })),
    returnByValue: true, awaitPromise: true, userGesture: true,
  });
  if (exceptionDetails) throw jsError(exceptionDetails);
  return result.value as T;
}
```

**7.3 `collect(tabId)`: the flat list.** Call `Accessibility.getFullAXTree`, index nodes by `nodeId`, and walk depth-first from the root into `Entry[]` in document order.

```ts
interface Entry { depth: number; role: string; name: string; state: string; backendNodeId?: number; isText: boolean; context: string }
```

Rules, applied per node:

| Case | Action |
|---|---|
| `ignored`, or role in the skip set (`generic`, `none`, `presentation`, `paragraph`, `InlineTextBox`, `RootWebArea`, layout-table roles...) | Emit nothing; children keep the **same** depth |
| `StaticText` | Emit as text unless the text is already contained in the enclosing kept element's name |
| Has a name, or role is interactive, or role is structural (`table`, `row`, `dialog`, `form`, `list`, `menu`, `tree`, `Iframe`) | Emit; children get depth + 1 |
| `row` | Blank its name (it only repeats its cells) |

`state` is a short string built from the node's value and properties: ` value="..."`, ` href="..."`, ` level=2`, ` checked`, ` expanded` / ` collapsed`, ` disabled`, ` selected`, ` focused`, ` required`. Truncate names to about 120 characters and text to 300.

`context` is the last 300 characters of the ancestors' `role name` strings, lower-cased. `find` uses it.

**7.4 `read_page`.** Print one line per entry: indentation by depth, then `role "name" [ref_N] state`, or `text "..."`. Call `refFor` only for entries that are printed.

| Argument | Effect |
|---|---|
| `filter: "interactive"` | Only interactive roles, no indentation |
| `ref_id` | Only that element's subtree (entries after it with greater depth) |
| `depth` (default 15) | Drop deeper entries |
| `max_chars` (default 50,000) | Cut at a line boundary and append how much was shown and how to get the rest |

End with `Viewport: WxH`.

**7.5 From a ref to an action.**

```ts
export async function resolveRef(tabId, ref): Promise<ElementHandle>     // lookupRef -> DOM.resolveNode -> objectId; any failure -> STALE_REF
export async function centerOf(element): Promise<Point>                  // DOM.scrollIntoViewIfNeeded, DOM.getContentQuads, average of the 4 corners
```

`STALE_REF` must tell the model what to do: "The page has changed or navigated; get fresh refs with read_page or find." No quads: `NOT_VISIBLE`.

Update `click` to accept `ref` instead of `coordinate`: `point = await centerOf(await resolveRef(tabId, ref))`, then the same `click()` as step 6. A `scroll_to` behaviour is just `centerOf` with the result ignored.

**7.6 `find(tabId, query)`: keyword scoring, no model.** Put parsing, scoring and ranking in `query.ts`, working on plain `{role, name, state, context}` objects, so they can be tested without a browser. `find` in `snapshot.ts` only calls `collect` and formats the result.

Parse:

```text
 "submit button in the login form"
   subject   = [submit, button]     words before  in | inside | within | under
   container = [login, form]        words after
   phrases   = []                   anything in "double quotes"
 Stopwords (the, a, of, element, containing, ...) are removed.
```

Score an entry (0 means no match):

| Signal | Points |
|---|---|
| Subject word names this entry's kind (a table maps words to roles: "dropdown" to `combobox`, `listbox`, `menu`) | 2 |
| Subject word is a whole word in the name or state | 2 |
| Subject word is a substring of the name or state | 1 |
| Subject word appears only in `context` | 0.5 |
| Container word appears in `context` | 1 |
| Quoted phrase appears in the name | 5 |
| Entry has an interactive role | +1 |
| Query names a kind and the entry is a different kind | total x 0.6 |

Return 0 when fewer than half the required words hit; when only the kind matched and the query said more than a kind; or when nothing in the subject matched (the entry is the container itself).

Rank: keep entries with at least 70% of the best score, sort by score then page order, show at most 20 as `- ref_N: role "name" state`, and say when more matched.

**7.7 `page_text`.** `innerText` of the first of `<article>`, `<main>` / `[role=main]`, `<body>`, with a title and URL header, capped at 50,000 characters with a truncation note. Write it as a self-contained function and run it with `evaluate`.

**7.8 Tests** for `parseQuery` and `score` using hand-made entries: role word match, whole word beats substring, container requirement, quoted phrase, plural folding, the 0-score rules, ranking cut-off.

Reference: `snapshot.ts` (whole file), `cdp.ts:169-190`, `cdp.ts:254-262`, `input.ts:93-112`, `extension/src/tools.ts:88-124`.

## Contracts

```ts
// cdp.ts
export function refFor(target: Target, backendNodeId: number): string;
export function lookupRef(tabId: number, ref: string): { backendNodeId: number; sessionId?: string } | undefined;

// snapshot.ts
export interface ElementHandle extends Target { objectId: string; ref: string }
export function resolveRef(tabId: number, ref: string): Promise<ElementHandle>;
export function callOn<T>(target: Target, objectId: string, fn: (...args: never[]) => unknown, args?: unknown[]): Promise<T>;
export function readPage(args: ReadPageArgs): Promise<string>;
export function find(tabId: number, query: string): Promise<string>;

// input.ts
export function centerOf(element: ElementHandle): Promise<Point>;

// query.ts  (no chrome access)
export interface Searchable { role: string; name: string; state: string; context: string }
export function parseQuery(text: string): { subject: string[]; container: string[]; phrases: string[] };
export function score(entry: Searchable, query: ReturnType<typeof parseQuery>): number;
```

## Done when

- `[auto]` `npm run check`, `npm test` pass (find tests included).
- `[browser]` `read_page` on a login page prints a tree where each control is one line with a ref, and the output has no `generic` lines.
- `[browser]` Calling `read_page` twice gives the same refs for the same elements.
- `[browser]` `read_page {filter: "interactive"}` lists only controls; `{ref_id: ...}` returns one subtree.
- `[browser]` `click {ref}` on a button below the fold scrolls to it and clicks it.
- `[browser]` After `navigate` to another page, the old ref returns `STALE_REF`.
- `[browser]` `find "search box"` returns the search input first; `find "zzzz"` returns the no-match hint.
- `[browser]` `page_text` on an article returns the article body, not the navigation.

## Pitfalls

- **Printing every AX node** produces output several times larger and mostly noise. The skip rules are the feature.
- **Refs are held in worker memory.** A worker restart loses them all; the `STALE_REF` message is what makes that recoverable.
- **Do not assign refs to entries you do not print**, or `nextRef` grows without bound on large pages.
- **`find` is English-only** as specified: stopwords, role words and plural folding are English.

## Carry forward

- Any tool that targets an element takes a `ref` and goes through `resolveRef`.
- `Entry` and `collect` grow a `target` field in step 11; write `collect` so the per-frame walk is a function you can call again.
