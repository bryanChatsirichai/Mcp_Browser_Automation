# Tool roadmap

The order in which to build the remaining 12 tools, ranked by difficulty and usefulness within each category. For what is built so far, see [README.md](README.md).

Difficulty and usefulness are estimates based on the Chrome and CDP APIs each tool needs. None of them were measured. Difficulty runs from ★☆☆☆☆ (an afternoon) to ★★★★★ (the hardest piece in the project).

## Naming

Tools use short, plain names: `tabs_list`, `tab_open`, `tab_close`, `navigate`, `read_page` and so on.

Tool definitions live in [relay/mcp/tools.ts](../../relay/mcp/tools.ts), and the handlers in [extension/src/tools/tools.ts](../../extension/src/tools/tools.ts).

## Shared prerequisites

Two pieces are not tools themselves, but most tools depend on them:

1. **Debugger attach and `guard()`** (build guide step 4). Every tool except the tab tools needs them. Attaching needs the `debugger` permission, which the manifest does not request yet. `guard()` checks for restricted URL schemes, checks that the tab is in the group, and applies the per-tool URL policy.
2. **The ref system in `read_page`** (step 7). `find`, `form_input`, `file_upload` and `computer`'s `scroll_to` action all take `ref_N` ids. Decide the ref format and lifetime before building any of these tools.

## Tabs

All three tab tools are built: `tabs_list`, `tab_open` and `tab_close`. The only step 3 work left is the browser checks listed in [README.md](README.md).

## Navigation and pages

| Order | Tool | Difficulty | Usefulness | Notes |
|---|---|---|---|---|
| 1 | `navigate` | ★★☆☆☆ | Essential | Changing the URL is easy. The work is the guard, and waiting reliably for the page to load, including after back and forward. |
| 2 | `get_page_text` | ★★☆☆☆ | High | Run a script in the page and truncate at 50k characters. The article-priority heuristic is the only fiddly part. |
| 3 | `javascript_tool` | ★★★☆☆ | Very high | `Runtime.evaluate` with `replMode` and `awaitPromise`. Most of the work is serializing results. The most security-sensitive tool in the list. |
| 4 | `read_page` | ★★★★☆ | Essential | Accessibility tree, refs that stay stable across calls, and `filter`, `depth`, `ref_id` and `max_chars`. Four other tools depend on it. |
| 5 | `find` | ★★★★☆ | Medium | Matching natural language well is hard. `read_page` with a filter covers most cases. |

## Interaction

`computer` takes three rows because its actions vary a lot in difficulty.

| Order | Tool | Difficulty | Usefulness | Notes |
|---|---|---|---|---|
| 1 | `computer`: `screenshot`, `wait` | ★★☆☆☆ | Essential | `Page.captureScreenshot` plus downscaling. |
| 2 | `computer`: clicks, `type`, `key`, `scroll`, `hover` | ★★★☆☆ | Essential | `Input.dispatch*` events, key-chord mapping, and converting screenshot coordinates to viewport coordinates. That conversion is where bugs tend to hide. |
| 3 | `form_input` | ★★★☆☆ | High | Resolve the ref, set the value, and fire `input` and `change` events. React-controlled inputs need the native value setter. |
| 4 | `file_upload` | ★★★☆☆ | Medium | `DOM.setFileInputFiles` is simple. Checking that local file paths are safe is the real work. |
| 5 | `computer`: `left_click_drag`, `zoom`, `scroll_to` | ★★★★☆ | Low to medium | Drag needs a sequence of mouse events, and sites handle drag-and-drop in different ways. |
| 6 | `browser_batch` | ★★☆☆☆ | Medium to high | A simple loop: stop on the first error, no nesting, `tabId` required. Only worth building once the tools it runs exist. |

## Debug, capture and files

Claude in Chrome has no equivalent of these tools.

| Order | Tool | Difficulty | Usefulness | Notes |
|---|---|---|---|---|
| 1 | `files`: `downloads_list`, `pdf` | ★★☆☆☆ | Medium | `chrome.downloads.search` and `Page.printToPDF`. |
| 2 | `files`: download a URL | ★★★☆☆ | Medium | Needs size limits and path safety when writing to disk. |
| 3 | `inspect` | ★★★★☆ | High for debugging | Logs and network requests are captured only if buffering started before the call. `bodyOf` fails once Chrome has evicted the response body. Cookies and storage are sensitive and need the policy checks. |
| 4 | `record` | ★★★★★ | Low | A WebM built from screencast frames, or `tabCapture` with an offscreen document. A lot of work for a nice-to-have. |

## Build order

```text
 1  navigate + guard()               step 4   <- unlocks everything below
 2  computer: screenshot             step 5
 3  computer: clicks, keys, scroll   step 6
 4  read_page (refs)                 step 7   <- unlocks find, form_input, file_upload
 5  get_page_text                    step 7
 6  javascript_tool                  step 8
 7  form_input                       step 8
 8  browser_batch                    step 8
 9  files, file_upload               step 9
10  inspect                          step 10
11  find                             late: read_page covers most cases
12  computer: drag, zoom, scroll_to  late
13  record                           last: most work, least payoff
```

This follows the [build guide](../Build-guide/README.md), except that `find` and the harder `computer` actions move later and `record` moves to the end. If time runs short, skip `record` and `find`: nothing else depends on them.
