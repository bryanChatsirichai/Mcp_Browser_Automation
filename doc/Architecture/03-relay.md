# 3. The relay (`relay.ts`)

One file, 672 lines, five sections marked by comment banners: auth, extension link, tools, guardrails, http. It uses Node's built-in `http` module with no web framework.

## Map of the file

```text
 HTTP request
      |
      v
   route()  ------ no token and not local -> 403        token set and wrong -> 401
      |
      +-- POST /mcp ----------> handleMcp --> buildServer(base)
      |                                          |-- tools/list --> LISTED  (schemas.ts + warning note)
      |                                          '-- tools/call --> logCall
      |                                                             checkUploads
      |                                                             callExtension ----+
      |                                                             toResult (fence)  |
      |                                                                               |
      +-- PUT /upload/<name> --> handleUpload --> ./files/<id>/<name>                 |
      |                                                                               |
      +-- GET /files/<id>/<name> --> handleFile --> sendFile <-- ./files              |
      +-- GET /files/dl/<n> ------> handleFile --> callExtension(files, path) --------+
      |                                                                               |
      '-- anything else -> 404                                                        v
                                                                         pending Map<id, {resolve,
 WebSocket upgrade /ext --> acceptExtension --> `extension` socket <---> reject, timer}>
                            (hello, ready, ping, result)
```

## Routes

| Method and path | Handler | Purpose | Who calls it |
|---|---|---|---|
| `POST /mcp` | `handleMcp` | MCP over Streamable HTTP | The MCP client |
| `GET /ext` (upgrade) | `acceptExtension` | The extension's WebSocket | The extension |
| `PUT /upload/<name>` | `handleUpload` | Store a file under `./files/<id>/<name>` | The extension (screenshots, PDFs, videos) |
| `OPTIONS /upload/...` | inline | CORS preflight | The extension |
| `GET /files/<id>/<name>` | `handleFile` | Serve a stored file | The client or the user |
| `GET /files/dl/<downloadId>` | `handleFile` | Serve a browser download from where the browser saved it | The client or the user |

Routing is a hand-written `if / else if` over the first path segment (`relay.ts:608-639`). A single top-level `.catch` turns thrown errors into JSON: `NOT_FOUND` becomes 404, other extension errors 502, anything else 500 (`relay.ts:641-655`). The log line drops the query string, so a `?token=` never reaches the log.

## Auth: two modes

```text
RELAY_TOKEN empty  ->  "local only" mode: isLocal(req) must be true
RELAY_TOKEN set    ->  token mode: Bearer token must match (any origin, any address)
```

The order of checks in `route()`:

```text
 request
    |
    v
 RELAY_TOKEN set? ---- no ----> isLocal(req)? ---- no ----> 403
    |                               |
    | yes                           | yes
    |                               v
    |                          allowed, no token asked
    v
 OPTIONS /upload? ---- yes ---> 204 with CORS headers (a preflight carries no credentials)
    |
    | no
    v
 token = "Authorization: Bearer ..."
         or ?token=...   (only when the path starts with /files)
    |
    v
 tokenOk(token)? ---- no ----> 401 + "WWW-Authenticate: Bearer"
    |
    | yes
    v
 allowed
```

### Local-only mode (`isLocal`, `relay.ts:76-83`)

All four must hold:

| Check | What it stops |
|---|---|
| Remote address is loopback | Other machines |
| `Host` header is `127.0.0.1` or `localhost` | DNS rebinding (a page on `evil.com` resolving to 127.0.0.1 still sends `Host: evil.com`) and HTTP tunnels |
| No `x-forwarded-for` / `x-forwarded-host` | Reverse proxies and tunnels |
| No `Origin`, or an `Origin` starting with `chrome-extension://` | Web pages, which cannot forge `Origin` |

The source comment is honest about the limit: a raw TCP forward can forge both headers and is not detected (`relay.ts:72-75`). Any local program, and any installed extension, can still call the relay in this mode.

### Token mode

- `tokenOk` hashes both values with SHA-256 and compares with `timingSafeEqual` (`relay.ts:56-62`). Hashing first gives equal-length buffers, which `timingSafeEqual` requires, and avoids leaking the token length.
- The token is read from `Authorization: Bearer ...`. A `?token=` query parameter is accepted **only for `/files`**, so a file link can be opened directly in a browser (`relay.ts:622-623`).
- The extension sends its token inside the `hello` message, not as a header, because the browser `WebSocket` API cannot set headers.

## The MCP server

```ts
// relay.ts:514-524, abbreviated
const server = buildServer(publicBase(req));
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
res.on('close', () => { transport.close(); server.close(); });
await server.connect(transport);
await transport.handleRequest(req, res);
```

`sessionIdGenerator: undefined` puts the SDK transport in stateless mode. Only `POST` is accepted, so there is no server-to-client stream and no notifications.

`buildServer` registers two handlers (`relay.ts:430-463`):

- **`tools/list`** returns `LISTED`: the schemas from `schemas.ts`, with a warning sentence appended to the description of every tool that returns page content (`relay.ts:318-321`).
- **`tools/call`** runs `logCall` -> `checkUploads` -> `callExtension` -> `toResult`, and converts any error into `{isError: true}` content rather than a protocol error, so the model can read and react to it.

