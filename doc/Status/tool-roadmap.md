# Tool roadmap

This document plans the 15 tools still to build, ranked by difficulty and by usefulness within each category. It was written on 2026-11-21. Difficulty and usefulness are estimates based on the Chrome and CDP APIs each tool needs. None of them were measured. For what is built so far, see [README.md](README.md).

Scale: difficulty ★☆☆☆☆ (an afternoon) to ★★★★★ (the hardest piece in the project). Usefulness: Essential, High, Medium, Low.

## Naming mismatches to fix first

The planned names copy the tools in Claude in Chrome. The repository does not match them yet:

| Planned | In the repo now | Action |
|---|---|---|
| `tabs_context_mcp` | `tabs_list` | Rename |
| `tabs_create_mcp` | `tab_open` | Rename |
| `tabs_close_mcp` | missing | Build |
| `schemas.ts` (TOOLS array) | [relay/mcp/tools.ts](../../relay/mcp/tools.ts) | Decide which file is the source of truth |
| `extension/src/tools.ts` | [extension/src/tools/tools.ts](../../extension/src/tools/tools.ts) | Same |

Rename now, while only two tools exist. The idea that Claude models work better with these names because they were trained on them has not been verified.

## Shared prerequisites

Two pieces are not tools themselves, but most tools depend on them:

1. **Debugger attach and `guard()`** (build guide step 4). This needs the `debugger` permission, which the manifest does not request yet. Every tool except the tabs tools needs it. `guard()` checks for restricted URL schemes, checks that the tab is in the MCP group, and applies the per-tool URL policy.
2. **The ref system in `read_page`** (step 7). `find`, `form_input`, `file_upload` and `computer` (its `scroll_to` action) all take `ref_N` ids. Plan the ref format and lifetime before building any of these tools.

## Tabs and session

| Order | Tool | Difficulty | Usefulness | Notes |
|---|---|---|---|---|
| 1 | `tabs_close_mcp` | ★☆☆☆☆ | Medium | `chrome.tabs.remove` plus a group-membership check. Finishes step 3. |
| – | `tabs_context_mcp` | Done | Essential | Exists as `tabs_list`. Rename only. |
| – | `tabs_create_mcp` | Done | Essential | Exists as `tab_open`. Rename only. |

## Navigation and pages

| Order | Tool | Difficulty | Usefulness | Notes |
|---|---|---|---|---|
| 1 | `navigate` | ★★☆☆☆ | Essential | Changing the URL is easy. The work is the guard, plus waiting reliably for the page to load, including back and forward. |
| 2 | `get_page_text` | ★★☆☆☆ | High | Run a script in the page and truncate at 50k characters. The article-priority heuristic is the only fiddly part. |
| 3 | `javascript_tool` | ★★★☆☆ | Very high | `Runtime.evaluate` with `replMode` and `awaitPromise`. Most of the work is serializing results. This is the most security-sensitive tool in the list. |
| 4 | `read_page` | ★★★★☆ | Essential | Accessibility tree, refs that stay stable across calls, and filter, depth, `ref_id` and `max_chars`. Four other tools depend on it. |
| 5 | `find` | ★★★★☆ | Medium | Matching natural language is hard to do well. `read_page` with a filter covers most cases, so build `find` late. |

## Interaction

`computer` is split into three rows because its actions vary a lot in difficulty.

| Order | Tool | Difficulty | Usefulness | Notes |
|---|---|---|---|---|
| 1 | `computer`: `screenshot`, `wait` | ★★☆☆☆ | Essential | `Page.captureScreenshot` plus downscaling. |
| 2 | `computer`: clicks, `type`, `key`, `scroll`, `hover` | ★★★☆☆ | Essential | `Input.dispatch*` events, key-chord mapping, and converting screenshot coordinates to viewport coordinates. That conversion is where bugs tend to hide. |
| 3 | `form_input` | ★★★☆☆ | High | Resolve the ref, set the value, and fire `input` and `change` events. React-controlled inputs need the native value setter. |
| 4 | `file_upload` | ★★★☆☆ | Medium | `DOM.setFileInputFiles` is simple. Checking that local file paths are safe is the real work. |
| 5 | `computer`: `left_click_drag`, `zoom`, `scroll_to` | ★★★★☆ | Low to medium | Drag needs a sequence of mouse events, and sites handle drag-and-drop in different ways. |
| 6 | `browser_batch` | ★★☆☆☆ | Medium to high | Simple loop: stop on the first error, no nesting, `tabId` required. It is only worth building once the other tools exist, so build it last. |

## Debug, capture and files

These tools are specific to this project. Claude in Chrome does not have them.

| Order | Tool | Difficulty | Usefulness | Notes |
|---|---|---|---|---|
| 1 | `files`: `downloads_list`, `pdf` | ★★☆☆☆ | Medium | `chrome.downloads.search` and `Page.printToPDF`. |
| 2 | `files`: download a URL | ★★★☆☆ | Medium | Needs size limits and path safety when writing to disk. |
| 3 | `inspect` | ★★★★☆ | High for debugging | Logs and network requests are captured only if buffering started before the call. `bodyOf` can fail once Chrome has evicted the response body. Cookies and storage are sensitive and need the policy checks. |
| 4 | `record` | ★★★★★ | Low | Builds a WebM from screencast frames, or uses `tabCapture` with an offscreen document. A lot of effort for a feature that is nice to have. |

## Recommended build order

```text
 1  tabs_close_mcp + renames         step 3
 2  navigate + guard()               step 4   <- unlocks everything below
 3  computer: screenshot             step 5
 4  computer: clicks, keys, scroll   step 6
 5  read_page (refs)                 step 7   <- unlocks find, form_input, file_upload
 6  get_page_text                    step 7
 7  javascript_tool                  step 8
 8  form_input                       step 8
 9  browser_batch                    step 8
10  files, file_upload               step 9
11  inspect                          step 10
12  find                             late: read_page covers most cases
13  computer: drag, zoom, scroll_to  late
14  record                           last: most work, least payoff
```

This mostly follows the [build guide](../Build-guide/README.md). The changes are that `find` and the advanced `computer` actions move later, and `record` moves to the end. If time runs short, skip `record` and `find`. Nothing else depends on them.
