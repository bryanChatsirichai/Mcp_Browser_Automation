# Step 9: Files: storage, PDF, downloads, uploads

**Goal.** Binary output (saved screenshots, PDFs) reaches the client as a URL; the agent can download with the browser's session; and the agent can attach local files to a page without being able to read anything it should not.

**Builds on.** Step 8.

## Why a side channel

Large binaries sent over the WebSocket would block every other message, and they would bloat the model's context if returned inline. So the extension uploads files to the relay over plain HTTP, the relay stores them on disk, and the tool result carries only a URL.

```text
 extension --PUT /upload/<name>--> relay --> ./files/<id>/<name>
 client    --GET /files/<id>/<name>------------------^
```

## Files

```text
relay/relay.ts              + PUT /upload, GET /files, public base URL, upload path checks
relay/relay-lib.ts          + safe name, is uploadable, absolutize
extension/src/upload.ts     upload a file, base64 to blob             (new)
extension/src/files.ts      download, list, PDF, path                 (new)
extension/src/input.ts      + set files on a file input
extension/src/tools.ts      + files, upload_file handlers; guard checks download URLs
extension/src/background.ts + mark the session start on ready, clear it on disconnect
extension/manifest.json     + "downloads"
relay/tools.ts              + files, upload_file; save option on screenshot
test/paths.test.ts                                                    (new)
```

## Sub-tasks

### A. The relay stores and serves files

**9.1 `PUT /upload/<name>`.**

1. If the `Content-Length` header exceeds the cap, answer 413 at once. The cap comes from `MAX_UPLOAD_MB`, default 500.
2. Make a directory `./files/<id>/`, where the id is 16 random hex characters.
3. Stream the request body into the file through a transform stream that counts bytes and fails once the count passes the cap. `Content-Length` can be missing or false, so the count is the real limit.
4. On any failure, remove the directory.
5. Answer `{ url: "/files/<id>/<name>", name, size }`.

Also answer `OPTIONS /upload/...` with 204 and CORS headers (allow any origin, methods `PUT` and `OPTIONS`, headers `authorization` and `content-type`). The extension's `fetch` sends this preflight first.

**9.2 Safe file names.** URL-decode the raw name, keep only its last path segment, replace every character other than letters, digits, underscore, dot, hyphen and space with `_`, strip leading dots, and fall back to `file` if nothing is left. Example: `..%2F..%2Fx.md` becomes `x.md`.

**9.3 `GET /files/<id>/<name>`.** Require the id to be exactly 16 lower-case hex characters, else 404. Sanitise the name the same way. Stream the file, or 404 if it does not exist. Send these headers:

| Header | Why |
|---|---|
| `content-type` from a small table of extensions (webm, png, jpg, pdf, json, txt, html), else `application/octet-stream` | No guessing |
| `x-content-type-options: nosniff` | The browser must not guess either |
| `content-security-policy: sandbox`, for HTML only | A stored page must not run script on the relay's origin |
| `referrer-policy: no-referrer` | The link may carry a token (step 12) |

**9.4 Absolute URLs.** The extension only knows paths like `/files/...`; the client needs a full URL it can open. Compute the request's **public base**: protocol and host from `X-Forwarded-Proto` and `X-Forwarded-Host` if a proxy set them, else `http` and the `Host` header. Pass it to the server builder and on to the result shaping (step 3):

- in plain-data results, prefix every field named `url` whose value starts with `/files/`;
- in text parts, prefix every `/files/...` path that starts a word or follows a quote.

### B. The extension produces files

**9.5 `upload.ts`.** "Upload a file" sends a `PUT` to the relay's `/upload/` plus the URL-encoded name, with the blob as the body, and returns the relay's JSON answer. Add a helper that turns base64 data and a MIME type into a blob.

**9.6 Saved screenshots and PDFs.**

- `screenshot` with `save: true` also uploads the image and appends "Saved to:" and the URL.
- `files` with action `pdf` and a `tabId` prints the tab with `Page.printToPDF` (background graphics on) and uploads it as the sanitised page title plus `.pdf`.

**9.7 Downloads.** `files` with action `download` and a `url`:

1. Check the URL in the guard (step 4) before anything starts.
2. Start it with `chrome.downloads.download`: no "save as" dialog, and rename on conflict.
3. Wait for its state to become `complete` or `interrupted`, through `chrome.downloads.onChanged`, for at most 80 seconds.
4. Check the download's **final** URL again. If a redirect left the allowed sites: cancel it, delete the file, erase the download record, and refuse.
5. Return `{ id, name, size, mime, state, url: "/files/dl/<id>" }`.

