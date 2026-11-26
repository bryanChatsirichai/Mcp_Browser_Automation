// Mouse and keyboard input through CDP, mouse at points in the frame (frame.ts). checkToolCall has
// already checked the tab and its URL.
//
// Used by tools.ts:
//   click      a left, right, double or triple click at a frame point
//   hover      the mouse moved to a frame point, without clicking
//   typeText   text into the focused element, then an optional submit key
//   pressKeys  keys and chords such as "Enter" or "ctrl+a", one after another
//   scroll     the mouse wheel at a frame point, up, down, left or right

import { sendCdpCommand } from "../cdp/cdp.js";
import { ToolError } from "../shared/errors.js";
import { frameOf, toCss } from "./frame.js";

/** One key: its DOM key name, Windows key code (which shortcuts such as ctrl+a match on) and the text it types. */
interface Key {
  key: string;
  keyCode: number;
  text?: string;
}

/** Keys with names, looked up in lower case. Single characters such as "a" need no entry. */
const NAMED_KEYS: Record<string, Key> = {
  enter: { key: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", keyCode: 9 },
  escape: { key: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", keyCode: 8 },
  delete: { key: "Delete", keyCode: 46 },
  space: { key: " ", keyCode: 32, text: " " },
  arrowleft: { key: "ArrowLeft", keyCode: 37 },
  arrowup: { key: "ArrowUp", keyCode: 38 },
  arrowright: { key: "ArrowRight", keyCode: 39 },
  arrowdown: { key: "ArrowDown", keyCode: 40 },
  home: { key: "Home", keyCode: 36 },
  end: { key: "End", keyCode: 35 },
  pageup: { key: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", keyCode: 34 },
};

/** CDP's modifier bits. */
const MODIFIERS: Record<string, number> = {
  alt: 1,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  shift: 8,
};

/**
 * Types text into the focused element, key by key like a real keyboard, so pages listening for
 * keydown see it. Characters a US keyboard has no key for (emoji, Thai, accents) are inserted (drop directly) instead.
 */
export async function typeText(
  tabId: number,
  text: string,
  submitKey?: string,
): Promise<void> {
  // One Input.insertText for the whole text would be simpler and faster, but autocomplete and
  // one-time-code boxes often react only to key presses. " " to "~" is what a US keyboard types.
  for (const char of text) {
    if (char >= " " && char <= "~") {
      await dispatchKey(tabId, keyOf(char), 0);
    } else {
      await sendCdpCommand(tabId, "Input.insertText", { text: char });
    }
  }
  if (submitKey !== undefined) {
    await pressKeys(tabId, submitKey);
  }
}

/** Presses space-separated keys or chords in order: "Enter", "ctrl+a", "Tab Tab Enter". Throws BAD_ARGS for an unknown key. */
export async function pressKeys(tabId: number, keys: string): Promise<void> {
  for (const chord of keys.trim().split(/\s+/)) {
    const names = chord.split("+");
    const key = keyOf(names.pop()!);
    let modifiers = 0;
    for (const name of names) {
      const bit = MODIFIERS[name.toLowerCase()];
      if (bit === undefined) {
        throw new ToolError(
          "BAD_ARGS",
          `Unknown modifier "${name}" in "${chord}". Use ctrl, shift, alt or cmd.`,
        );
      }
      modifiers |= bit;
    }
    // Zooming the page would move every coordinate read off the last screenshot.
    if (
      modifiers & (MODIFIERS.ctrl | MODIFIERS.cmd) &&
      ["=", "+", "-", "0"].includes(key.key)
    ) {
      throw new ToolError(
        "BAD_ARGS",
        `"${chord}" would zoom the page, which is not allowed.`,
      );
    }
    await dispatchKey(tabId, key, modifiers);
  }
}

/** A named key or a single character as a Key. Throws BAD_ARGS for anything else. */
function keyOf(name: string): Key {
  const named = NAMED_KEYS[name.toLowerCase()];
  if (named) {
    return named;
  }
  if ([...name].length !== 1) {
    throw new ToolError(
      "BAD_ARGS",
      `Unknown key "${name}". Use a single character or one of: ${Object.keys(NAMED_KEYS).join(", ")}.`,
    );
  }
  const upper = name.toUpperCase();
  return {
    key: name,
    keyCode: /^[A-Z0-9]$/.test(upper) ? upper.charCodeAt(0) : 0,
    text: name,
  };
}

/** Presses and releases one key, as a real keyboard does. */
async function dispatchKey(
  tabId: number,
  { key, keyCode, text }: Key,
  modifiers: number,
): Promise<void> {
  // With ctrl, alt or cmd held a key runs a shortcut instead of typing, so it sends no text:
  // ctrl+a must select all, not type "a". rawKeyDown is CDP's keydown without text.
  const typed = modifiers & ~MODIFIERS.shift ? undefined : text;
  await sendCdpCommand(tabId, "Input.dispatchKeyEvent", {
    type: typed ? "keyDown" : "rawKeyDown",
    modifiers,
    key,
    windowsVirtualKeyCode: keyCode,
    text: typed,
  });
  await sendCdpCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers,
    key,
    windowsVirtualKeyCode: keyCode,
  });
}

/**
 * The button and click count of each click action. buttons is the mask of held buttons
 * (1 = left, 2 = right); some pages read it instead of button.
 */
const CLICKS = {
  left_click: { button: "left", buttons: 1, count: 1 },
  right_click: { button: "right", buttons: 2, count: 1 },
  double_click: { button: "left", buttons: 1, count: 2 },
  triple_click: { button: "left", buttons: 1, count: 3 },
} as const;

/**
 * One click action at a frame point: a move, then a press and a release per click, the events a
 * real mouse sends. Throws BAD_ARGS for a point outside the frame.
 */
export async function click(
  tabId: number,
  point: [number, number],
  action: keyof typeof CLICKS,
): Promise<void> {
  const { x, y } = await cssPointOf(tabId, point);
  const { button, buttons, count } = CLICKS[action];
  await sendCdpCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
  });
  // A double click is two press-release pairs with clickCount 1 then 2, as a real mouse reports it,
  // not one pair with clickCount 2: pages fire dblclick on the second pair.
  for (let clickCount = 1; clickCount <= count; clickCount++) {
    await sendCdpCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      buttons,
      clickCount,
    });
    await sendCdpCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      buttons: 0,
      clickCount,
    });
  }
}

