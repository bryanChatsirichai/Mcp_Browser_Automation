# 1. Architecture and setup

## The three processes

```text
 Machine A (anywhere)            Machine B (the one with your browser)
+----------------------+        +-----------------------------------------------------------+
|  MCP client          |        |  relay.ts (Node)            Chrome / Edge                 |
|  Claude Code, Cursor |  HTTP  |  +-------------------+      +--------------------------+  |
|                      | -----> |  | /mcp   MCP server |      | Extension service worker |  |
|                      |        |  | /ext   WebSocket  | <--- |   background.ts          |  |
|                      |        |  | /upload  PUT      | <--- |   (fetch PUT)            |  |
|                      | <----- |  | /files   GET      |      |        |                 |  |
+----------------------+        |  +-------------------+      |        | chrome.debugger |  |
                                |        |                    |        v                 |  |
                                |        v                    |   Tabs in "MCP" group    |  |
                                |   ./files on disk           +--------------------------+  |
                                +-----------------------------------------------------------+
```

| Process | Code | Job | State it holds |
|---|---|---|---|
| MCP client | not in this repo | Decides what to do | The conversation |
| Relay | `relay.ts`, `schemas.ts` | Speaks MCP to clients, forwards calls, stores files, checks auth | One extension socket, a map of pending calls |
| Extension | `extension/src/*` | Executes calls on tabs via CDP | Debugger attachments, element refs, console and network buffers |

### Who knows what

The split of knowledge between the two halves explains most of the code layout:

```text
                 RELAY knows                         EXTENSION knows
          +-----------------------------+     +-----------------------------+
          | ports, HTTP, MCP            |     | tabs, tab groups            |
          | tokens, who is calling      |     | CDP, pages, iframes         |
          | the local disk, symlinks    |     | the live URL of each tab    |
          | how to label output         |     | the browser's downloads     |
          +-----------------------------+     +-----------------------------+
          | does NOT know what any tool |     | does NOT know who the       |
          | does: it forwards           |     | client is or how it reached |
          | {tool, args} and wraps the  |     | the relay                   |
          | answer                      |     |                             |
          +-----------------------------+     +-----------------------------+
```

The relay and the browser must be on the **same machine**: `file_upload` paths and browser downloads are read from the local disk (`README.md:80`). The client can be anywhere if you set a token and tunnel the port.

## Why this shape

Each choice below solves a constraint. These are the ideas worth copying.

**1. The extension dials out; the relay listens.**
An extension service worker can open a WebSocket but cannot accept connections. So the relay owns the port and the extension connects to `ws://<relay>/ext` (`background.ts:141-152`). Side benefit: an open WebSocket with traffic keeps the Manifest V3 service worker alive, which Chrome would otherwise stop after about 30 seconds of idleness (`background.ts:183`).

**2. `chrome.debugger` instead of content scripts.**
The extension asks for the `debugger` permission and no host permissions (`manifest.json:7`). Through CDP it gets real input events (`Input.dispatchMouseEvent`), screenshots, the accessibility tree, network events and JS evaluation, with one mechanism, on any site, inside iframes. The cost is the yellow "debugging this browser" bar.

**3. The relay is a thin, mostly dumb pipe.**
The relay does not know what `computer` or `read_page` mean. It lists the schemas, forwards `{tool, args}` and wraps the answer. Tool logic lives in one place (the extension). The relay only adds what the browser cannot do: listen on a port, touch the file system, resolve symlinks, fence output.

**4. Stateless MCP.**
Every `POST /mcp` builds a fresh MCP `Server` and transport, answers, and throws them away (`relay.ts:514-524`). No sessions to track, expire or resume. This works because the real state lives in the browser, addressed by `tabId`.

**5. One shared protocol file.**
`extension/src/protocol.ts` defines the wire messages and argument types. Both sides import it: the extension as `./protocol.js`, the relay as `./extension/src/protocol.ts` (`relay.ts:21-27`). A change to the wire format fails the type-check on both sides.

**6. Tool schemas that the model already knows.**
The repo's comment says the first ten tool definitions are copied from the Claude in Chrome extension "so Claude models meet the tools they were trained on" (`schemas.ts:1-3`). I could not check that claim. The design idea is sound either way: a model performs better with tool names and shapes it has seen before.

## File map

```text
relay.ts                 The server: HTTP, WebSocket, MCP, auth, file storage, output fencing
schemas.ts               15 tool definitions served by tools/list
stamp.ts                 Build step: writes extension/dist/install.json with the path of relay.ts

extension/
  manifest.json          MV3 manifest: permissions, service worker, popup
  popup.html             Settings UI (markup + CSS, no framework)
  offscreen.html         Empty page that hosts the video encoder
  src/
    protocol.ts          Wire messages and tool argument types (shared with the relay)
    errors.ts            ToolError (code + message) and its wire form
    settings.ts          Settings in storage.local, connection status in storage.session

    background.ts        Service worker entry: socket, reconnect, call queue, timeouts
    tools.ts             Dispatch table, guard(), browser_batch, small tools
    policy.ts            URL allow/block rules

    cdp.ts               chrome.debugger wrapper: attach, sessions, frames, refs, event fan-out
    tabs.ts              The "MCP" tab group, tab context text, navigation

    computer.ts          The `computer` tool: maps actions to input/capture calls
    input.ts             Mouse, keyboard, form controls, file inputs
    capture.ts           Screenshot and zoom; the coordinate frame
    snapshot.ts          Accessibility tree, read_page, find, ref resolution, JS helpers

    inspect.ts           Console/network/error buffers, cookies, storage, javascript_tool
    record.ts            Screencast control (service worker side)
    offscreen.ts         WebM encoding (offscreen document side)
    files.ts             Downloads, PDF
    upload.ts            PUT a blob to the relay
    overlay.ts           Glow border and fake cursor drawn in the page

    popup.ts             Popup logic
```

