# MCP Browser Automation

Let an AI agent (Claude Code or any other MCP client) use **your own browser**: open tabs, load pages and, as more tools are built, read, screenshot and click them.

## What it does and why

Most browser-automation tools start a separate, empty browser. This project instead connects the agent to the Chrome or Edge you already use, with your logins and cookies, so it can work on the sites you are signed in to.

It is only a bridge. There is no AI model and no API key inside. The agent runs in your MCP client; this project carries its tool calls to the browser and the results back.

Safety is built in from the start:

- The agent works only in its own orange **"MCP Browser" tab group** and cannot touch your other tabs.
- A **site policy** blocks dangerous URLs (`javascript:`, cloud metadata addresses) and any sites you list in the extension popup.
- The relay accepts connections **from this computer only**.

## How it works

```text
+-------------+  HTTP /mcp   +---------+  WebSocket /ext  +-----------+  CDP (chrome.debugger)  +------+
| MCP client  | -----------> |  Relay  | <--------------- | Extension | ----------------------> | Tabs |
| (AI agent)  | <----------- | (Node)  | ---------------> | (browser) | <---------------------- |      |
+-------------+  tool result +---------+  call / result   +-----------+       page results      +------+
```

| Part | Where | Job |
|---|---|---|
| **MCP client** | Claude Code, etc. | The AI agent. Decides which tool to call. |
| **Relay** | [relay/](relay/) | A small Node server on `127.0.0.1:8787`. Speaks MCP to the client and forwards each call to the extension. |
| **Extension** | [extension/](extension/) | Runs inside your browser. Checks each call against the safety rules, then carries it out. |
| **CDP** | [extension/src/cdp/](extension/src/cdp/) | The Chrome DevTools Protocol: how the extension acts *inside* a page (navigate, and later read, screenshot, click). Chrome shows a "started debugging this browser" bar while it is in use. |

The WebSocket arrow points from the extension to the relay on purpose: a browser extension cannot listen on a port, so the extension **dials out** to the relay.

### One tool call

```text
1. Agent calls  navigate { url: "example.com" }
2. Relay        validates the arguments, sends the call to the extension
3. Extension    checkToolCall: is it the agent's tab? is the URL allowed?
4. Extension    loads the page through CDP and waits for it
5. Relay        returns the result to the agent, marked as untrusted page content
```

## Tools

| Tool | What it does |
|---|---|
| `tabs_list` | Lists the tabs in the agent's tab group |
| `tab_open` | Opens a new blank tab in the group |
| `tab_close` | Closes a tab in the group |
| `navigate` | Loads a URL in a group tab and waits for it to finish |

More are planned (page text, screenshots, clicks, forms). See [doc/Status/tool-roadmap.md](doc/Status/tool-roadmap.md).

## Setup

**You need:** Node.js 22.18 or newer, and Chrome or Edge 125 or newer.

1. **Install and build**

   ```sh
   npm install
   npm run build
   ```

2. **Load the extension**
   Open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**, click **Load unpacked** and pick the [extension/](extension/) folder. It appears as **Browser Bridge**.

3. **Start the relay**

   ```sh
   npm run relay
   ```

4. **Connect the browser**
   Click the Browser Bridge icon and press **Connect**. The popup shows **Connected**.

5. **Add it to Claude Code**

   ```sh
   claude mcp add --scope user --transport http browser http://127.0.0.1:8787/mcp
   ```

   The popup's **Start-up** section shows both commands with Copy buttons.

### Settings

| Where | Setting | Default |
|---|---|---|
| Environment | `PORT`: relay port | `8787` |
| Environment | `BROWSER_LAUNCH`: command that starts the browser when a call arrives and none is connected; `off` disables it | platform default |
| Popup › Advanced | Relay URL | `http://127.0.0.1:8787` |
| Popup › Advanced | Open agent tabs in: main window, separate window, or incognito | separate window |
| Popup › Advanced | Blocked sites, allowed sites (one per line), allow `file://` URLs | none, none, off |

### Development

```sh
npm run check   # type-check the extension and the relay
npm run build   # compile the extension to extension/dist/
npm test        # build, then run the tests in test/
```

After changing extension code, run `npm run build` and press the reload button on the extension's card in `chrome://extensions`.

## Project layout

```text
relay/                 the MCP server (Node, no build step)
  mcp/                 tool definitions and the MCP endpoint
  ext/                 the WebSocket to the extension
  browser/             starts the browser when needed
extension/             the browser extension (TypeScript, compiled to dist/)
  src/connection/      the WebSocket to the relay, one call at a time
  src/tools/           tool handlers and the tab group
  src/policy/          the site policy: which URLs are allowed
  src/cdp/             the Chrome DevTools Protocol link to each tab
  src/popup/           the popup window
  src/shared/          wire format, settings, errors
test/                  unit tests (node --test)
doc/                   build guide, architecture notes, status
```

## Further reading

- [doc/Status/README.md](doc/Status/README.md): what is built and what is checked
- [doc/Build-guide/README.md](doc/Build-guide/README.md): the step-by-step build plan this project follows
- [doc/Architecture/](doc/Architecture/): detailed notes on each part
