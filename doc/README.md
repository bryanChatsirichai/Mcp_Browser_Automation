# Browser Bridge: study notes

These notes explain how this repository is set up, how it is structured, and how its logic works, so you can learn from it and build your own. They were written by reading every source file at commit `8226603` (version 0.2.0). They describe the code, not the npm packages underneath it.

## The project in one paragraph

Browser Bridge turns your own logged-in Chrome or Edge into an MCP server. An AI client (Claude Code, Cursor) sends tool calls such as "click here" or "read this page" over HTTP. A small Node process, the **relay**, forwards each call over a WebSocket to a **browser extension**. The extension carries it out on a real tab through the Chrome DevTools Protocol (CDP) and sends the result back the same way. There is no LLM and no API key inside: the project is only the bridge.

```text
+------------+   HTTP POST /mcp    +----------+   WebSocket /ext    +-----------+  chrome.debugger  +------+
| MCP client |  ---------------->  | relay.ts |  <----------------  | Extension |  -------------->  | Tabs |
| (the model)|  <----------------  |  (Node)  |  ---------------->  | (MV3 SW)  |  <--------------  |      |
+------------+    tool result      +----------+   call / result     +-----------+   CDP + events    +------+
```

The arrow on the WebSocket points left on purpose: the **extension dials out** to the relay. A browser extension cannot listen on a port, so the piece that can listen (Node) sits in the middle.

## Reading order

| # | File | What you learn |
|---|---|---|
| 1 | [01-architecture.md](01-architecture.md) | The components, why the system has this shape, the file map, the build setup |
| 2 | [02-request-lifecycle.md](02-request-lifecycle.md) | One tool call traced end to end, the wire protocol, timeouts, reconnects |
| 3 | [03-relay.md](03-relay.md) | `relay.ts`: HTTP routes, auth, the stateless MCP server, file storage |
| 4 | [04-extension-core.md](04-extension-core.md) | Service worker, tool dispatch, the CDP layer, tab group, settings, popup |
| 5 | [05-page-interaction.md](05-page-interaction.md) | Screenshots and coordinates, mouse and keyboard, the accessibility tree, `ref_N` ids, `find`, forms |
| 6 | [06-side-features.md](06-side-features.md) | `inspect`, `record`, `files`, the on-page overlay |
| 7 | [07-security.md](07-security.md) | Threat model and every guardrail, with the gaps |
| 8 | [08-build-your-own.md](08-build-your-own.md) | Reusable patterns, a build order, and what I would change |

To build your own, follow [build-guide/](build-guide/README.md): 15 steps from an empty folder, each building on the last, each with sub-tasks, contracts and checks, written for a developer or a coding agent.

## Diagram index

All diagrams are plain text, so they display the same in an editor, a terminal and a Git web view.

| To understand | Diagram | In |
|---|---|---|
| The system as a whole | The three processes; who knows what | 01 |
| Code layout | Layering inside the extension | 01 |
| Build | Relay with no build, extension with one compile step | 01 |
| One call, end to end | Sequence: client, relay, extension, page | 02 |
| Timing | Timeout timeline; the serial queue | 02 |
| Connection | State machine; handshake sequence | 02 |
| The relay | Map of the file; order of auth checks; how a result is shaped; four ways data gets back | 03 |
| Extension internals | Popup, storage, service worker, offscreen document | 04 |
| Safety check per call | `guard()` decision flow; `browser_batch` flow | 04 |
| Debugger layer | Lazy attach flow; a tab with iframes and the state it produces | 04 |
| Navigation | `navigate` flow with its fallbacks | 04 |
| Clicking | Coordinate and ref paths converging on one mouse event | 05 |
| Screenshots | Device, CSS and frame pixel spaces | 05 |
| Reading a page | Raw accessibility tree against printed output; the life of a ref | 05 |
| Search | `find` pipeline | 05 |
| Forms | `setValue` decision tree | 05 |
| Debug data | Events into ring buffers into `inspect` modes | 06 |
| Video | Capture pipeline; frame throttle timeline; full start-to-stop sequence | 06 |
| Downloads | The session watermark | 06 |
| Overlay | Glow, muted, hidden states | 06 |
| Security | Gates on a call and filters on a result; fencing a hostile page; upload path check; host matching table | 07 |
| Building your own | The eight steps | 08 |
