# Step 12: Remote access: token, tunnels, auto-launch

**Goal.** A client on another machine can use the relay through a tunnel, authenticated by a token. The popup hands the user ready-to-paste commands. Optionally, the relay starts the browser when a call arrives and none is connected.

**Builds on.** Step 3 (the gate, the handshake). Uses step 9's file routes if present.

## Files

```text
relay/relay.ts              the token, Bearer parsing, two-mode gate, hello token check, browser launch
relay/relay-lib.ts          + token comparison
stamp.ts                    writes extension/dist/install.json       (new)
package.json                the build script runs stamp.ts after the compiler
extension/src/popup.ts      token field, relay command, client snippet, copy buttons
extension/src/upload.ts     send the Bearer header when a token is set
test/token.test.ts                                                   (new)
```

## Sub-tasks

**12.1 Two modes.** Read the token from the `RELAY_TOKEN` environment variable; empty means none.

```text
 no token  -> local-only mode: every request and the /ext upgrade must pass isLocal   (as since step 1)
 token set -> token mode: isLocal is not required; the token is required instead
```

Log which mode is active at startup.

**12.2 Comparing tokens.** Hash both the candidate and the real token with SHA-256, and compare the two digests with Node's constant-time comparison (`crypto.timingSafeEqual`). Hashing gives two buffers of equal length, which the comparison requires, and it hides the token's length. Return false for anything that is not a string.

**12.3 The order of checks in `route`.**

```text
 1. no token configured and the request is not local ...... 403
 2. OPTIONS /upload ....................................... 204 + CORS   (a preflight cannot carry credentials)
 3. candidate = the Authorization: Bearer <...> header,
                or the ?token=<...> query parameter ONLY when the path starts with /files
 4. token configured and the candidate does not match ..... 401 with "WWW-Authenticate: Bearer"
 5. dispatch to the route
```

The query-string form exists so that a file link can be opened directly in a browser. Keep it off every other route.

**12.4 The extension authenticates in `hello`.** When a token is configured, close the socket with 4401 unless the `hello` message carries a matching token. In token mode the `/ext` upgrade is accepted from anywhere, so this check is the only gate on the WebSocket. That is why the 5-second hello timeout from step 2 matters.

**12.5 Extension uploads.** "Upload a file" (step 9) adds an `authorization: Bearer <token>` header when the saved token is not empty.

**12.6 `stamp.ts` and the popup's commands.** An extension cannot find its own folder on disk, so it cannot tell the user where `relay/relay.ts` is. Fix that at build time: after the compiler runs, `stamp.ts` writes `extension/dist/install.json` holding the absolute path of `relay/relay.ts`. The popup fetches that file from inside the extension.

- Before connecting, the popup shows the command to start the relay: the `RELAY_TOKEN` and `PORT` variables, then `node` and the path. Leave out any part that has its default value.
- After connecting, it shows the command to add the server to an MCP client, with the `Authorization: Bearer` header when a token is set.
- **Shell quoting:** leave a value alone if it contains only letters, digits and `@%+=:,./-_`. Otherwise wrap it in single quotes, and write each single quote inside it as `'\''` (close the quote, an escaped quote, open again).
- Add a Copy button for each command.

**12.7 Auto-launch (optional).** `BROWSER_LAUNCH` holds a shell command that starts the browser, such as `open -g -a "Google Chrome"` on macOS. When a call arrives, no extension is connected, and the variable is set:

1. If a launch attempt is already in progress, wait on that one. Calls that arrive during the wait share one attempt, so the browser is not started twice.
2. Otherwise, start the command through the shell, detached from the relay and with no output, and log an error if it fails to start.
3. Wait up to 20 seconds for an extension to connect. The accept routine (step 2) notifies all waiters after it sends `ready`.
4. Clear the in-progress attempt when it ends, either way.

If the wait fails, say specifically that the browser was started but its extension did not connect within 20 seconds, and that the user should check the extension is installed in that browser profile and was left connected.

**12.8 Tests.** Token comparison: equal; different with the same length; different length; not a string. Shell quoting (keep it in a chrome-free module): a safe string; a string with spaces; a string with a single quote.

## Done when

- `[auto]` `npm run check`, `npm test` pass.
- `[auto]` With `RELAY_TOKEN=secret`: a request with no header returns 401; with `Authorization: Bearer secret` it works; with `Bearer wrong` it returns 401.
- `[auto]` `GET /files/<id>/<name>?token=secret` works; `POST /mcp?token=secret` with no header returns 401.
- `[auto]` With no token, the forged-`Host` request from step 1 still returns 403.
- `[browser]` With the token in the popup, the extension connects. With a wrong token, the popup shows "Wrong token" and does not retry until the settings change.
- `[browser]` Through a tunnel (for example `cloudflared tunnel --url http://127.0.0.1:8787`), an MCP client configured with the tunnel URL and the Bearer header can call tools, and file URLs in results use the tunnel's host.
- `[browser]` With `BROWSER_LAUNCH` set and the browser closed, a call starts the browser and succeeds; a second call sent during the wait does not start a second browser.

## Pitfalls

- **Never forward the port without a token.** A raw TCP forward (`ssh -R`, a TCP tunnel) can forge `Host` and omit `Origin`, so local-only mode cannot detect it.
- **Comparing tokens with plain string equality** leaks timing. Use the constant-time comparison.
- **A token in a URL lands in browser history and proxy logs.** Limit it to `/files`, keep it out of your own logs (step 1 already drops the query string), and send `referrer-policy: no-referrer` on file responses.
- **Whoever holds the token controls the user's browser sessions.** Say this plainly in your README.

## Carry forward

- There are exactly two ways into the relay: local-only, or the token. New routes inherit the gate by living inside `route`.
