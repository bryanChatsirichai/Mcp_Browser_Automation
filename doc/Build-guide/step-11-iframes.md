# Step 11: Iframes

**Goal.** `read_page`, `find`, ref clicks, `set_field` and `inspect` work inside iframes, including cross-site ones that run in another process.

**Builds on.** Steps 7 and 10. This is the most intricate step. Do it only when everything before it is solid, and change one layer at a time.

## Background

```text
 tab 12 ............................ root session        Target {tabId: 12}
  +-- main frame F1 ................ contextId 3
  |    +-- iframe, same site, F2 ... contextId 7         same session, another JS context
  |    '-- iframe, other site, F3 .. sessionId "S-A"     its own session (out-of-process, "OOPIF")
  |         '-- iframe F4 .......... sessionId "S-B"     attached through S-A
```

- A **same-process** iframe shares the tab's CDP session and differs only by JavaScript execution context.
- An **out-of-process** iframe is a separate CDP target with its own `sessionId`. Commands for it must carry that id, and its coordinates are relative to its own viewport.

## Files

```text
extension/src/cdp.ts        + sessions, frames, auto-attach, resolveFrame, parentOf
extension/src/snapshot.ts   collect walks into iframes; Entry.target; evaluate takes a Frame
extension/src/input.ts      + frameOffset; centerOf adds it
extension/src/inspect.ts    network entries keep their sessionId
```

## Sub-tasks

**11.1 Send to a session.** `raw()` builds the debuggee as `{ tabId, sessionId }` when the target has a session, else `{ tabId }`. Everything that took `{ tabId }` keeps working.

**11.2 Auto-attach.** Add to `initSession`:

```ts
raw(target, 'Target.setAutoAttach', {
  autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
  filter: [{ type: 'iframe', exclude: false }],
}),
```

`flatten: true` is what delivers child sessions through the same `chrome.debugger` connection.

**11.3 Track sessions.** Add `sessions: Map<childSessionId, parentSessionId | undefined>` to the tab state.

- `Target.attachedToTarget` arriving on session P with child C: `sessions.set(C, P)`, then run `initSession({ tabId, sessionId: C })`. That enables the domains in the child and makes **it** auto-attach its own iframes. Swallow failures; the frame may already be gone.
- `Target.detachedFromTarget`: delete the session and every frame that belonged to it.

**11.4 Track frames.** Add `frames: Map<frameId, { sessionId?, contextId }>`.

- `Runtime.executionContextCreated` where `auxData.isDefault` and `auxData.frameId` exist: set the entry, using the session the event arrived on.
- `Runtime.executionContextDestroyed`: delete the entry with that session and context id.
- `Runtime.executionContextsCleared`: delete every frame of that session.

**11.5 `resolveFrame(tabId, frameId?)`.** Attach, then return `{ tabId }` for the main frame, or `{ tabId, frameId, sessionId, contextId }` from the map; unknown id: `NO_FRAME`. `evaluate()` passes `contextId` to `Runtime.evaluate`.

**11.6 Refs carry their session.** `refFor(target, backendNodeId)` keys `refByNode` by `${sessionId ?? ''}:${backendNodeId}` and stores `{ backendNodeId, sessionId }`. Backend node ids are only unique within a session. `resolveRef` sends `DOM.resolveNode` to `{ tabId, sessionId }` and returns a handle carrying that session, so every later `callOn` reaches the right process.

**11.7 `collect` walks into iframes.** Make the per-frame walk a function `walkFrame(frame, baseDepth, nesting, outerContext)`:

- fetch the tree with `Accessibility.getFullAXTree`, passing `frameId` when there is one, on the frame's session;
- tag each entry with `target = { tabId, sessionId: frame.sessionId }`;
- when a kept node has role `Iframe` and `nesting < 3`: `DOM.describeNode { backendNodeId }` gives the child `frameId`; `resolveFrame` it and recurse with `depth + 1`. Wrap this in `try / catch`: a frame that is gone or still loading is shown without content.

`read_page {ref_id}` must compare both `backendNodeId` and `sessionId` when locating the subtree.

**11.8 Coordinates across processes.** `Input.dispatchMouseEvent` is always sent to the root session in top-level viewport coordinates. An element in an OOPIF reports quads relative to its own frame, so add the frame's position:

```ts
export async function frameOffset(target: Target): Promise<Point> {
  if (!target.sessionId) return { x: 0, y: 0 };
  const parent = parentOf(target);                                           // via the sessions map
  const { frameTree } = await send(target, 'Page.getFrameTree');
  const owner = await send(parent, 'DOM.getFrameOwner', { frameId: frameTree.frame.id });
  const { quads } = await send(parent, 'DOM.getContentQuads', { backendNodeId: owner.backendNodeId });
  const outer = await frameOffset(parent);                                   // recurse to the root
  return quads[0] ? { x: quads[0][0] + outer.x, y: quads[0][1] + outer.y } : outer;
}
```

`centerOf` adds `frameOffset(element)` to the quad centre.

**11.9 Inspect.** `onAttach` now runs for child sessions, so their console and network events are recorded too. `bodyOf` sends `Network.getResponseBody` to `{ tabId, sessionId: entry.sessionId }`.

Reference: `cdp.ts:8-31`, `cdp.ts:52-54`, `cdp.ts:90-105`, `cdp.ts:169-263`, `snapshot.ts:142-222`, `snapshot.ts:239-254`, `input.ts:79-112`.

## Contracts

```ts
// cdp.ts
export interface Frame extends Target { frameId?: string; contextId?: number }
export function resolveFrame(tabId: number, frameId?: string): Promise<Frame>;
export function parentOf(target: Target): Target;
export function lookupRef(tabId: number, ref: string): { backendNodeId: number; sessionId?: string } | undefined;
```

## Done when

Build a local test page that embeds: a same-origin iframe, a cross-origin iframe (serve it from another port or host), and a cross-origin iframe nested in that. Put a button and a text input in each.

- `[auto]` `npm run check`, `npm test` pass.
- `[browser]` `read_page` shows the content of all three iframes indented under their `Iframe` lines.
- `[browser]` `click {ref}` on the button in each iframe triggers that button, including the nested one. Scroll the outer page first and repeat: the click still lands.
- `[browser]` `set_field {ref}` works on the input in each iframe.
- `[browser]` `find` returns elements from inside iframes.
- `[browser]` Reload an iframe: its old refs fail with `STALE_REF` or still resolve correctly, never to a wrong element.
- `[browser]` `inspect network` lists requests made by the cross-origin iframe, and `bodyOf` returns one of their bodies.
- `[browser]` Navigating the top page away and back leaves no stale frame entries (no `NO_FRAME` on a fresh `read_page`).

## Pitfalls

- **Sending a child's command to the root session** fails with "node not found" style errors, or worse, hits a different node with the same id. Always carry the session with the node id.
- **Forgetting to recurse `frameOffset`** makes clicks in nested OOPIFs land at the wrong place by exactly the outer iframe's offset.
- **Whether an iframe is out-of-process depends on site isolation**, so two iframes that look alike can take different paths. Test both kinds.
- **Iframe URLs are not checked against the site policy** in the reference. An allowed page can embed any site and `read_page` will read it. Decide whether to check frame URLs in `collect`.

## Carry forward

- A `Target` always travels with its `sessionId`; never rebuild one from a bare `tabId` when you hold an element.