/**
 * Moves the mouse to a frame point without clicking. It stays there until the next mouse event,
 * so menus and tooltips that open on hover stay open. Throws BAD_ARGS for a point outside the frame.
 */
export async function hover(
  tabId: number,
  point: [number, number],
): Promise<void> {
  const { x, y } = await cssPointOf(tabId, point);
  await sendCdpCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
  });
}

/** One wheel notch in CSS px: the delta Chrome reports for a real notch on Windows and Linux. */
const WHEEL_TICK = 100;

/** The [deltaX, deltaY] sign of each scroll direction; positive deltaY scrolls down. */
const WHEEL_STEPS = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
} as const;

/**
 * Turns the mouse wheel amount ticks at a frame point. The event goes to the element under the
 * point, like a real wheel, so a scrollable panel scrolls instead of the page.
 * Throws BAD_ARGS for a point outside the frame.
 */
export async function scroll(
  tabId: number,
  point: [number, number],
  direction: keyof typeof WHEEL_STEPS,
  amount: number,
): Promise<void> {
  const { x, y } = await cssPointOf(tabId, point);
  const [stepX, stepY] = WHEEL_STEPS[direction];
  await sendCdpCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX: stepX * amount * WHEEL_TICK,
    deltaY: stepY * amount * WHEEL_TICK,
  });
}

/** A frame point as a CSS point in the tab's viewport. Throws BAD_ARGS for a point outside the frame. */
async function cssPointOf(
  tabId: number,
  [frameX, frameY]: [number, number],
): Promise<{ x: number; y: number }> {
  // Measured fresh each call, like captureViewport: scrolling and resizing change the frame.
  const { cssVisualViewport: view } = await sendCdpCommand(
    tabId,
    "Page.getLayoutMetrics",
  );
  return toCss(frameOf(view.clientWidth, view.clientHeight), frameX, frameY);
}
