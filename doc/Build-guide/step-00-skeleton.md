# Step 0: Project skeleton

**Goal.** An empty relay that runs, an empty extension that loads, and three commands that pass: check, build, test.

**Builds on.** Nothing.

## Files

```text
package.json   tsconfig.json   .gitignore
relay.ts                       prints one line and exits
test/smoke.test.ts             one passing test
extension/manifest.json
extension/tsconfig.json
extension/src/background.ts    logs one line
```

## Sub-tasks

**0.1 `package.json`.** Mark the package as an ES module and add the scripts. Install the dependencies; the reference uses `@modelcontextprotocol/sdk`, `ws`, `zod` at runtime and `typescript`, `@types/node`, `@types/ws`, `@types/chrome`, `devtools-protocol` for development.

```json
{
  "name": "browser-bridge",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.18" },
  "scripts": {
    "relay": "node relay.ts",
    "build": "tsc -p extension",
    "check": "tsc -p . && tsc -p extension --noEmit",
    "test": "tsc -p extension && node --test \"test/*.test.ts\""
  }
}
```

**0.2 Root `tsconfig.json`** for the Node side. The important flags:

| Flag | Why |
|---|---|
| `"noEmit": true` | Node runs the `.ts` files itself; nothing is compiled |
| `"allowImportingTsExtensions": true` | Imports are written `./relay-lib.ts` |
| `"erasableSyntaxOnly": true` | Rejects syntax Node cannot strip: enums, namespaces, `constructor(public x)` |
| `"verbatimModuleSyntax": true` | `import type` is removed entirely, plain `import` is kept |
| `"module"` / `"moduleResolution"`: `"NodeNext"` | Node's real resolution rules |

List the files explicitly: `"files": ["relay.ts", "relay-lib.ts", "tools.ts", "stamp.ts"]` (add each as it appears), plus `"include": ["test"]`.

**0.3 `extension/tsconfig.json`** for the browser side: `"module": "ES2022"`, `"moduleResolution": "Bundler"`, `"lib": ["ES2023", "DOM", "DOM.Iterable"]`, `"types": ["chrome"]`, `"rootDir": "src"`, `"outDir": "dist"`, and the same `erasableSyntaxOnly` and `verbatimModuleSyntax`.

**0.4 `extension/manifest.json`.** Manifest V3 with a module service worker. Start with only the permissions step 2 needs; later steps add theirs.

```json
{
  "manifest_version": 3,
  "name": "Browser Bridge",
  "version": "0.1.0",
  "minimum_chrome_version": "125",
  "permissions": ["storage", "alarms"],
  "background": { "service_worker": "dist/background.js", "type": "module" }
}
```

**0.5 Placeholders.** `relay.ts` logs "relay placeholder". `background.ts` logs "worker started". `test/smoke.test.ts` asserts `1 + 1 === 2` using `node:test` and `node:assert/strict`.

**0.6 `.gitignore`**: `node_modules/`, `extension/dist/`, `files/`.

Reference: `package.json`, `tsconfig.json`, `extension/tsconfig.json`, `extension/manifest.json`.

## Done when

- `[auto]` `npm run check` exits 0.
- `[auto]` `npm run build` creates `extension/dist/background.js`.
- `[auto]` `npm test` reports 1 passing test.
- `[auto]` `npm run relay` prints the placeholder line.
- `[browser]` `chrome://extensions` > Developer mode > Load unpacked > `extension/` loads with no error, and "service worker" > Inspect shows "worker started".

## Pitfalls

- **Imports inside `extension/src` must end in `.js`** (`import { x } from './cdp.js'`). `tsc` does not rewrite extensions, and Chrome loads the emitted files as native modules with no bundler to resolve a bare `./cdp`.
- **A test cannot import `extension/src/*.ts` directly** once those files import each other with `.js` endings: Node would look for a `.js` file beside the source. Tests of extension logic import from `extension/dist/`, which is why the `test` script compiles first.
- **A test can only import extension modules that never touch `chrome`.** Under Node there is no `chrome` global, and a module that registers a listener at load time throws on import. Keep testable logic in chrome-free modules (see the README).
- An old default `node` on the PATH fails with confusing errors. Check `node --version` first.

## Carry forward

- `npm run check` and `npm test` are the gate for every later step.
- Extension code has no runtime dependencies and no bundler. Keep it that way: type-only imports from `devtools-protocol` are fine because they are erased.
