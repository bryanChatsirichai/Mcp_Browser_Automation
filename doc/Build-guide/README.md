# Build guide: a browser bridge for MCP, step by step

This guide takes you from an empty folder to a working "browser bridge" in 15 steps. The bridge lets an AI agent drive your own logged-in Chrome or Edge through the Model Context Protocol (MCP). Each step adds one capability on top of the previous one and ends with checks that prove it works.

It is written for two readers: a developer doing it by hand, and a coding agent doing one step per session. You do not need access to any existing implementation. Every step describes **what** to build, **why** it is built that way, and **how to check** it. The code itself is yours to write.

## What you are building

```text
+------------+   HTTP POST /mcp    +----------+   WebSocket /ext    +-----------+  chrome.debugger  +------+
| MCP client |  ---------------->  |  Relay   |  <----------------  | Extension |  -------------->  | Tabs |
+------------+                     +----------+                     +-----------+                   +------+
```

| Part | What it is | What it does |
|---|---|---|
| **MCP client** | Claude Code, Cursor, or any client that speaks MCP over HTTP | Lists tools and calls them on the model's behalf |
| **Relay** | A small Node.js server, bound to `127.0.0.1` | Speaks MCP to the client. Forwards each tool call to the extension and returns its answer |
| **Extension** | A Chrome Manifest V3 extension | Connects out to the relay and drives tabs with the Chrome DevTools Protocol (CDP) through the `chrome.debugger` API |

Two design choices shape everything that follows:

- **The extension dials out to the relay.** A browser extension cannot run a server, but it can open a WebSocket. So the relay listens, and the extension connects to it.
- **The relay is stateless toward the MCP client.** It keeps no MCP session. The browser holds all the state that matters: tabs, element ids, recordings. A stateless relay can restart, or sit behind a tunnel, without breaking the client.

## The steps

```text
 FOUNDATION                    0  Project skeleton
                               1  Relay speaks MCP (one stub tool, local-only)
                               2  Extension connects and stays connected
                               3  Round trip: first real tool call          <- first end-to-end result
                                        |
 DRIVING A PAGE                4  Debugger layer, navigate, per-call guard
                               5  Screenshots and the coordinate frame
                               6  Mouse and keyboard                        <- an agent can now use a site
                               7  Reading the page: tree, refs, find
                               8  JavaScript, forms, batching
                                        |
 AROUND THE PAGE               9  Files: storage, PDF, downloads, uploads
                              10  Inspect: console, network, dialogs
                              11  Iframes
                              12  Remote access: token, tunnels, auto-launch
                              13  Recording and the on-page overlay
                                        |
 FINISH                       14  Hardening and release checklist
```

| Step | File | Adds | New tools |
|---|---|---|---|
| 0 | [step-00-skeleton.md](step-00-skeleton.md) | Toolchain, empty relay, empty extension | |
| 1 | [step-01-relay-mcp.md](step-01-relay-mcp.md) | HTTP server, MCP endpoint, local-only gate | `tabs_list` (stub) |
| 2 | [step-02-extension-connects.md](step-02-extension-connects.md) | WebSocket link, handshake, keepalive, popup | |
| 3 | [step-03-round-trip.md](step-03-round-trip.md) | Call/result, queue, timeouts, errors, output fence, tab group | `tabs_list`, `tab_open`, `tab_close` |
| 4 | [step-04-cdp-navigate-guard.md](step-04-cdp-navigate-guard.md) | CDP wrapper, navigation, tab scope, site policy | `navigate` |
| 5 | [step-05-screenshots.md](step-05-screenshots.md) | Capture, coordinate frame, zoom | `screenshot` |
| 6 | [step-06-mouse-keyboard.md](step-06-mouse-keyboard.md) | Trusted input events | `click`, `type_text`, `press_key`, `scroll` |
| 7 | [step-07-read-page.md](step-07-read-page.md) | Accessibility tree, element refs, search | `read_page`, `find`, `page_text` |
| 8 | [step-08-js-forms-batch.md](step-08-js-forms-batch.md) | Page JS, form controls, multi-step calls | `run_js`, `set_field`, `batch` |
| 9 | [step-09-files.md](step-09-files.md) | File side channel, PDF, downloads, safe uploads | `files`, `upload_file` |
| 10 | [step-10-inspect.md](step-10-inspect.md) | Event buffers, dialogs | `inspect` |
| 11 | [step-11-iframes.md](step-11-iframes.md) | Sessions and frames | |
| 12 | [step-12-remote-access.md](step-12-remote-access.md) | Token auth, tunnels, browser auto-launch | |
| 13 | [step-13-record-overlay.md](step-13-record-overlay.md) | Video, visual feedback | `record` |
| 14 | [step-14-hardening.md](step-14-hardening.md) | Tests, validation, cleanup, release checks | |

You have a usable product after step 8. Steps 9 to 13 are independent of each other, except that step 13 needs the upload route from step 9.

## Tool design

The guide gives one tool per action, with short names (`click`, `type_text`, `screenshot`). Write your own descriptions for each tool. A good description says what the tool does, what each argument means and its unit, and what the model should do first (for example "call `tabs_list` before any other tool").

You may prefer fewer, larger tools: for example, one `computer` tool whose `action` argument selects click, type, scroll or screenshot. That works too. Fewer tools mean a shorter tool list for the model; more tools mean simpler schemas. Pick one style and keep to it.

## Suggested layout

The file names are suggestions; the step files use them so that "add X to `cdp.ts`" is unambiguous.

