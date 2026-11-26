# Tool roadmap

The order in which to build the tools after the tab tools, ranked by difficulty and usefulness within each category. The **Done** column shows ✅ for built tools, 🟨 for partly built ones and ⬜ for tools still to build. For what is built so far, see [README.md](README.md).

Difficulty and usefulness are estimates based on the Chrome and CDP APIs each tool needs. None of them were measured. Difficulty runs from ★☆☆☆☆ (an afternoon) to ★★★★★ (the hardest piece in the project).

## Naming

Tools use short, plain names: `tabs_list`, `tab_open`, `tab_close`, `navigate`, `read_page` and so on.

**Open question:** the reference schema copies its first ten tools from the Claude in Chrome extension, so Claude models meet the tools they were trained on. `form_input` and `file_upload` follow that extension's conventions; `inspect`, `record` and `files` are this project's own. In the extension, the tab tools are `tabs_context_mcp`, `tabs_create_mcp` and `tabs_close_mcp`, and every `tabId` description says to call `tabs_context_mcp` first. Decide which names to keep before copying more of that schema. If the names here stay, rewrite those descriptions to say `tabs_list`.

Tool definitions live in [relay/mcp/tools.ts](../../relay/mcp/tools.ts), and the handlers in [extension/src/tools/tools.ts](../../extension/src/tools/tools.ts).

## Shared prerequisites

Two pieces are not tools themselves, but most tools depend on them:

1. **Debugger attach and the guard** (build guide step 4). **Built**: `extension/src/cdp/cdp.ts` (`sendCdpCommand`), and `checkToolCall` in `tools.ts`, which checks that the tab is in the group and applies the site policy (`extension/src/policy/policy.ts`) before every tool.
2. **The ref system in `read_page`** (step 7). `find`, `form_input`, `file_upload` and `computer`'s `scroll_to` action all take `ref_N` ids. `computer`'s click actions take a `ref` as an optional alternative to `coordinate`. Decide the ref format and lifetime before building any of these tools.

## Interacting with a page

The order a model uses the tools in to work on a page:

1. `tab_open`: open its own tab.
2. `navigate`: go to the URL.
3. Find the target, in one of two ways:
   - `computer` `screenshot`, then read the element's coordinates off the image. The `computer` description tells the model to do this before clicking.
   - `read_page` or `find`, to get the element's `ref`.
4. `computer`: act on it with `left_click` (click), `type` (enter text), `key` (press a key, such as Enter), `scroll` (scroll the page) or `screenshot` (check the result).
5. `form_input`: use instead of clicking and typing for selects and checkboxes.
6. `tab_close`: close the tab when done.

Clicks take `coordinate`, with `ref` as an optional alternative, so `computer` alone (screenshot plus coordinate clicks) is enough for a full interaction. `read_page` makes clicks less fragile and is required for `form_input`, `file_upload` and `scroll_to`.

## Tabs

| Done | Tool | Reference name | Notes |
|---|---|---|---|
| ✅ | `tabs_list` | `tabs_context_mcp` | Optional `createIfEmpty` creates a new window with a group and an empty tab; it has no effect if the group exists. The reference description says to call it at least once before any other browser tool, and to use a new tab per conversation. |
| ✅ | `tab_open` | `tabs_create_mcp` | No inputs. The reference description says tabs the model creates are its to close before finishing, unless the user wants them kept open. |
| ✅ | `tab_close` | `tabs_close_mcp` | `tabId` required, and must be in the group. Closing the last tab removes the group, so the next `createIfEmpty` starts fresh. |

The only step 3 work left is the browser checks listed in [README.md](README.md).

## Navigation and pages

| Done | Order | Tool | Difficulty | Usefulness | Notes |
|---|---|---|---|---|---|
| ✅ | 1 | `navigate` | ★★☆☆☆ | Essential | Built without back and forward. Changing the URL is easy; the work was the guard and waiting reliably for the page to load. Still to match the reference schema: `url: "back"` / `"forward"` (both need `tabId`), and an optional `tabId` when navigate is called on its own, which creates the tab group if needed, navigates its first tab and appends the tab list to the result. A tab opened this way is the model's to close, like one from `tab_open`. Inside `browser_batch`, `tabId` is always required. |
| ✅ | 2 | `get_page_text` | ★★☆☆☆ | High | Runs a script in the page; returns 50,000 characters per call, with `offset` for the rest. The article-priority heuristic is the only fiddly part. |
| ⬜ | 3 | `javascript_tool` | ★★★☆☆ | Very high | Takes `action` (must be `"javascript_exec"`), `text` and `tabId`, all required. `Runtime.evaluate` with `replMode` and `awaitPromise`: top-level `await` works and the last expression's value is returned, so the model writes no `return`. Most of the work is serializing results. The most security-sensitive tool in the list. |
| ⬜ | 4 | `read_page` | ★★★★☆ | Essential | Accessibility tree with refs that stay stable across calls. Only `tabId` is required. `filter` is `all` (the default, including non-visible elements) or `interactive` (buttons, links and inputs); `depth` defaults to 15; `ref_id` reads one element and its children; `max_chars` defaults to 50,000, and longer output is cut at a line boundary with a note giving the full size. Four other tools depend on it. |
| ⬜ | 5 | `find` | ★★★★☆ | Medium | Takes `query` and `tabId`. Returns up to 20 matches with refs; if there are more, it tells the model to use a more specific query. Matching natural language well is hard. `read_page` with a filter covers most cases. |

## Interaction

`computer` takes four rows because its actions vary a lot in difficulty. Every action needs `action` and `tabId`.