The server also sends `instructions` at initialize time: a paragraph telling the model that everything returned is untrusted page data (`relay.ts:309-316`). See [07-security.md](07-security.md).

### Why `base` is passed in

The extension only knows relay-relative paths like `/files/ab12.../shot.jpg`. The client needs absolute URLs, and the right host depends on how the client reached the relay (localhost or a tunnel). `publicBase(req)` derives it from `x-forwarded-proto` / `x-forwarded-host` or `Host` (`relay.ts:495-500`), and results are rewritten on the way out:

- JSON results: `absolutize()` walks the object and prefixes any `url` key whose value starts with `/files/` (`relay.ts:287-303`).
- Content results: a regex prefixes `/files/...` occurrences in text (`relay.ts:350`).

Building a server per request makes this simple: the base URL is just a constructor argument.

### How a result is shaped (`toResult`)

```text
 data from the extension
     |
     +-- has content[] ? -- yes --> walk the parts in order:
     |                                text  -> collect it (rewrite /files/... to absolute)
     |                                image -> first flush the collected text as ONE fenced block,
     |                                         then pass the image through unchanged
     |                              at the end -> flush what is left
     |
     '-- no (plain JSON) ---------> absolutize `url` fields -> JSON.stringify -> one fenced block

 Example, a batch of "click, screenshot, click":

   [ text  <untrusted-browser-content id="N"> [computer:left_click] Clicked at (400, 300)
                                               [computer:screenshot] Successfully captured ... </...>
     image (the screenshot, not fenced)
     text  <untrusted-browser-content id="N"> [computer:left_click] Clicked at (10, 20)
                                               Tab Context: ...                         </...> ]

 Every block of one result carries the same nonce N.
```

## The extension link

Covered in detail in [02-request-lifecycle.md](02-request-lifecycle.md). The core is a classic request/response correlation over a message stream:

```ts
const pending = new Map<string, { resolve, reject, timer }>();   // relay.ts:129

callExtension():  id = randomUUID(); pending.set(id, ...); socket.send({type:'call', id, ...})
settle(id, ...):  entry = pending.get(id); pending.delete(id); clearTimeout; resolve or reject
failAllPending(): on socket close, reject everything
```

`WebSocketServer({ noServer: true })` plus a manual `upgrade` handler lets HTTP and WebSocket share one port and lets the relay reject the upgrade before a socket exists (`relay.ts:657-666`).

## File storage

### Upload (`handleUpload`, `relay.ts:527-558`)

1. Reject early if `Content-Length` exceeds the cap.
2. Generate a 16-hex-character random id; the file goes to `./files/<id>/<safeName>`.
3. Stream the body to disk through a `Transform` that counts bytes and errors past the cap, because `Content-Length` can be absent or wrong.
4. On failure, remove the directory.
5. Reply `{url: "/files/<id>/<name>", name, size}`.

`safeName` (`relay.ts:502-506`) takes the basename, replaces anything outside `[\w.\- ]` with `_`, and strips leading dots. Together with the random directory, a stored file can never escape `./files` or collide.

Because the id is random, stored file URLs cannot be enumerated. That is not access control by itself: in local-only mode any local program can already call the tools.

### Serve (`sendFile`, `relay.ts:560-582`)

Headers worth noting:

| Header | Reason |
|---|---|
| `x-content-type-options: nosniff` | The browser must not guess a type |
| `referrer-policy: no-referrer` | The link may carry `?token=` |
| `content-security-policy: sandbox` (HTML only) | A stored page must not run scripts on the relay's origin |
| `content-disposition: inline` | Opens in the browser instead of downloading |

Unknown extensions are served as `application/octet-stream`.

### Browser downloads (`/files/dl/<id>`)

The relay does not copy downloads. It asks the extension for the path with the internal call `files {action: "path", id}` and streams the file from the browser's download folder (`relay.ts:587-596`). This is the second reason the relay must run on the browser machine.

Stored files are never deleted by the relay. `./files` grows until you clean it.

### Four ways data gets back to the client

```text
 1. Text and JSON results        extension --WebSocket--> relay --HTTP response--> client

 2. A screenshot the model       extension --WebSocket (base64 image part)--> relay --> client
    must look at

 3. Large or binary output       extension --HTTP PUT /upload--> relay --> ./files/<id>/<name>
    (video, PDF, saved           extension --WebSocket--> relay --> client     only {url, name, size}
    screenshot, frames)          client --GET /files/<id>/<name>--> relay      fetched later, if wanted

 4. A browser download           stays in the browser's download folder
                                 client --GET /files/dl/<n>--> relay --asks extension for the path-->
                                 relay streams the file from disk
```

## `schemas.ts`

A plain array of `{name, description, inputSchema}`. No code. Things to notice:

- Descriptions carry behavioural instructions for the model, not just documentation: "CRITICAL: You must get the context at least once...", "close each one with tabs_close_mcp as soon as you no longer need it".
- `action_summary` is a parameter the tool does not need in order to work. It exists so the model states the effect of each click or keystroke, which the relay logs as an audit trail (`relay.ts:420-428`).
- The three tools the repo calls its own (`inspect`, `record`, `files`) put a full example call in the description.
- One description does not match the code: `record` says "The tab is brought to the front", but nothing in `record.ts` activates the tab or focuses its window. The recording relies on focus emulation instead (`cdp.ts:94-96`).
