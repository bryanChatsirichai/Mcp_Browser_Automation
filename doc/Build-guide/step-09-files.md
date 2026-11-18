# Step 9: Files: storage, PDF, downloads, uploads

**Goal.** Binary output (saved screenshots, PDFs) reaches the client as a URL; the agent can download with the browser's session; and the agent can attach local files to a page without being able to read anything it should not.

**Builds on.** Step 8.

## Files

```text
relay.ts                    + PUT /upload, GET /files, publicBase, checkUploads
relay-lib.ts                + safeName, isUploadable, absolutize
extension/src/upload.ts     uploadFile, base64ToBlob                 (new)
extension/src/files.ts      download, list, pdf, path                (new)
extension/src/input.ts      + uploadFiles
extension/src/tools.ts      + files, upload_file handlers; guard checks download URLs
extension/src/background.ts + markSession on ready, endSession on disconnect
extension/manifest.json     + "downloads"
tools.ts                    + files, upload_file; save option on screenshot
test/paths.test.ts                                                   (new)
```

## Sub-tasks

### A. The relay stores and serves files

**9.1 `PUT /upload/<name>`.** Refuse early if `Content-Length` exceeds the cap (`MAX_UPLOAD_MB`, default 500). Create `./files/<16 hex chars>/` and stream the body into it through a `Transform` that counts bytes and errors past the cap, because `Content-Length` can be missing or false. On failure remove the directory. Reply `{ url: "/files/<id>/<name>", name, size }`. Answer `OPTIONS /upload/...` with CORS headers for the extension's preflight.

**9.2 `safeName(raw)`.** URL-decode, take the basename, replace everything outside `[\w.\- ]` with `_`, strip leading dots, fall back to `file`.

**9.3 `GET /files/<id>/<name>`.** Require `<id>` to match `^[a-f0-9]{16}$`. Stream the file with:

| Header | Why |
|---|---|
| `content-type` from a small extension table, else `application/octet-stream` | No guessing |
| `x-content-type-options: nosniff` | The browser must not guess either |
| `content-security-policy: sandbox` for HTML | A stored page must not run script on the relay's origin |
| `referrer-policy: no-referrer` | The link may carry a token (step 12) |

**9.4 Absolute URLs.** The extension only knows `/files/...`. `publicBase(req)` returns `proto://host` from `x-forwarded-proto` / `x-forwarded-host`, else from `Host`. Pass it to `buildServer(base)` and into `toResult`: `absolutize(data, base)` prefixes any `url` field starting with `/files/` in JSON results; a regex does the same inside text parts.

### B. The extension produces files

**9.5 `upload.ts`.** `uploadFile(relay, name, blob)` does `fetch(PUT ${url}/upload/${encodeURIComponent(name)})` and returns the JSON. `base64ToBlob(data, type)`.

**9.6 Saved screenshots and PDF.** `screenshot { save: true }` also uploads the image and appends "Saved to: <url>". `files { action: "pdf", tabId }` runs `Page.printToPDF { printBackground: true }` and uploads `<sanitised title>.pdf`.

**9.7 Downloads.** `files { action: "download", url }`: `chrome.downloads.download({ url, saveAs: false, conflictAction: 'uniquify' })`, wait for `complete` or `interrupted` through `chrome.downloads.onChanged` for at most 80s, then return `{ id, name, size, mime, state, url: "/files/dl/<id>" }`.

- Add the download URL to `guard()` (`checkUrl` before starting).
- After completion check `item.finalUrl` again. If a redirect left the allowed sites: cancel, remove the file, erase the record, throw.

**9.8 The session watermark.** On `ready`, store `downloadsSince = Date.now()` in session storage unless already set; remove it on explicit disconnect. `findDownload(id)` throws `NOT_FOUND` for anything that started before it, and `downloads_list` passes it as `startedAfter`. The agent never sees the user's earlier downloads.

**9.9 Serving downloads without copying.** Add an internal action `files { action: "path", id }` returning `{ path, name }`. `GET /files/dl/<n>` on the relay calls it through `callExtension` and streams the file from the browser's download folder. Do not list `path` in the tool's schema; let it skip the queue like `tabs_list`.

### C. Uploading local files into a page, safely

**9.10 `uploadFiles(element, paths)`.** Find the file input (the element, a label's control, or the first `input[type=file]` inside), then `DOM.setFileInputFiles { files: paths, objectId }`. Read back names and sizes; warn when a size is 0, because the browser accepts a path that does not exist and gives the page an empty file.

**9.11 The path check lives on the relay**, because only Node can resolve symlinks. `isUploadable(real, roots)`:

```text
 for each root (default ~/Downloads, ~/Desktop, ~/Documents, plus ./files; override with UPLOAD_ROOTS):
     base   = realpath(root)                       skip roots that do not exist
     inside = path.relative(base, real)
     below  = inside is not "", does not start with "..", is not absolute
     accept if below AND no segment of `inside` starts with "."
```

**9.12 `checkUploads(name, args)`**, called before `callExtension`:

```ts
for (const { name: tool, input } of stepsOf(name, args)) {                 // one step, or each batch item
  if (String(tool ?? '').split('__').pop() !== 'upload_file' || !Array.isArray(input?.paths)) continue;
  const resolved = [];
  for (const file of input.paths) resolved.push(await resolveUpload(file));  // realpath -> isUploadable -> or throw BLOCKED
  input.paths = resolved;        // the browser gets the path that was checked, not a link that can be repointed
}
```

**9.13 Tests** in `test/paths.test.ts`, using a temporary directory: a file under a root passes; the root itself does not; `..` escapes fail; a dot-file and a file inside a dot-folder fail; a symlink inside the root pointing outside fails once resolved; `safeName` strips directories, odd characters and leading dots.

Reference: `relay.ts:284-303`, `relay.ts:378-418`, `relay.ts:467-606`, `upload.ts`, `files.ts`, `input.ts:339-350`, `input.ts:433-452`.

## Contracts

```ts
// relay-lib.ts
export function safeName(raw: string): string;
export function isUploadable(real: string, roots: string[]): Promise<boolean>;
export function absolutize(value: unknown, base: string): unknown;

// upload.ts
export interface RelayFile { url: string; name: string; size: number }
export function uploadFile(relay: { url: string; token: string }, name: string, body: Blob): Promise<RelayFile>;
```

## Done when

- `[auto]` `npm run check`, `npm test` pass (path tests included).
- `[auto]` `curl -X PUT --data-binary @README.md http://127.0.0.1:8787/upload/..%2F..%2Fx.md` stores the file as `x.md` inside `./files/<id>/` and returns its URL; `curl` on that URL returns the content.
- `[auto]` `GET /files/nothex/x` and `GET /files/<valid id>/missing` return 404.
- `[auto]` Uploading an `.html` file and fetching it shows the `content-security-policy: sandbox` header.
- `[browser]` `files pdf` returns an absolute URL that opens the PDF.
- `[browser]` `files download` of a file behind a login you hold in the browser succeeds; `downloads_list` shows it and not downloads from before you connected.
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

- `PUT /upload` and `uploadFile()` are what step 13 uses to deliver video.
- From this step, `buildServer` and `toResult` take the request's `base`.