| Done | Order | Tool | Difficulty | Usefulness | Notes |
|---|---|---|---|---|---|
| ✅ | 1 | `computer`: `screenshot`, `wait` | ★★☆☆☆ | Essential | Both built. `Page.captureScreenshot` plus downscaling. `scale` (0.1 to 1, default 1) shrinks the returned image, but coordinates are always in the full-resolution frame, so each screenshot result must report that frame's size. `wait` takes `duration` in seconds, up to 10. |
| ✅ | 2 | `computer`: `left_click`, `type`, `key`, `scroll` | ★★★☆☆ | Essential | All four built as `left_click`, `type_text`, `press_key` and `scroll`: mouse and keyboard in `extension/src/tools/input.ts` (`Input.dispatch*` events), with the frame-to-CSS conversion in `toCss` (`extension/src/tools/frame.ts`). Converting the screenshot frame to CSS viewport pixels (downscale and `devicePixelRatio`) is where bugs tend to hide. `left_click` takes `coordinate` (x, y). `type_text` takes `text` and an optional `submitKey`. `press_key` takes space-separated keys and chords such as `ctrl+a`; page-zoom shortcuts (`ctrl+=`, `ctrl+-`, `ctrl+0`) return an error. `scroll` takes `coordinate`, `scrollDirection` and `scrollAmount` (1 to 10 ticks, default 3); one tick is 100 CSS px, and the wheel goes to the element under the coordinate, so a scrollable panel scrolls instead of the page. Left out on purpose: `modifiers` on clicks (shift+click range select, ctrl/cmd+click multi-select), `repeat` on `key`, and `action_summary`, which nothing in the extension shows or logs. Add `action_summary` only together with a UI that displays it, such as an action feed or an approval prompt. |
| ✅ | 3 | `computer`: `right_click`, `double_click`, `triple_click`, `hover` | ★★☆☆☆ | Medium | All four built in `extension/src/tools/input.ts`. `click` serves all four click actions from a table of button and click count. A double or triple click sends one press-release pair per click with `clickCount` 1, 2, 3, as a real mouse does. `hover` sends one `mouseMoved` event; the mouse stays there until the next mouse event, so a hover menu stays open for the next screenshot. Hovering over an element by `ref` waits for row 4. `hover` moves the mouse without clicking, to coordinates or an element. |
| ⬜ | 4 | `computer`: `ref` on clicks | ★★☆☆☆ | High | Resolve the ref to the element's center in place of `coordinate`. Needs `read_page`. |
| ⬜ | 5 | `form_input` | ★★★☆☆ | High | For selects and checkboxes, in place of clicking and typing. Takes `ref`, `value` and `tabId`, all required. `value` is a string, boolean or number: a boolean for checkboxes, the option value or text for selects. Resolve the ref, set the value, and fire `input` and `change` events. React-controlled inputs need the native value setter. |
| ⬜ | 6 | `file_upload` | ★★★☆☆ | Medium | Takes `paths`, `ref` and `tabId`, all required. The ref can be the file input or an element containing it, so the handler has to find the input inside it. Paths are absolute paths on the machine running the browser. The description tells the model never to click the input, because that opens a native file picker it cannot see. `DOM.setFileInputFiles` is simple. Checking that local file paths are safe is the real work. |
| ⬜ | 7 | `computer`: `left_click_drag`, `zoom`, `scroll_to`, `save_to_disk` | ★★★★☆ | Low to medium | Drag goes from `start_coordinate` to `coordinate` and needs a sequence of mouse events; sites handle drag-and-drop in different ways. `zoom` captures a `region` (x0, y0, x1, y1 in viewport pixels) and takes `scale`. `scroll_to` needs a `ref`. `save_to_disk` saves a screenshot or zoom image and returns its path. |
| ⬜ | 8 | `browser_batch` | ★★☆☆☆ | Medium to high | Takes `actions`, a list of `{name, input}` where `input` is exactly what the tool takes on its own. Runs them in order and stops on the first error; no nesting. Each item goes through its own guard check, and page tools need an explicit `tabId`. Screenshots come back interleaved with the outputs, and coordinates in a batch refer to the screenshot taken before it. Only worth building once the tools it runs exist. |

## Debug, capture and files

Claude in Chrome has no equivalent of these tools.

| Done | Order | Tool | Difficulty | Usefulness | Notes |
|---|---|---|---|---|---|
| ⬜ | 1 | `files`: `downloads_list`, `pdf` | ★★☆☆☆ | Medium | `chrome.downloads.search` (`limit`, default 20) and `Page.printToPDF` (`tabId` required). Returns name, size and a URL to fetch with the same Bearer token. |
| ⬜ | 2 | `files`: `download` | ★★★☆☆ | Medium | Saves a `url` using the browser session. Needs size limits and path safety when writing to disk. |
| ⬜ | 3 | `inspect` | ★★★★☆ | High for debugging | `mode` is `console`, `network`, `errors`, `cookies` or `storage`; `limit` returns the newest N entries (default 50). Network filters: `url` substring, `method`, `status`, and `bodyOf` with a requestId for one response body. Recording starts the first time a tab is used, so the tab must be reloaded to capture its page load. `bodyOf` fails once Chrome has evicted the response body. Cookies and storage are sensitive and need the policy checks. |
| ⬜ | 4 | `record` | ★★★★★ | Low | `action` is `start`, `stop` or `frames`; `tabId` is required for `start` and `frames`. `start` takes `fps` (1 to 30, default 10) and `maxSeconds` (1 to 300, default 60) and brings the tab to the front; `stop` returns the WebM URL, fetched with the same Bearer token. `frames` takes `count` (1 to 20, default 5) JPEG screenshots `intervalMs` apart (default 1000). One recording at a time. Built from screencast frames, or `tabCapture` with an offscreen document. A lot of work for a nice-to-have. |
