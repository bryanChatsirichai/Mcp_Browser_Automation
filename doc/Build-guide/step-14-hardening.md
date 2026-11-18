# Step 14: Hardening and release checklist

**Goal.** Close the gaps the reference leaves open, prove the invariants from every earlier step still hold, and document what the product does not protect against.

**Builds on.** Everything. The sub-tasks are independent; do them in the order given, which is by value.

## Sub-tasks

**14.1 Validate tool arguments at the relay.** Until now a malformed call travels to the extension and may surface as an opaque `CDP_ERROR`. Zod is already a dependency: define one schema per tool beside its definition in root `tools.ts`, and in the `tools/call` handler return an `isError` result naming the bad field before calling the extension. For `batch`, validate each item's `input` against its tool's schema.

Keep the JSON Schema served by `tools/list` and the Zod schema from drifting: generate one from the other, or add a test that both accept and reject the same sample inputs.

**14.2 Complete the unit tests.** By now `test/` should cover every pure function. Confirm each row has cases for both the accept and the refuse side:

| Module | Functions |
|---|---|
| `relay-lib.ts` | `isLocal`, `tokenOk`, `fence`, `safeName`, `isUploadable`, `absolutize` |
| `policy.ts` | `checkUrl`, `cleanSites`, `badSites` |
| `frame.ts` | `frameOf`, `toCss` |
| `keys.ts` | `modifierBits`, `keyInfo`, `splitChord` |
| `query.ts` | `parseQuery`, `score`, ranking |
| tabs helpers | `withScheme` (move it to a chrome-free module) |

**14.3 An end-to-end smoke test for the relay.** A test that starts `relay.ts` as a child process on a free port, connects a fake extension with the `ws` client (send `hello`, answer every `call` with a canned `result`), and asserts through HTTP:

- `tools/list` returns every tool;
- a call's result is fenced and the nonce matches in both tags;
- a hostile canned result containing the fence tag comes back defanged;
- closing the fake extension mid-call returns the disconnect error immediately;
- a second fake extension makes the first close with code 4409;
- an `upload_file` call with a path outside the roots never reaches the fake extension.

This covers the whole relay with no browser, and an agent can run it.

**14.4 Clean up stored files.** At startup and then hourly, delete directories under `./files` older than a configurable age (for example `FILES_MAX_AGE_HOURS`, default 24). Only ever delete directories whose name matches `^[a-f0-9]{16}$`.

**14.5 One source for the version.** Read the version from `package.json` in `relay.ts`, and have the build copy it into `manifest.json`, instead of writing it in three places.

**14.6 Decide the open policy questions.** Each is a product decision; record the choice in the README.

| Question | Reference behaviour | Stricter option |
|---|---|---|
| Private and intranet addresses | Allowed | Refuse RFC 1918 ranges and `localhost` unless on the allowed list |
| Iframes | Not policy-checked | Skip frames whose URL fails `checkUrl` in `collect` |
| JavaScript dialogs | Always accepted | A setting to dismiss, or to accept only `alert` |
| Confirmation | Never asks | A per-site "ask first" mode, or a read-only mode without `click`, `type_text`, `set_field`, `run_js`, `upload_file` |
| Parallelism | One global queue | A queue per tab |

**14.7 Write the README.** At minimum: the diagram, quick start, tool table, environment variables, the guardrails, and a "Not covered" list. The reference's list is a good model: injection is reduced, not solved; screenshots are not fenced; nothing asks before acting; redirects load before they are stopped.

## Release checklist

Run the whole list on a clean checkout. Every line maps to an invariant from an earlier step.

**Automated**

- [ ] `npm run check`, `npm run build`, `npm test` pass on the minimum supported Node version.
- [ ] The relay smoke test (14.3) passes.
- [ ] `grep -rn "chrome.debugger" extension/src` finds matches only in `cdp.ts`.
- [ ] `grep -rn "0.0.0.0" relay.ts` finds nothing.
- [ ] Every `ToolName` has a handler, a definition and a validation schema (the type-check and a test enforce this).

**Access (steps 1, 12)**

- [ ] No token: forged `Host`, `X-Forwarded-For` and web `Origin` are each refused with 403.
- [ ] Token: missing and wrong tokens get 401 on `/mcp`, `/upload` and `/files`; `?token=` works only on `/files`.
- [ ] The extension with a wrong token is closed with 4401 and does not retry.

**Connection (steps 2, 3)**

- [ ] Relay restart, service worker termination and browser restart each recover without a click.
- [ ] A call in flight when the socket drops fails immediately.
- [ ] A call that waits behind slow calls fails with `BUSY` before the relay's own timeout.
- [ ] Reconnect after "replaced" actually reconnects.

**Guardrails (steps 3, 4, 8, 9)**

- [ ] Every text result is fenced; a result containing the fence tag and invisible characters comes back defanged and stripped.
- [ ] A tab outside the group is refused for every page tool, alone and inside a batch.
- [ ] A tab that redirected to a blocked site is refused on the next call.
- [ ] Link-local and metadata addresses are refused in decimal, hex and IPv4-mapped forms.
- [ ] Uploads: outside the roots, dot-files, dot-folders and symlinks to either are refused, alone and inside a batch.
- [ ] Downloads from before the connection are neither listed nor served.
- [ ] A bad entry in the allowed or blocked list disables Connect and is named.

**Behaviour (steps 5 to 13)**

- [ ] A click at screenshot coordinates lands on the right element on a normal and a HiDPI display, and in a viewport wider than 1568 pixels.
- [ ] Everything works on a background tab, without the browser taking focus.
- [ ] `STALE_REF` after navigation, with the recovery hint.
- [ ] Refs, clicks and `set_field` work in same-site, cross-site and nested iframes.
- [ ] `alert()` does not hang a call.
- [ ] The overlay never appears in a screenshot and never causes a tool call to fail.
- [ ] Disconnect removes the debugging bar and the overlay from every tab.

**Output bounds**

- [ ] `read_page`, `page_text`, `run_js`, `inspect` and `find` on a very large page each return a bounded result with a truncation note.

## Done when

- `[auto]` Every item under "Automated" passes.
- `[browser]` Every other item was checked by hand or by a browser-capable agent, with the result written down. An unchecked item is listed as such, not assumed.
- The README states the decisions from 14.6 and the limits that remain.

## Pitfalls

- **Treating the checklist as paperwork.** Each line was a real failure mode somewhere above; run them.
- **Fixing a failing check by loosening the check.** Fix the code or record the limit.
- **Shipping without the "Not covered" list.** For a tool that drives a logged-in browser, the limits are part of the interface.
