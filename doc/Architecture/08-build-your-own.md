# 8. Lessons and a path to building your own

## Patterns worth reusing

Each of these is small, general, and used well in this repo.

| Pattern | Where | Use it when |
|---|---|---|
| **Reverse connection**: the constrained side dials out, a relay listens | `background.ts:154-195` | One side cannot accept connections (extension, browser tab, device behind NAT) |
| **Correlation map**: `Map<id, {resolve, reject, timer}>` | `relay.ts:129-203` | You need request/response over a message stream |
| **Promise-chain queue**: `queue = queue.then(work)` | `background.ts:29`, `offscreen.ts:31` | Work must be serial or ordered, and you do not need a queue library |
| **Shared in-flight promise**: `x ??= start().finally(clear)` | `cdp.ts:145-156`, `relay.ts:140-161` | Many callers need the same one-time async setup |
| **Timeout by race, with an honest message** | `background.ts:62-90`, `inspect.ts:246-274` | The work cannot be cancelled; tell the caller it may still be running |
| **Nested timeouts** (85s inside 90s inside 100s) | [02-request-lifecycle.md](02-request-lifecycle.md) | Several layers can time out; the innermost should fire first |
| **Storage as the message bus** | `popup.ts:190-192`, `background.ts:221-227` | UI and worker have different lifetimes |
| **Functions shipped as strings** (`fn.toString()`) | `snapshot.ts:81-99` | You must run typed code in another JS context |
| **Lazy attach inside the lowest-level call** | `cdp.ts:80-88` | A resource needs setup and callers should not care |
| **Publish/subscribe on a single event source** | `cdp.ts:43-50`, `265-277` | Features should plug into a core without the core knowing them |
| **Dispatch table typed by the union of names** | `tools.ts:153-168` | Adding a command must force adding its handler |
| **Single path for single and batched calls** | `tools.ts:196-258` | Batches must not bypass checks |
| **Do, then verify, then report the truth** | `input.ts:420-428`, `360-362`, `445-451` | The caller is a model that will trust your "success" |
| **Errors written as next-step instructions** | `snapshot.ts:475-480` | The reader is an LLM |
| **Model-facing coordinate frame separate from the real one** | `capture.ts:28-48` | Images must be downscaled but coordinates must stay exact |
| **Nonce-fenced untrusted output** | `relay.ts:323-331` | Any tool that returns third-party content to a model |
| **Check the resolved value, then pass on the resolved value** | `relay.ts:407-418` | Any path or URL check, to avoid time-of-check/time-of-use gaps |

## Design decisions and their trade-offs

| Decision | Gain | Cost |
|---|---|---|
| `chrome.debugger` for everything | One mechanism: trusted input, screenshots, AX tree, network, iframes. No host permissions. | Visible debugging bar. Conflicts with DevTools-style tools on the same tab. Broad power. |
| Relay as a dumb pipe | Tool logic in one place; the relay rarely changes | Tool arguments are never validated against the published schema |
| Stateless MCP, POST only | No session bookkeeping; works through any HTTP tunnel | No streaming, progress or server notifications |
| One global serial queue | No interleaved input; simple reasoning | Two tabs cannot be driven in parallel; one slow call delays all |
| State in service worker memory | Simple and fast | Refs, buffers and an in-progress recording are lost when Chrome restarts the worker |
| No bundler, no extension dependencies | Tiny, auditable, fast build | Cannot use npm libraries in the extension without adding a bundler |
| Running `.ts` directly in Node | No build step for the server | Requires Node 22.18+; only erasable TypeScript syntax |
| `find` by keyword scoring | Free, instant, deterministic | Weaker than a model on fuzzy queries; English-only word lists |
| Auto-accepting dialogs | Pages never freeze | `confirm()` is always answered OK |

## A build order for your own version

This is the short version. The full version, with sub-tasks, contracts and checks per step, is in [build-guide/](build-guide/README.md); it splits these eight stages into 15 smaller steps.

Each step produces something you can run. The file to study is listed for each.

```text
  1 relay lists tools          POST /mcp answers tools/list
        |
  2 extension connects         hello / ready / ping over WebSocket
        |
  3 round trip                 pending map, call / result, timeouts     <- first end-to-end tool call
        |
  4 CDP layer                  attach, typed send; screenshot, navigate
        |
  5 input                      mouse, keyboard, coordinate frame, serial queue
        |
  6 structure                  accessibility tree, ref_N, click by ref
        |
  7 guardrails                 fence, tab scope, site policy            <- before any powerful tool
        |
  8 extras, in any order       batch | forms | iframes | file side channel | inspect | record | overlay
```

**Step 1. A relay that only lists tools.**
Node HTTP server, `POST /mcp`, MCP SDK in stateless mode, one fake tool that returns text. Connect an MCP client and see the tool. Study `relay.ts:430-463`, `508-525`.

