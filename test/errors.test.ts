import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolError, toErrorBody } from "../extension/dist/shared/errors.js";

test("toErrorBody keeps a ToolError code, message and extra fields", () => {
  assert.deepEqual(
    toErrorBody(new ToolError("NO_TAB", "Tab 7 is gone.", { tabId: 7 })),
    { tabId: 7, code: "NO_TAB", message: "Tab 7 is gone." },
  );
});

test("toErrorBody: extra fields cannot override code or message", () => {
  assert.deepEqual(
    toErrorBody(
      new ToolError("BUSY", "real", { code: "FAKE", message: "fake" }),
    ),
    { code: "BUSY", message: "real" },
  );
});

test("toErrorBody maps any other thrown value to ERROR", () => {
  assert.deepEqual(toErrorBody(new Error("boom")), {
    code: "ERROR",
    message: "boom",
  });
  assert.deepEqual(toErrorBody("plain"), { code: "ERROR", message: "plain" });
});
