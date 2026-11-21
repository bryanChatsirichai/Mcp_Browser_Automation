# Step 7: Reading the page: tree, refs, find

**Goal.** The model can read a page as a compact tree of roles and names, point at any element with a short stable id (`ref_N`), and search for elements by description. Clicks can target a ref instead of a pixel.

**Builds on.** Step 6. Main frame only; iframes come in step 11.

## Background

Chrome builds an **accessibility tree** for every page: the same tree a screen reader uses. Each node has a role (`button`, `link`, `textbox`...), a name (the visible label), and properties (checked, expanded...). It is far shorter than the DOM and describes what a user can see and do, which makes it a good page summary for a model. CDP returns it with `Accessibility.getFullAXTree`. Each node also carries a `backendDOMNodeId`, which identifies the DOM element behind it and stays stable while the document lives.

## Files

```text
extension/src/cdp.ts        + refs in the tab state; mint, look up, clear on navigation
extension/src/query.ts      parse a query, score an entry, rank: pure     (new)
extension/src/snapshot.ts   + call on an object, collect, read page, find, resolve ref
extension/src/input.ts      + centre of an element
extension/src/protocol.ts   + read_page and find arguments
extension/src/tools.ts      + read_page, find, page_text; click accepts ref
relay/tools.ts              + the three tools; ref on click
test/find.test.ts                                                         (new)
```

## Sub-tasks

**7.1 Refs in `cdp.ts`.** Add to each tab's state: a map from ref to backend node id, the reverse map, and a counter starting at 1.

- **Ref for a node**: if the node already has a ref, return it; otherwise mint `ref_` plus the counter, increment it, and store both directions. The same node always gets the same ref.
- **Look up a ref**: return its backend node id, or nothing.
- On the `Page.frameNavigated` event for the **main** frame (a frame with no parent id), clear both maps: a new document invalidates every ref.

**7.2 Calling a function on a page object.** Write a helper that runs a function with `this` bound to a page object (identified by a CDP object id), using `Runtime.callFunctionOn`. Pass the function's **source text** as the function declaration, and its arguments as values. Use the same flags as `evaluate` in step 5 (`returnByValue`, `awaitPromise`, `userGesture`), and turn exception details into `JS_ERROR`.

Only the function's source text crosses into the page. It must therefore be self-contained: no references to imports, outer variables or helper functions from the extension.

**7.3 Collect: a flat list of entries.** Fetch the tree with `Accessibility.getFullAXTree`, index the nodes by node id, and walk depth-first from the root, producing a list of **entries** in document order. Each entry holds: depth, role, name, a state string, the backend node id, whether it is plain text, and a context string.

Rules, applied per node:

