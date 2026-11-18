# Step 12: Remote access: token, tunnels, auto-launch

**Goal.** A client on another machine can use the relay through a tunnel, authenticated by a token. The popup hands the user ready-to-paste commands. Optionally the relay starts the browser when a call arrives and none is connected.

**Builds on.** Step 3 (the gate, the handshake). Uses step 9's file routes if present.

## Files

```text
relay.ts                    TOKEN, bearer(), two-mode gate, hello token check, wakeBrowser
relay-lib.ts                + tokenOk
stamp.ts                    writes extension/dist/install.json       (new)
package.json                build: "tsc -p extension && node stamp.ts"
extension/src/popup.ts      token field, relay command, client snippet, copy buttons
extension/src/upload.ts     send the Bearer header when a token is set
test/token.test.ts                                                   (new)
```

## Sub-tasks

**12.1 Two modes.** `const TOKEN = process.env.RELAY_TOKEN ?? ''`.

```text
 TOKEN empty  -> local-only mode: every request and the /ext upgrade must pass isLocal()   (as since step 1)
 TOKEN set    -> token mode: isLocal() is not required; the token is required instead
```

Log which mode is active at startup.

**12.2 `tokenOk(candidate, token)`.** Hash both with SHA-256 and compare the digests with `crypto.timingSafeEqual`. Hashing gives equal-length buffers (which `timingSafeEqual` requires) and hides the token's length. Return false for a non-string.

**12.3 The order of checks in `route()`.**

```text
 1. no TOKEN and not local ...................... 403
 2. OPTIONS /upload ............................. 204 + CORS   (a preflight cannot carry credentials)
 3. token = Authorization: Bearer <...>
            or ?token=<...>  ONLY when the path starts with /files
 4. TOKEN set and not tokenOk(token) ............ 401 + "WWW-Authenticate: Bearer"
 5. dispatch
```

The query-string form exists so a file link can be opened in a browser. Keep it off every other route.

**12.4 The extension authenticates in `hello`.** In `acceptExtension`: `if (TOKEN && !tokenOk(message.token)) close(4401)`. In token mode the `/ext` upgrade is accepted from anywhere and the `hello` check is the only gate, so the 5s hello timer matters.

**12.5 Extension uploads.** `uploadFile` adds `authorization: Bearer <token>` when the saved token is not empty.

**12.6 `stamp.ts` and the popup's commands.** An extension cannot find its own folder on disk. After `tsc`, write `{ "relay": "<absolute path of relay.ts>" }` to `extension/dist/install.json`; the popup fetches it.

- Before connecting, show the command to start the relay: `RELAY_TOKEN=<token> PORT=<port> node <path>` (omit the parts that are default).
- After connecting, show the command to add the server to a client, with the `Authorization: Bearer` header when a token is set.
- `quote(value)`: leave `^[\w@%+=:,./-]+$` alone, otherwise wrap in single quotes and escape embedded ones as `'\''`.
- A Copy button per command.

**12.7 Auto-launch (optional).** `BROWSER_LAUNCH` holds a shell command. In `callExtension`, when no extension is connected and it is set:

```ts
waking ??= new Promise<boolean>((resolve) => {
  const child = spawn(BROWSER_LAUNCH, { shell: true, detached: true, stdio: 'ignore' });
  child.on('error', (error) => log(`browser launch failed: ${error.message}`));
  child.unref();
  const timer = setTimeout(() => resolve(false), 20_000);
  onConnected.push(() => { clearTimeout(timer); resolve(true); });
}).finally(() => { waking = null; onConnected = []; });
```

Calls that arrive during the wait share the one attempt. `acceptExtension` runs every `onConnected` callback after sending `ready`. If the wait fails, say so specifically: the browser was started but its extension did not connect.

**12.8 Tests.** `tokenOk`: equal, different same length, different length, `null`. `quote` (export it from a chrome-free module): safe string, string with spaces, string with a single quote.

Reference: `relay.ts:30-89`, `relay.ts:135-175`, `relay.ts:237-244`, `relay.ts:608-628`, `stamp.ts`, `popup.ts:43-90`, `upload.ts`.

## Done when

- `[auto]` `npm run check`, `npm test` pass.
- `[auto]` With `RELAY_TOKEN=secret`: a request with no header returns 401; with `Authorization: Bearer secret` it works; with `Bearer wrong` it returns 401.
- `[auto]` `GET /files/<id>/<name>?token=secret` works; `POST /mcp?token=secret` with no header returns 401.
- `[auto]` With no token, the forged-`Host` request from step 1 still returns 403.
- `[browser]` With the token in the popup the extension connects; with a wrong token the popup shows "Wrong token" and does not retry until the settings change.
- `[browser]` Through a tunnel (`cloudflared tunnel --url http://127.0.0.1:8787` or similar), an MCP client configured with the tunnel URL and the Bearer header can call tools, and file URLs in results use the tunnel's host.
- `[browser]` With `BROWSER_LAUNCH='open -g -a "Google Chrome"'` and the browser closed, a call starts the browser and succeeds; a second call sent during the wait does not start a second browser.

## Pitfalls

- **Never forward the port without a token.** A raw TCP forward can forge `Host` and omit `Origin`; local-only mode cannot detect it.
- **Comparing tokens with `===`** leaks timing. Use the constant-time comparison.
- **A token in a URL lands in browser history and proxy logs.** Limit it to `/files`, keep it out of your own logs (step 1 already drops the query string), and send `referrer-policy: no-referrer` on file responses.
- **Whoever holds the token controls the user's browser sessions.** Say this plainly in your README.

## Carry forward

- There are exactly two ways into the relay: local-only, or the token. New routes inherit the gate by being inside `route()`.