**Step 2. An extension that connects.**
MV3 manifest with a module service worker. Open a WebSocket to the relay, send `hello`, receive `ready`. Add ping, backoff and the alarm. Write `protocol.ts` first and import it from both sides. Study `background.ts`, `relay.ts:211-280`.

**Step 3. Round trip.**
Add the pending map on the relay and `call` / `result` messages. Implement one real tool: list tabs with `chrome.tabs.query`. Add the timeout on both sides. Study `relay.ts:163-209`.

**Step 4. A CDP layer.**
`attach` with de-duplication, a typed `send`, state cleanup on `onDetach`. Implement `screenshot` and `navigate`. Study `cdp.ts:66-167`, `tabs.ts:220-265`.

**Step 5. Input.**
Mouse click and typing through `Input.dispatch*Event`. Add the coordinate frame the moment you downscale screenshots. Add the serial queue now. Study `capture.ts`, `input.ts:114-276`.

**Step 6. Structure.**
`Accessibility.getFullAXTree` -> filtered text tree with `ref_N`. Then click by ref (`DOM.resolveNode`, `DOM.getContentQuads`). Study `snapshot.ts:148-284`, `cdp.ts:169-190`.

**Step 7. Guardrails, before anything else.**
Fencing, tab scope, URL policy checked on every call. Do this before adding powerful tools, not after. Study [07-security.md](07-security.md).

**Step 8. The rest, as needed.**
Batching, forms, iframes (auto-attach and session tracking), file side channel, inspect, recording, overlay.

Iframes (the `sessionId` / `contextId` bookkeeping in `cdp.ts:192-263`) are the most intricate part. Leave them until the main-frame path is solid.

## What I would change

These are judgement calls from reading the code, ranked by how much they matter. None is a bug I reproduced; one (the Reconnect button) is a probable bug.

**Major**

1. **Add tests for the pure logic.** `policy.ts` (URL rules), `find` scoring, `fence`, `isUploadable`, `safeName`, `withScheme` and `quote` are pure functions guarding security or correctness, and none has a test. `node --test` would cover them with no new dependency. A regression in `problemWith` or `isUploadable` would be silent.
2. **Validate tool arguments at the relay.** The schemas are published but never enforced. Handlers check what they use, but a wrong type elsewhere flows into CDP and surfaces as an opaque `CDP_ERROR`. Zod is already a dependency.
3. **Offer a confirmation or read-only mode.** The README says nothing asks before an action. For a tool with the user's sessions, a per-site "ask first" option or a mode without `javascript_tool`, `form_input` and clicks would be a meaningful safety step.

**Minor**

- **Make "Reconnect" reconnect.** In the `replaced` state the button re-saves unchanged settings, and the worker reconnects only on a settings change event, which probably does not fire for an identical value. Not reproduced; details in [02-request-lifecycle.md](02-request-lifecycle.md). A direct message to the worker, or a counter in the saved settings, would remove the doubt.

4. **Clean up `./files`.** Nothing deletes stored recordings, PDFs and screenshots. A max age or size sweep at startup would do.
5. **Fix the `record` description.** It says the tab is brought to the front; the code does not do that (see [03-relay.md](03-relay.md)).
6. **Single source for the version.** `0.2.0` is hard-coded in `package.json`, `manifest.json` and `relay.ts:432`.
7. **Per-tab queues.** The global queue is the simplest correct choice, but input on different tabs does not interleave, so a queue per tab would allow parallel work.
8. **Check iframe URLs against the policy**, at least for `read_page` content, since the README lists this as uncovered.

**Nitpick**

9. The regex that rewrites `/files/...` in text (`relay.ts:350`) also rewrites page text that happens to contain such a path. Harmless, but structured data would be cleaner than text rewriting.
10. Some copied schema text mentions "a Claude in Chrome extension version that supports scale" (`schemas.ts:153`), which does not apply here.

## Before you publish your own

The repo's comment says ten tool definitions are copied from the Claude in Chrome extension (`schemas.ts:1-3`). If you build and distribute your own project, write your own tool names and descriptions, or confirm you are permitted to reuse someone else's. The architecture and the patterns above are general techniques; verbatim text from another product is a different matter.

## Things to look up next

The notes deliberately stop at the package boundary. To go deeper:

| Topic | Where to read |
|---|---|
| CDP domains used: `Page`, `Runtime`, `DOM`, `Input`, `Accessibility`, `Network`, `Target`, `Emulation`, `Log` | The Chrome DevTools Protocol reference |
| `chrome.debugger`, `chrome.offscreen`, `chrome.tabGroups`, service worker lifetime | Chrome Extensions (Manifest V3) documentation |
| Streamable HTTP transport, stateless mode, `instructions` | The Model Context Protocol specification and TypeScript SDK |
| Running TypeScript in Node by type stripping | Node.js documentation, "TypeScript" section |
