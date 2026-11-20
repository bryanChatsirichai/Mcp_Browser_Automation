// Build step, run after the extension is compiled. An extension cannot learn where it lives on
// disk, so this records the absolute path of relay/relay.ts for the popup's "start the relay" command.

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const relay = fileURLToPath(new URL("./relay/relay.ts", import.meta.url));
const dist = new URL("./extension/dist/", import.meta.url);

mkdirSync(dist, { recursive: true });
writeFileSync(
  new URL("install.json", dist),
  `${JSON.stringify({ relay }, null, 2)}\n`,
);
console.log(`stamped extension/dist/install.json: ${relay}`);
