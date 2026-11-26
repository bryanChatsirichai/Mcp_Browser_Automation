import { test } from "node:test";
import assert from "node:assert/strict";
import { frameOf, toCss } from "../extension/dist/tools/frame.js";

test("frameOf: a viewport within the limit is not enlarged", () => {
  assert.deepEqual(frameOf(1280, 720), { ratio: 1, width: 1280, height: 720 });
});

test("frameOf: a wide viewport is limited by its width", () => {
  const frame = frameOf(1920, 1080);
  assert.equal(frame.width, 1568);
  assert.equal(frame.height, 882);
});

test("frameOf: a tall viewport is limited by its height", () => {
  const frame = frameOf(800, 3136);
  assert.equal(frame.width, 400);
  assert.equal(frame.height, 1568);
});

test("toCss: the frame's centre maps to the viewport's centre", () => {
  assert.deepEqual(toCss(frameOf(1920, 1080), 784, 441), { x: 960, y: 540 });
});

test("toCss: a point outside the frame throws BAD_ARGS", () => {
  assert.throws(() => toCss(frameOf(1920, 1080), 1568, 10), { code: "BAD_ARGS" });
});
