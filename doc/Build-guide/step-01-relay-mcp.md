# Step 1: The relay speaks MCP

**Goal.** An MCP client can connect to `http://127.0.0.1:8787/mcp`, list one tool, and call it. Nothing outside this machine can.

**Builds on.** Step 0.

## Background: the MCP shape used here

| Choice | This guide uses | Why |
|---|---|---|
| Wire format | JSON-RPC 2.0 | Required by MCP |
| Transport | **Streamable HTTP**: every client message is an HTTP `POST /mcp`, and the answer comes back on the same response | Works through any HTTP tunnel. stdio would tie the server to one client process; the older SSE transport is deprecated |
| Sessions | **None (stateless)**. No `Mcp-Session-Id` is issued | The relay can restart and the client keeps working. Nothing in the MCP layer needs memory; the browser holds the state |
| Server class | The SDK's **low-level `Server`**, with your own handlers for `tools/list` and `tools/call` | Your tool definitions are plain JSON Schema, and every call takes the same path (forward to the browser). The SDK's higher-level `McpServer` wants a zod schema and a callback per tool, which suits a server that implements each tool itself, not a proxy |
| Capabilities | `tools` only | |

## Files

```text
relay/relay.ts           HTTP server, routing, MCP endpoint
relay/relay-lib.ts       isLocal()                                  (new)
relay/tools.ts           the tool definitions: one for now, tabs_list   (new)
test/relay-lib.test.ts                                              (new)
```

## Sub-tasks

**1.1 HTTP server.** Use Node's built-in `http` module. Listen on host `127.0.0.1`, never `0.0.0.0`, and on the port from a `PORT` environment variable, defaulting to 8787. Add a small `log` helper that prefixes each line with an ISO timestamp.

**1.2 Router.** Write one async `route(req, res)` function. It splits the URL path into segments and picks a handler with a plain if / else-if chain. The server's request callback calls `route` and catches any error it throws:

- log the method and the path **without the query string** (from step 12 the query can carry a token);
- if the response headers were already sent, destroy the response; otherwise answer 500 with a JSON body holding the error message.

Every route lives inside `route`, so every route passes the same checks.

**1.3 Local-only gate.** Write `isLocal(req)` in `relay/relay-lib.ts` and call it first in `route`. A request is local only if all four conditions hold:

| Condition | What it stops |
|---|---|
| The socket's remote address is `127.0.0.1`, `::1` or `::ffff:127.0.0.1` | Other machines |
| The hostname part of the `Host` header is `127.0.0.1` or `localhost` | DNS rebinding, HTTP tunnels (they send their own host name) |
| There is no `X-Forwarded-For` and no `X-Forwarded-Host` header | Reverse proxies |
| There is no `Origin` header, or it starts with `chrome-extension://` | Web pages. A browser always sends `Origin` on a cross-site request, and a page cannot forge it |

Parse the `Host` header with the URL parser rather than splitting on `:`, so IPv6 forms are handled. If any condition fails, answer 403 with a message that says the relay only answers local requests.

**1.4 Tool definitions.** In `relay/tools.ts`, export a list of tool definitions. Each has three fields: `name`, `description`, and `inputSchema`, which is a JSON Schema object (`type: "object"`, `properties`, `required`). Add one tool, `tabs_list`, with an optional boolean argument `createIfEmpty`.

**1.5 MCP endpoint.** Accept only `POST /mcp`. Any other method on that path gets 405 with a JSON-RPC error body.

For each POST, build a **new** SDK `Server` and a **new** Streamable HTTP server transport configured with no session id generator (that setting is what makes it stateless). Then:

1. Register a close listener on the response that closes both the transport and the server, so nothing leaks per request.
2. Connect the server to the transport.
3. Hand the request and response to the transport.

Write a `buildServer()` function that creates the `Server` with a name, a version, and the `tools` capability, and registers two handlers:

| Handler | Returns |
|---|---|
| list tools | The tool definitions from `relay/tools.ts` |
| call tool | For an unknown name: a result with `isError: true` and a message naming the tool. For `tabs_list`, for now: the fixed text "stub: no browser yet" |

**1.6 Test `isLocal`.** It only reads the headers and the socket's remote address, so a test can pass a plain object with those two fields. Cover: a plain local request; a forged `Host`; `X-Forwarded-For` present; a web `Origin`; a `chrome-extension://` origin; a non-loopback address.

## Interfaces

| Name | Where | Shape |
|---|---|---|
| Tool definition | `relay/tools.ts` | `{ name, description, inputSchema }`; `inputSchema` is `{ type: "object", properties, required }` |
| Tool list | `relay/tools.ts` | An exported array of tool definitions |
| `isLocal(req)` | `relay/relay-lib.ts` | Takes an incoming request, returns a boolean |

## Done when

Start the relay with `npm run relay`. The responses arrive as server-sent events: a line `event: message`, then a line `data: {...}` holding the JSON-RPC response.

- `[auto]` Initialize returns your server name:

  ```sh
  curl -s -X POST http://127.0.0.1:8787/mcp \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
  ```

- `[auto]` Listing works with no prior initialize (stateless), and shows `tabs_list`:

  ```sh
  curl -s -X POST http://127.0.0.1:8787/mcp \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  ```

- `[auto]` A call returns the stub text; an unknown tool name returns `"isError":true`:

  ```sh
  curl -s -X POST http://127.0.0.1:8787/mcp \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"tabs_list","arguments":{}}}'
  ```

- `[auto]` Adding `-H 'Host: evil.example'` to any of them returns the 403 body. So does `-H 'Origin: https://evil.example'`, and so does `-H 'X-Forwarded-For: 1.2.3.4'`.
- `[auto]` `GET /mcp` returns 405. `GET /nope` returns 404.
- `[auto]` `npm test` passes with the `isLocal` cases.
- `[browser]` Optional: `claude mcp add --transport http bridge http://127.0.0.1:8787/mcp`, and the client lists the tool.

## Pitfalls

- **Both `Accept` types are required** by the Streamable HTTP transport: `application/json` and `text/event-stream`. A request that sends only one is rejected with 406.
- **Do not add sessions.** Stateless mode is what lets the relay sit behind any tunnel and restart freely.
- **Return tool failures as `isError` content, not as thrown protocol errors.** The model can read content and react to it; a protocol error usually reaches it as a generic failure.

## Carry forward

- Every route passes the gate at the top of `route` before anything else. New routes go inside it.
- `buildServer()` is rebuilt per request. From step 9 it takes the request's public base URL as an argument.