### Layering inside the extension

```text
                    background.ts            (transport: socket, queue, timeouts)
                         |
                      tools.ts               (dispatch + guard + batch)
        ______________/  |   \________________________
       /           /     |      \          \          \
 computer.ts  snapshot.ts  inspect.ts  record.ts  files.ts  tabs.ts      (features)
       \         |    \      |           |          |         /
     input.ts  capture.ts   overlay.ts   upload.ts  policy.ts            (helpers)
              \      |      /
                  cdp.ts                     (the only caller of chrome.debugger.sendCommand)
```

`cdp.ts` is the single choke point for debugger commands, and it attaches lazily: every `send()` first awaits `attach(tabId)` (`cdp.ts:80-88`). No feature has to ask "am I attached?".

## Setup and toolchain

### No build for the relay, a minimal build for the extension

| Piece | How it runs | Why it works |
|---|---|---|
| Relay | `node relay.ts` directly | Node runs TypeScript by stripping types. The repo requires Node 22.18+ (`package.json:7`). `erasableSyntaxOnly` in `tsconfig.json` forbids syntax that cannot be stripped (enums, namespaces, parameter properties). |
| Extension | `tsc -p extension` emits one `.js` per `.ts` into `extension/dist/` | Chrome loads the service worker as a native ES module (`"type": "module"` in `manifest.json:10`). Imports are written with `.js` extensions (`./cdp.js`) so the emitted files resolve without a bundler. |

```text
 RELAY: no build                                EXTENSION: one compile step

 relay.ts -----------------+                    extension/src/*.ts
 schemas.ts ---------------+--> node relay.ts        |
 extension/src/protocol.ts +   (types stripped       |  tsc -p extension
                                at load time,        |  (one .ts in, one .js out, no bundling)
                                nothing written)     v
                                                extension/dist/*.js ------> loaded by Chrome as
                                                     |                      native ES modules
                                                     |  node stamp.ts
                                                     v
                                                extension/dist/install.json  {"relay": "/abs/path/relay.ts"}
                                                                             read by the popup
```

The `protocol.ts` header notes the consequence: because the relay imports it directly, that file must stay erasable (`protocol.ts:1-2`). Both `tsconfig.json` files set `erasableSyntaxOnly`, so a class such as `ToolError` or `ExtensionError` must declare its fields explicitly; `constructor(public code: string)` would not compile.

`devtools-protocol` is a dev dependency used only through `import type`. With `verbatimModuleSyntax`, those imports vanish from the output, so the extension ships no third-party code while still getting fully typed CDP calls (`cdp.ts:66-78`).

### Scripts (`package.json:9-13`)

| Script | Command | Purpose |
|---|---|---|
| `npm run relay` | `node relay.ts` | Start the server on `127.0.0.1:8787` |
| `npm run build` | `tsc -p extension && node stamp.ts` | Compile the extension, then record where `relay.ts` lives |
| `npm run check` | `tsc -p . && tsc -p extension --noEmit` | Type-check both halves |

Two `tsconfig.json` files exist because the halves target different worlds: the root one uses `NodeNext` and Node types with `noEmit`; the extension one uses `Bundler` resolution, DOM and `chrome` types, and emits.

### The `stamp.ts` trick

An extension cannot learn its own folder on disk. The popup wants to show a copy-paste command `node /absolute/path/relay.ts`. So the build writes that path to `extension/dist/install.json` (`stamp.ts:6-9`), and the popup fetches it as an extension resource (`popup.ts:60-68`). If the file is missing the popup falls back to `npm run relay`.

### Environment variables (`relay.ts:30-48`)

| Variable | Default | Effect |
|---|---|---|
| `PORT` | `8787` | Listening port. The host is always `127.0.0.1`. |
| `RELAY_TOKEN` | empty | If set, required from every client and from the extension. If empty, only local requests are answered. |
| `BROWSER_LAUNCH` | empty | Shell command run when a call arrives and no extension is connected; the relay then waits 20s. |
| `UPLOAD_ROOTS` | `~/Downloads`, `~/Desktop`, `~/Documents` | Folders `file_upload` may read. `./files` is always added. |
| `MAX_UPLOAD_MB` | `500` | Cap on a stored file. |

### Extension permissions (`manifest.json:7`)

| Permission | Used for |
|---|---|
| `debugger` | All page control (CDP) |
| `tabs`, `tabGroups` | The "MCP" tab group, tab URLs and titles |
| `downloads` | `files` tool |
| `storage` | Settings (`local`) and status (`session`) |
| `alarms` | Waking the service worker every 30s to reconnect |
| `offscreen` | The document that encodes video |

## What is absent

Worth knowing before you copy the setup:

- **No tests.** There is no test runner or test file in the repo. `npm run check` is the only automated gate.
- **No linter or formatter config.**
- **No CI config.**
- The version string `0.2.0` is written in three places: `package.json`, `manifest.json`, and the MCP server info in `relay.ts:432`.
