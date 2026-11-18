# Step 11: Iframes

**Goal.** `read_page`, `find`, ref clicks, `set_field` and `inspect` work inside iframes, including cross-site ones that run in another process.

**Builds on.** Steps 7 and 10. This is the most intricate step. Do it only when everything before it is solid, and change one layer at a time.

## Background

```text
 tab 12 ............................ root session        target {tabId: 12}
  +-- main frame F1 ................ context 3
  |    +-- iframe, same site, F2 ... context 7           same session, another JS context
  |    '-- iframe, other site, F3 .. session "S-A"       its own session (out-of-process, "OOPIF")
  |         '-- iframe F4 .......... session "S-B"       attached through S-A
```

- A **same-process** iframe shares the tab's CDP session and differs only by its JavaScript **execution context**.
- An **out-of-process** iframe (OOPIF) is a separate CDP target with its own **session id**. Chrome's site isolation puts cross-site iframes in their own process. Commands for it must carry that session id, its node ids are only meaningful in that session, and its coordinates are relative to its own viewport.

## Files

```text
extension/src/cdp.ts        + sessions, frames, auto-attach, resolve a frame, parent of a session
extension/src/snapshot.ts   collect walks into iframes; entries carry a target; evaluate takes a frame
extension/src/input.ts      + frame offset; centre of an element adds it
extension/src/inspect.ts    network entries keep their session id
```

## Sub-tasks

**11.1 Send to a session.** In raw send, address the command to the tab **and** session when the target has a session id, and to the tab alone otherwise. Everything that used a bare tab id keeps working.

**11.2 Auto-attach.** In session initialisation, also send `Target.setAutoAttach` with: auto-attach on; do not wait for the debugger on start; **flatten on**; and a filter that includes `iframe` targets. Flattening is what delivers child sessions through the same `chrome.debugger` connection, addressed by session id.

**11.3 Track sessions.** Add to the tab state a map from child session id to parent session id (empty for the root).

- On `Target.attachedToTarget`, arriving on session P with child session C: record C's parent as P, then run session initialisation on the target (tab, C). That enables the domains in the child, runs the on-attach listeners for it, and makes **it** auto-attach its own iframes. Ignore failures: the frame may already be gone.
- On `Target.detachedFromTarget`: delete the session and every frame that belonged to it.

**11.4 Track frames.** Add a map from frame id to its session id and execution context id.

- On `Runtime.executionContextCreated`, when the context is the frame's default one and names a frame id: record the frame with the session the event arrived on.
- On `Runtime.executionContextDestroyed`: delete the entry with that session and context id.
- On `Runtime.executionContextsCleared`: delete every frame of that session.

**11.5 Resolve a frame** (tab id, optional frame id). Attach, then return the bare tab target for the main frame, or the tab, frame id, session id and context id from the map. An unknown frame id: `NO_FRAME`. `evaluate` (step 5) now takes a frame and passes its context id to `Runtime.evaluate`.

**11.6 Refs carry their session.** Backend node ids are only unique within a session, so:

- key the reverse ref map by session id and backend node id together;
- store the session id with each ref;
- "resolve ref" sends `DOM.resolveNode` to that session and returns a handle carrying it, so every later call on the element reaches the right process.

**11.7 Collect walks into iframes.** Make the per-frame walk a function that takes a frame, a base depth, a nesting level and the outer context string:

1. Fetch the tree with `Accessibility.getFullAXTree`, on the frame's session, passing the frame id when there is one.
2. Tag each entry with its target (tab and session).
3. When an emitted node has role `Iframe` and the nesting level is below 3: describe the node (`DOM.describeNode` with its backend node id) to get the child frame id, resolve that frame, and walk it with depth + 1. Wrap this in try / catch: a frame that is gone or still loading is shown without content.

`read_page` with a `ref_id` must compare both the backend node id and the session id when locating the subtree.

**11.8 Coordinates across processes.** `Input.dispatchMouseEvent` is always sent to the **root** session, in top-level viewport coordinates. An element in an OOPIF reports quads relative to its own frame, so add the frame's position on the page. The **frame offset** of a target:

1. No session id (main frame or same-process iframe): (0, 0). Same-process iframes already report quads in top-level coordinates.
2. Otherwise, find the parent session from the sessions map.
3. Get the child's own frame id from `Page.getFrameTree` on the child session.
4. Ask the **parent** session which element owns that frame (`DOM.getFrameOwner`), and get that element's quads (`DOM.getContentQuads`).
5. Add the parent's own frame offset, **recursively**, up to the root.
6. The offset is the first quad's top-left corner plus the parent's offset.

"Centre of an element" (step 7) adds the frame offset of the element's target to the quad centre.

**11.9 Inspect.** The on-attach hook now runs for child sessions, so their console and network events are recorded too. `bodyOf` sends `Network.getResponseBody` to the tab and the entry's session id.

## Interfaces

| Name | Where | Shape |
|---|---|---|
| Frame | `cdp.ts` | a target plus optional frame id and context id |
| resolve frame | `cdp.ts` | tab id, optional frame id → frame, or throws `NO_FRAME` |
| parent of | `cdp.ts` | target → the target of its parent session |
| look up ref | `cdp.ts` | tab id, ref → backend node id and session id, or nothing |

## Done when

Build a local test page that embeds: a same-origin iframe; a cross-origin iframe (serve it from another port or host name, such as `127.0.0.1` against `localhost`); and a cross-origin iframe nested inside that one. Put a button and a text input in each.

- `[auto]` `npm run check`, `npm test` pass.
- `[browser]` `read_page` shows the content of all three iframes, indented under their `Iframe` lines.
- `[browser]` `click {ref}` on the button in each iframe triggers that button, including the nested one. Scroll the outer page first and repeat: the click still lands.
- `[browser]` `set_field {ref}` works on the input in each iframe.
- `[browser]` `find` returns elements from inside iframes.
- `[browser]` Reload an iframe: its old refs fail with `STALE_REF` or still resolve correctly, never to a wrong element.
- `[browser]` `inspect network` lists requests made by the cross-origin iframe, and `bodyOf` returns one of their bodies.
- `[browser]` Navigating the top page away and back leaves no stale frame entries (no `NO_FRAME` on a fresh `read_page`).

## Pitfalls

- **Sending a child's command to the root session** fails with "node not found" errors or, worse, hits a different node with the same id. Always carry the session with the node id.
- **Forgetting to recurse the frame offset** makes clicks in nested OOPIFs land at the wrong place, off by exactly the outer iframe's offset.
- **Whether an iframe is out-of-process depends on site isolation**, so two iframes that look alike can take different paths. Test both kinds.
- **Iframe URLs are not checked against the site policy** by these steps. An allowed page can embed any site and `read_page` will read it. Decide whether to check frame URLs while collecting (step 14 lists this).

## Carry forward

- A target always travels with its session id. Never rebuild one from a bare tab id when you hold an element.
