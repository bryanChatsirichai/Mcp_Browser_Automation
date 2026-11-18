# Step 1: The relay speaks MCP

**Goal.** An MCP client can connect to `http://127.0.0.1:8787/mcp`, list one tool, and call it. Nothing outside this machine can.

**Builds on.** Step 0.

## Files

```text
relay.ts        HTTP server, routing, MCP endpoint
relay-lib.ts    isLocal()                                  (new)
tools.ts        TOOLS: one definition, tabs_list           (new)
test/relay-lib.test.ts                                     (new)
```

## Sub-tasks

**1.1 HTTP server.** `http.createServer`, listening on host `127.0.0.1` (never `0.0.0.0`) and `PORT` (default 8787). Add a `log(message)` helper that prefixes an ISO timestamp.

**1.2 Router.** One async `route(req, res)` that splits the path and dispatches with `if / else if`. Wrap it once:

```ts
const httpServer = http.createServer((req, res) => {
  route(req, res).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log(`request failed: ${req.method} ${req.url?.split('?')[0]} - ${message}`);   // no query string in logs
    if (res.headersSent) res.destroy();
    else json(res, 500, { error: message });
  });
});
```

**1.3 Local-only gate.** Put `isLocal(req)` in `relay-lib.ts` and call it first in `route()`. A request is local only if all four hold:

| Check | Stops |
|---|---|
| `req.socket.remoteAddress` is `127.0.0.1`, `::1` or `::ffff:127.0.0.1` | Other machines |
| The `Host` header's hostname is `127.0.0.1` or `localhost` | DNS rebinding, HTTP tunnels |
| No `x-forwarded-for` and no `x-forwarded-host` header | Reverse proxies |
| No `Origin` header, or one starting with `chrome-extension://` | Web pages |

Otherwise answer 403 with a message that says why.

**1.4 Tool definitions.** `tools.ts` exports `TOOLS: ToolSchema[]` where `ToolSchema = { name, description, inputSchema }` and `inputSchema` is JSON Schema. Add `tabs_list` with an optional boolean `createIfEmpty`.

**1.5 MCP endpoint.** `POST /mcp` only; anything else gets 405. Build a fresh server and transport per request:

```ts
async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });   // stateless

  res.on('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}
```

`buildServer()` creates `new Server({ name, version }, { capabilities: { tools: {} } })` and registers two handlers: `ListToolsRequestSchema` returns `{ tools: TOOLS }`; `CallToolRequestSchema` returns an `isError` result for an unknown name and, for now, the fixed text `"stub: no browser yet"`.

**1.6 Test `isLocal`.** It takes a request object, so a test can pass a plain object with `headers` and `socket.remoteAddress`. Cover: plain local request; forged `Host`; `x-forwarded-for` present; web `Origin`; `chrome-extension://` origin; non-loopback address.

Reference: `relay.ts:64-83` (gate), `relay.ts:430-463` (server), `relay.ts:508-525` (endpoint), `relay.ts:608-655` (router), `schemas.ts`.

## Contracts

```ts
// tools.ts
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}
export const TOOLS: ToolSchema[];

// relay-lib.ts
export function isLocal(req: IncomingMessage): boolean;
```

## Done when

Start the relay with `npm run relay`. The first three requests were run against the reference and behave as shown; responses arrive as server-sent events (`event: message` then `data: {...}`).

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

- `[auto]` Adding `-H 'Host: evil.example'` to any of them returns the 403 body. So does `-H 'Origin: https://evil.example'`.
- `[auto]` `GET /mcp` returns 405. `GET /nope` returns 404.
- `[auto]` `npm test` passes with the `isLocal` cases.
- `[browser]` Optional: `claude mcp add --transport http bridge http://127.0.0.1:8787/mcp` and the client lists the tool.

## Pitfalls

- **Both `Accept` types are required** by the transport. A client that sends only `application/json` is rejected.
- **Do not add sessions.** Stateless mode is what lets the relay sit behind any tunnel and restart freely. The browser holds the state.
- **Return tool failures as `isError` content, not as thrown protocol errors.** The model can read and react to content.

## Carry forward

- Every route passes the gate in `route()` before anything else. New routes go inside it.
- `buildServer()` is rebuilt per request; from step 9 it takes the request's base URL as an argument.