```text
package.json  tsconfig.json  .gitignore
relay/relay.ts           server: HTTP, WebSocket, MCP                          steps 1, 2, 3, 9, 12
relay/relay-lib.ts       pure helpers the relay uses (testable)                steps 1, 3, 9, 12
relay/tools.ts           MCP tool definitions (name, description, schema)      every tool step
stamp.ts                 build step for the popup                              step 12
test/*.test.ts           node --test                                           every step
extension/
  manifest.json  popup.html  offscreen.html  tsconfig.json
  src/
    protocol.ts          wire messages, argument types                         steps 2, 3, then every tool
    errors.ts            ToolError                                             step 3
    settings.ts          settings and status storage                           step 2
    background.ts        socket, reconnect, queue, timeouts                    steps 2, 3
    tools.ts             dispatch table, guard, batch                          steps 3, 4, 8
    tabs.ts              tab group, navigation                                 steps 3, 4
    policy.ts            URL rules                                             step 4
    cdp.ts               debugger wrapper                                      steps 4, 7, 10, 11
    frame.ts             coordinate arithmetic (pure)                          step 5
    capture.ts           screenshots                                           step 5
    keys.ts              key and modifier tables (pure)                        step 6
    input.ts             mouse, keyboard, form controls                        steps 6, 8, 9
    query.ts             find: parse and score (pure)                          step 7
    snapshot.ts          accessibility tree, refs, page helpers                steps 5, 7
    files.ts  upload.ts  downloads, PDF, PUT to the relay                      step 9
    inspect.ts           buffers, run_js                                       steps 8, 10
    record.ts  offscreen.ts  overlay.ts                                        step 13
    popup.ts             settings UI                                           steps 2, 4, 12
```

Two rules keep this testable:

- **Pure relay functions live in `relay/relay-lib.ts`.** Importing `relay/relay.ts` starts a server, so nothing inside it can be unit-tested.
- **Pure extension logic lives in modules that never touch `chrome`**: `policy.ts`, `frame.ts`, `keys.ts`, `query.ts`. A module such as `cdp.ts` registers `chrome.*` listeners when it loads, so a test that imports it, or imports anything that imports it, fails under Node with "chrome is not defined".

## How each step file is laid out

| Section | Content |
|---|---|
| **Goal** | One sentence |
| **Builds on** | What must already work |
| **Files** | Created or changed in this step |
| **Sub-tasks** | Numbered `N.1`, `N.2`... in the order to do them. Each says what to build, why, and the detail that is easy to get wrong. |
| **Interfaces** | The functions and data shapes other steps depend on. Keep their names and meaning; the exact syntax is yours. |
| **Done when** | Checks. `[auto]` can be run from a shell. `[browser]` needs a person or a browser-capable agent to look. |
| **Pitfalls** | Mistakes this step invites |
| **Carry forward** | Rules that later steps rely on |

The guide contains no implementation code. Where order or arithmetic matters, it gives numbered steps, a decision table or a worked example instead. Blocks marked `sh` are commands to run, not code to copy into your project.

## Background you will need

You do not need to know these before starting, but each step assumes you can look them up:

| Topic | Used from | Where to read |
|---|---|---|
| MCP: JSON-RPC methods `initialize`, `tools/list`, `tools/call`; the Streamable HTTP transport | Step 1 | The MCP specification and the official TypeScript SDK's README (`@modelcontextprotocol/sdk`) |
| Chrome extension Manifest V3: service workers, `chrome.storage`, `chrome.alarms`, `chrome.tabs`, `chrome.tabGroups` | Step 0 | Chrome Extensions documentation |
| `chrome.debugger` and the Chrome DevTools Protocol domains `Page`, `Runtime`, `Input`, `DOM`, `Accessibility`, `Network`, `Target` | Step 4 | Chrome DevTools Protocol viewer (chromedevtools.github.io/devtools-protocol) |
| Node's built-in test runner (`node --test`) and type stripping (running `.ts` directly) | Step 0 | Node.js documentation |

## Rules for every step

For a developer these are habits; for an agent they are constraints.

1. **One step per change set.** Finish a step's "Done when" list before starting the next. Do not start work from a later step early.
2. **`npm run check` and `npm test` pass at the end of every step.** No exceptions, no skipped tests.
3. **Keep the interfaces.** If one must change, change the shared wire types (`protocol.ts`) first, so both halves fail to compile until they agree.
4. **Never weaken a guard to make a check pass.** If a "Done when" item fails because a guard blocks it, either the check is wrong or the guard has a bug: find out which.
5. **New pure logic gets a test in the same step**, and lives in a module with no `chrome` access so the test can import it. This covers parsing, scoring, path and URL rules, and text shaping.
6. **Errors are instructions.** Every error message says what happened and what the model should do next.
7. **Bound every output.** No tool returns unlimited text.
8. **Report honestly.** State which checks were run and their output, and which `[browser]` checks were not run.

### For an agent working a step

```text
 1. Read this README and the step file. Read the "Carry forward" of every earlier step.
 2. Read the code you already wrote that the step's "Files" list touches.
 3. Do the sub-tasks in order. After each: npm run check.
 4. Run every [auto] check. Paste the real output in your report.
 5. For [browser] checks: run them if you can drive a browser; otherwise list them as
    NOT RUN and give the human the exact clicks to perform.
 6. Stop. Do not continue into the next step unless asked.
```

## What has and has not been verified

The design, numbers and checks in this guide come from a working implementation. The **sequence** of steps has not been followed end to end to build a new system, so a step may leave a gap that the next one has to fill. If you find one, fix the step file too.

## Prerequisites

- Node 22.18 or newer (the relay runs `.ts` files directly through type stripping).
- Chrome or Edge 125 or newer.
- An MCP client for end-to-end checks (Claude Code, Cursor). `curl` covers everything up to step 3.