| Case | Action |
|---|---|
| Ignored, or a role in the skip set (`generic`, `none`, `presentation`, `paragraph`, `InlineTextBox`, `RootWebArea`, layout-table roles, and similar wrappers) | Emit nothing; its children keep the **same** depth |
| `StaticText` | Emit as text, unless the text is already contained in the name of the nearest emitted ancestor (a button's label would otherwise appear twice) |
| Has a name, or an interactive role, or a structural role (`table`, `row`, `dialog`, `form`, `list`, `menu`, `tree`, `Iframe`) | Emit; its children get depth + 1 |
| `row` | Blank its name: it only repeats its cells |

The **state** string is short and built from the node's value and properties, for example: ` value="..."`, ` href="..."`, ` level=2`, ` checked`, ` expanded` or ` collapsed`, ` disabled`, ` selected`, ` focused`, ` required`. Truncate names to about 120 characters and text to about 300.

The **context** is the role and name of each emitted ancestor joined together, lower-cased, keeping the last 300 characters. `find` uses it to understand "the button in the login form".

**7.4 `read_page`.** Print one line per entry: indentation by depth, then `role "name" [ref_N] state`, or `text "..."` for text. Mint refs only for entries that are printed.

| Argument | Effect |
|---|---|
| `filter: "interactive"` | Only interactive roles, without indentation |
| `ref_id` | Only that element's subtree: the entry itself and the following entries with greater depth |
| `depth` (default 15) | Drop deeper entries |
| `max_chars` (default 50,000) | Cut at a line boundary and append how much was shown and how to see the rest (a `ref_id` or a smaller `depth`) |

End with the viewport size in CSS pixels (`innerWidth` x `innerHeight`), such as `Viewport: 1920x1080`.

**7.5 From a ref to an action.**

- **Resolve a ref**: look it up, then turn the backend node id into a page object with `DOM.resolveNode`. Any failure (unknown ref, node gone) is `STALE_REF`, with the message "The page has changed or navigated; get fresh refs with read_page or find."
- **Centre of an element**: scroll it into view (`DOM.scrollIntoViewIfNeeded`), get its quads (`DOM.getContentQuads`), and average the four corners of the first quad. No quads means the element has no box on screen: `NOT_VISIBLE`.

Update `click` to accept a `ref` instead of a `coordinate`: resolve it, take its centre, then click exactly as in step 6. A "scroll to element" action is the centre lookup with the result ignored.

**7.6 `find(tabId, query)`: keyword scoring, no model.** Put parsing, scoring and ranking in `query.ts`. These functions work on plain objects with role, name, state and context, so they can be tested without a browser. `find` in `snapshot.ts` only collects entries, scores them and formats the result.

**Parse** the query:

```text
 "submit button in the login form"
   subject   = [submit, button]     words before  in | inside | within | under
   container = [login, form]        words after
   phrases   = []                   anything in "double quotes"
 Stopwords (the, a, of, element, containing, ...) are removed.
 Plurals are folded to the singular ("buttons" -> "button").
```

**Score** an entry (0 means no match):

| Signal | Points |
|---|---|
| A subject word names this entry's kind (use a table from words to roles: "dropdown" → `combobox`, `listbox`, `menu`; "link" → `link`...) | 2 |
| A subject word is a whole word in the name or state | 2 |
| A subject word is a substring of the name or state | 1 |
| A subject word appears only in the context | 0.5 |
| A container word appears in the context | 1 |
| A quoted phrase appears in the name | 5 |
| The entry has an interactive role | +1 |
| The query names a kind and the entry is a different kind | multiply the total by 0.6 |

Return 0 when fewer than half the required words hit; when only the kind matched although the query said more than a kind; or when nothing in the subject matched (the entry is the container itself).

**Rank**: keep entries with at least 70% of the best score, sort by score and then page order, show at most 20 as `- ref_N: role "name" state`, and say when more matched. With no match, say so and suggest `read_page`.

**7.7 `page_text`.** The readable text of the page: the `innerText` of the first that exists of `<article>`, `<main>` (or `[role=main]`), and `<body>`. Put the title and URL above it, and cap it at 50,000 characters with a truncation note. Write it as a self-contained function and run it with `evaluate`.

**7.8 Tests** for parsing and scoring with hand-made entries: a role word match; a whole word beats a substring; the container requirement; a quoted phrase; plural folding; the three zero-score rules; the ranking cut-off.

## Interfaces

| Name | Where | Takes → returns |
|---|---|---|
| ref for / look up ref | `cdp.ts` | target and backend node id → ref / tab id and ref → backend node id or nothing |
| Element handle | `snapshot.ts` | a target plus the page object id and the ref |
| resolve ref | `snapshot.ts` | tab id, ref → element handle, or throws `STALE_REF` |
| call on | `snapshot.ts` | target, object id, self-contained function, arguments → the returned value |
| read page / find | `snapshot.ts` | arguments → text |
| centre of | `input.ts` | element handle → CSS point, or throws `NOT_VISIBLE` |
| Searchable | `query.ts` | role, name, state, context |
| parse query / score | `query.ts` | text → subject, container, phrases / searchable and parsed query → number |

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

- **Printing every accessibility node** produces output several times larger and mostly noise. The skip rules are the feature.
- **Refs are held in worker memory.** A worker restart loses them all; the `STALE_REF` message is what makes that recoverable.
- **Do not mint refs for entries you do not print**, or the counter grows without bound on large pages.
- **`find` is English-only** as described: stopwords, role words and plural folding are English.

## Carry forward

- Any tool that targets an element takes a `ref` and goes through "resolve ref".
- Entries and collect gain a target field in step 11. Write the per-frame walk as a function you can call again for another frame.
