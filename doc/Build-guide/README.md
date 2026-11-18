# Build guide: a browser bridge for MCP, step by step

This guide builds a system like Rakuten Hashi from an empty folder in 15 steps. Each step adds one capability on top of the previous one and ends with checks that prove it works. It is written for two readers: a developer doing it by hand, and a coding agent doing one step per session.

The study notes one level up (`doc/01` to `doc/08`) explain **why** the reference is built the way it is. This guide says **what to build, in what order**.

## What you are building

```text
+------------+   HTTP POST /mcp    +----------+   WebSocket /ext    +-----------+  chrome.debugger  +------+
| MCP client |  ---------------->  | relay.ts |  <----------------  | Extension |  -------------->  | Tabs |
+------------+                     +----------+                     +-----------+                   +------+
```

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

## Tool names

The guide uses its own tool names, one tool per action. Write your own descriptions for them. The reference instead mirrors another product's tool set and packs several actions into one `computer` tool; do not copy those descriptions into a project you publish unless you know you may.

| Guide tool | Reference equivalent |
|---|---|
| `tabs_list`, `tab_open`, `tab_close` | `tabs_context_mcp`, `tabs_create_mcp`, `tabs_close_mcp` |
| `navigate` | `navigate` |
| `screenshot` | `computer` actions `screenshot`, `zoom` |
| `click`, `type_text`, `press_key`, `scroll` | `computer` actions `left_click` (and the other clicks, `hover`, `left_click_drag`), `type`, `key`, `scroll` |
| `read_page`, `find`, `page_text` | `read_page`, `find`, `get_page_text` |
| `run_js`, `set_field`, `batch` | `javascript_tool`, `form_input`, `browser_batch` |
| `upload_file`, `files`, `inspect`, `record` | `file_upload`, `files`, `inspect`, `record` |

## Target layout

File names match the reference, so every "Reference" pointer in a step maps to a real file you can read.

```text
package.json  tsconfig.json  .gitignore
relay.ts                 server: HTTP, WebSocket, MCP                          steps 1, 2, 3, 9, 12
relay-lib.ts             pure helpers the relay uses (testable)                steps 1, 3, 9, 12
tools.ts                 MCP tool definitions (reference: schemas.ts)          every tool step
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
    snapshot.ts          accessibility tree, refs, JS helpers                  steps 5, 7
    files.ts  upload.ts  downloads, PDF, PUT to the relay                      step 9
    inspect.ts           buffers, run_js                                       steps 8, 10
    record.ts  offscreen.ts  overlay.ts                                        step 13
    popup.ts             settings UI                                           steps 2, 4, 12
```

Two deliberate differences from the reference, both for testability. The reference has no tests; this guide adds them as you go.

- **Pure relay functions live in `relay-lib.ts`.** Importing `relay.ts` starts a server, so nothing in it can be unit-tested.
- **Pure extension logic lives in modules that never touch `chrome`**: `policy.ts` (as in the reference), plus `frame.ts`, `keys.ts` and `query.ts`, which the reference keeps inside `capture.ts`, `input.ts` and `snapshot.ts`. A module such as `cdp.ts` registers `chrome.*` listeners when it loads, so a test that imports it, or anything that imports it, fails under Node with "chrome is not defined".

## How each step file is laid out

| Section | Content |
|---|---|
| **Goal** | One sentence |
| **Builds on** | What must already work |
| **Files** | Created or changed in this step |
| **Sub-tasks** | Numbered `N.1`, `N.2`... in the order to do them. Each says what to build, the detail that is easy to get wrong, and where the reference does it. |
| **Contracts** | The types and signatures other steps depend on. Keep these exact. |
| **Done when** | Checks. `[auto]` can be run from a shell. `[browser]` needs a person or a browser-capable agent to look. |
| **Pitfalls** | Mistakes this step invites |
| **Carry forward** | Invariants that later steps rely on |

Code blocks are **sketches adapted from the reference**, shortened to show the shape. Treat them as a starting point to type-check and run, not as finished code.

## Rules for every step

For a developer these are habits; for an agent they are constraints.

1. **One step per change set.** Finish a step's "Done when" list before starting the next. Do not start work from a later step early.
2. **`npm run check` and `npm test` pass at the end of every step.** No exceptions, no skipped tests.
3. **Keep the contracts.** If a contract must change, change it in `protocol.ts` first so both halves fail to compile until they agree.
4. **Never weaken a guard to make a check pass.** If a "Done when" item fails because a guard blocks it, the test is wrong or the guard has a bug: find out which.
5. **New pure logic gets a test in the same step**, and lives in a module with no `chrome` access so the test can import it. Parsing, scoring, path and URL rules, text shaping.
6. **Errors are instructions.** Every `ToolError` message says what happened and what the model should do next.
7. **Bound every output.** No tool returns unlimited text.
8. **Report honestly.** State which checks were run and their output, and which `[browser]` checks were not run.

### For an agent working a step

```text
 1. Read this README and the step file. Read the "Carry forward" of every earlier step.
 2. Read the files the step lists under "Reference" before writing code.
 3. Do the sub-tasks in order. After each: npm run check.
 4. Run every [auto] check. Paste the real output in your report.
 5. For [browser] checks: run them if you can drive a browser; otherwise list them as
    NOT RUN and give the human the exact clicks to perform.
 6. Stop. Do not continue into the next step unless asked.
```

## What has and has not been verified

This guide is derived from reading the reference implementation, which type-checks. The system described here was **not built from this guide**, so the steps as a sequence are untested, and no `[browser]` check was run. The following were run against the reference relay on Node 24.22.1 and behave as the step files say:

- **Step 1:** the three `curl` requests and the shape of their responses; 403 for a forged `Host`, a web `Origin` and `X-Forwarded-For`; 405 for `GET /mcp`; 404 for an unknown path; 406 when only one `Accept` type is sent.
- **Step 3:** a `tools/call` with no extension connected returns the "No browser connected" error at once.
- **Step 4:** the policy verdicts (through the compiled `checkUrl`).
- **Step 9:** the upload with `..%2F` in its name is stored as a plain basename and can be fetched back; the three response headers on a stored HTML file; 404 for a malformed id and for a missing file.
- **Step 12:** 401 with no or a wrong token, success with the right one; `?token=` accepted on `/files` and refused on `/mcp`.
- **Tests:** `node --test "test/*.test.ts"` runs a TypeScript test that imports a compiled, chrome-free extension module.

Every "Reference" pointer was checked to exist and to land on the code named.

## Prerequisites

- Node 22.18 or newer (the relay runs `.ts` files directly).
- Chrome or Edge 125 or newer.
- An MCP client for end-to-end checks (Claude Code, Cursor). `curl` covers everything up to step 3.