**9.8 The session watermark.** When the relay sends `ready`, store the current time in session storage as "downloads since", unless it is already set. Remove it on an explicit disconnect. Looking up a download by id fails with `NOT_FOUND` for anything that started earlier, and `downloads_list` passes the time to Chrome as "started after". The agent never sees the user's earlier downloads.

**9.9 Serving downloads without copying.** Add an internal action, `files` with action `path` and an id, that returns `{ path, name }` for a download. The relay's `GET /files/dl/<n>` calls it through the WebSocket and streams the file straight from the browser's download folder. Do not list `path` in the tool's schema, and let it skip the queue like `tabs_list`.

### C. Uploading local files into a page, safely

**9.10 Setting a file input.** `upload_file` takes `tabId`, `ref` and `paths`. Find the file input: the ref's element, a label's control, or the first `input[type=file]` inside it. Set the files with `DOM.setFileInputFiles` and the input's object id. Read back the chosen names and sizes, and warn when a size is 0: the browser accepts a path that does not exist and gives the page an empty file.

**9.11 The path check lives on the relay**, because only code on the machine's file system can resolve symlinks. A real (fully resolved) path is uploadable if, for at least one root:

```text
 roots: ~/Downloads, ~/Desktop, ~/Documents and ./files by default;
        UPLOAD_ROOTS (a path list, separated like PATH) replaces the first three

 base   = the real path of the root                 skip roots that do not exist
 inside = the path of the file relative to base
 below  = inside is not empty, does not start with "..", and is not absolute
 accept if below AND no segment of inside starts with "."
```

The last rule keeps `.env`, `.git` and `.ssh` out of reach even under an allowed root.

**9.12 Checking every upload before it reaches the browser.** In the `tools/call` handler, before calling the extension, look at each step: the call itself, or each item if it is a batch (normalise names as in step 8). For every `upload_file` step:

1. Resolve each path to its real path. A path that does not exist: refuse with `BLOCKED`.
2. Check it with the rule from 9.11. Not uploadable: refuse with `BLOCKED`, naming the roots and saying the user can change them with `UPLOAD_ROOTS`.
3. **Replace** the path in the arguments with the resolved real path. The browser then reads the file that was checked, not a link that could be repointed between check and use.

**9.13 Tests** in `test/paths.test.ts`, using a temporary directory: a file under a root passes; the root itself does not; `..` escapes fail; a dot-file and a file inside a dot-folder fail; a symlink inside the root that points outside fails once resolved. Safe names: directories, odd characters and leading dots are stripped.

## Interfaces

| Name | Where | Takes → returns |
|---|---|---|
| safe name | `relay/relay-lib.ts` | raw name → file name |
| is uploadable | `relay/relay-lib.ts` | real path, roots → boolean (async) |
| absolutize | `relay/relay-lib.ts` | value, base → the value with `/files/` URLs made absolute |
| Relay file | `upload.ts` | `{ url, name, size }` |
| upload a file | `upload.ts` | relay settings (URL and token), name, blob → relay file |

## Done when

- `[auto]` `npm run check`, `npm test` pass (path tests included).
- `[auto]` This stores the file as `x.md` inside `./files/<id>/` and returns its URL; fetching that URL with `curl` returns the content:

  ```sh
  curl -X PUT --data-binary @README.md http://127.0.0.1:8787/upload/..%2F..%2Fx.md
  ```

- `[auto]` `GET /files/nothex/x` and `GET /files/<valid id>/missing` return 404.
- `[auto]` Uploading an `.html` file and fetching it shows the `content-security-policy: sandbox` header.
- `[browser]` `files pdf` returns an absolute URL that opens the PDF.
- `[browser]` `files download` of a file behind a login you hold in the browser succeeds; `downloads_list` shows it, and not downloads from before you connected.
- `[browser]` `upload_file` with a file in `~/Documents` attaches it and reports its name and size.
- `[browser]` `upload_file` with `~/.ssh/id_rsa`, with a `.env` under `~/Documents`, and with a symlink in `~/Documents` pointing at either, are all refused with a message naming the roots.
- `[browser]` The same refused path inside a `batch` is refused too.

## Pitfalls

- **Check the resolved path and pass on the resolved path.** Checking a symlink and then handing the symlink to the browser leaves a gap between check and use.
- **Trusting `Content-Length`** lets a client write past the cap.
- **Sending large files over the WebSocket** blocks every other message. Use the HTTP side channel and send back only the URL.
- **Nothing here deletes `./files`.** Step 14 adds cleanup.
- **The relay must run on the browser's machine** from this step on: both downloads and uploads are read from its disk.

## Carry forward

- `PUT /upload` and "upload a file" are what step 13 uses to deliver video.
- From this step, the server builder and the result shaping take the request's public base.
