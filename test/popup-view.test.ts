import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claudeCodeCommand,
  STATUS_COPY,
} from "../extension/dist/popup/view.js";

const EXPECTED =
  "claude mcp add --scope user --transport http browser http://127.0.0.1:8787/mcp";

test("claudeCodeCommand: appends /mcp to the relay URL", () => {
  assert.equal(claudeCodeCommand("http://127.0.0.1:8787"), EXPECTED);
});

test("claudeCodeCommand: a trailing slash does not double up", () => {
  assert.equal(claudeCodeCommand("http://127.0.0.1:8787/"), EXPECTED);
});

test("STATUS_COPY: covers exactly the six worker states with text", () => {
  assert.deepEqual(Object.keys(STATUS_COPY).sort(), [
    "connected",
    "connecting",
    "disconnected",
    "replaced",
    "unauthorized",
    "unreachable",
  ]);
  for (const { title, detail } of Object.values(STATUS_COPY)) {
    assert.ok(title.length > 0 && detail.length > 0);
  }
});
