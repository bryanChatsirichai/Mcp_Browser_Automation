# Step 0: Project skeleton

**Goal.** An empty relay that runs, an empty extension that loads, and three commands that pass: check, build, test.

**Builds on.** Nothing.

## Files

```text
package.json   tsconfig.json   .gitignore
relay/relay.ts                 prints one line and exits
test/smoke.test.ts             one passing test
extension/manifest.json
extension/tsconfig.json
extension/src/background.ts    logs one line
```

## Sub-tasks

**0.1 `package.json`.** Set these fields:

| Field | Value | Why |
|---|---|---|
| `type` | `module` | The relay and tests use ES modules |
| `private` | `true` | Prevents an accidental `npm publish` |
| `engines.node` | `>=22.18` | The first Node line that strips TypeScript types without a flag |

Add four scripts:

| Script | Runs | Purpose |
|---|---|---|
| `relay` | Node on `relay/relay.ts` | Start the server |
| `build` | The TypeScript compiler on the extension project | Emit the extension's JavaScript into `extension/dist/` |
| `check` | The compiler on the root project, then on the extension project with no output | Type-check both halves |
| `test` | The extension build, then `node --test` on `test/*.test.ts` | Tests of extension logic import the compiled files, so the build must run first |

Install the dependencies:

- **Runtime:** the official MCP TypeScript SDK (`@modelcontextprotocol/sdk`), `ws` (WebSocket server for Node), and `zod` (validating incoming messages).
- **Development:** `typescript`, `@types/node`, `@types/ws`, `@types/chrome`, and `devtools-protocol` (type definitions for every CDP command and event).

**0.2 Root `tsconfig.json`** for the Node side. Node runs the `.ts` files directly, so this project only type-checks. The flags that matter:

| Flag | Value | Why |
|---|---|---|
| `noEmit` | true | Node runs the `.ts` files itself; nothing is compiled |
| `allowImportingTsExtensions` | true | Imports are written with the `.ts` ending, as Node requires |
| `erasableSyntaxOnly` | true | Rejects syntax Node cannot strip: enums, namespaces, constructor parameter properties |
| `verbatimModuleSyntax` | true | Type-only imports must say so, and are removed entirely |
| `module` and `moduleResolution` | `NodeNext` | Node's real resolution rules |
| `strict` | true | |

Include the `relay` folder and the `test` folder, and list root files explicitly (`stamp.ts` from step 12).

**0.3 `extension/tsconfig.json`** for the browser side. This project does emit JavaScript.

| Flag | Value |
|---|---|
| `module` | `ES2022` |
| `moduleResolution` | `Bundler` |
| `lib` | `ES2023`, `DOM`, `DOM.Iterable` |
| `types` | `chrome` |
| `rootDir` / `outDir` | `src` / `dist` |
| `erasableSyntaxOnly`, `verbatimModuleSyntax`, `strict` | true |

The same erasable-syntax rule applies here because the relay will import one extension file (`protocol.ts`) directly in step 2.

**0.4 `extension/manifest.json`.** Manifest V3. Set:

- `manifest_version` 3, a `name`, a `version`, and `minimum_chrome_version` `125`.
- `permissions`: only `storage` and `alarms` for now. Later steps add theirs.
- `background`: a service worker at `dist/background.js` with `type` `module`, so it can use `import`.

**0.5 Placeholders.** `relay/relay.ts` logs "relay placeholder". `background.ts` logs "worker started". `test/smoke.test.ts` uses `node:test` and `node:assert/strict` to assert that one plus one is two.

**0.6 `.gitignore`**: `node_modules/`, `extension/dist/`, `files/` (the relay's file store, from step 9).

## Done when

- `[auto]` `npm run check` exits 0.
- `[auto]` `npm run build` creates `extension/dist/background.js`.
- `[auto]` `npm test` reports 1 passing test.
- `[auto]` `npm run relay` prints the placeholder line.
- `[browser]` `chrome://extensions` > Developer mode > Load unpacked > `extension/` loads with no error, and "service worker" > Inspect shows "worker started".

## Pitfalls

- **Imports inside `extension/src` must end in `.js`**, even though the source files end in `.ts`. The compiler does not rewrite import paths, and Chrome loads the emitted files as native modules with no bundler to resolve an import without an ending.
- **A test cannot import `extension/src/*.ts` directly** once those files import each other with `.js` endings: Node would look for a `.js` file beside the source. Tests of extension logic import from `extension/dist/`, which is why the `test` script builds first.
- **A test can only import extension modules that never touch `chrome`.** Under Node there is no `chrome` global, and a module that registers a listener at load time throws on import. Keep testable logic in chrome-free modules (see the README).
- An old default `node` on the PATH fails with confusing errors. Check `node --version` first.

## Carry forward

- `npm run check` and `npm test` are the gate for every later step.
- The extension has no runtime dependencies and no bundler. Keep it that way. Type-only imports from `devtools-protocol` are fine because they are erased.
