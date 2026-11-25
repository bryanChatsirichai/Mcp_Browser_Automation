// Mouse and keyboard input through CDP, mouse at points in the frame (frame.ts). checkToolCall has
// already checked the tab and its URL.
//
// Used by tools.ts:
//   leftClick  one left click at a frame point
//   typeText   text into the focused element, then an optional submit key
//   pressKeys  keys and chords such as "Enter" or "ctrl+a", one after another

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
const MODIFIERS: Record<string, number> = { alt: 1, ctrl: 2, meta: 4, cmd: 4, shift: 8 };

/**
 * Types text into the focused element, key by key like a real keyboard, so pages listening for
 * keydown see it. Characters a US keyboard has no key for (emoji, Thai, accents) are inserted (drop directly) instead.
 */
export async function typeText(tabId: number, text: string, submitKey?: string): Promise<void> {
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
        throw new ToolError("BAD_ARGS", `Unknown modifier "${name}" in "${chord}". Use ctrl, shift, alt or cmd.`);
      }
      modifiers |= bit;
    }
    // Zooming the page would move every coordinate read off the last screenshot.
    if (modifiers & (MODIFIERS.ctrl | MODIFIERS.cmd) && ["=", "+", "-", "0"].includes(key.key)) {
      throw new ToolError("BAD_ARGS", `"${chord}" would zoom the page, which is not allowed.`);
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
  return { key: name, keyCode: /^[A-Z0-9]$/.test(upper) ? upper.charCodeAt(0) : 0, text: name };
}

/** Presses and releases one key, as a real keyboard does. */
async function dispatchKey(tabId: number, { key, keyCode, text }: Key, modifiers: number): Promise<void> {
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
 * One left click at a frame point: a move, a press and a release, the events a real mouse sends.
 * Throws BAD_ARGS for a point outside the frame.
 */
export async function leftClick(tabId: number, [frameX, frameY]: [number, number]): Promise<void> {
  // Measured fresh each call, like captureViewport: scrolling and resizing change the frame.
  const { cssVisualViewport: view } = await sendCdpCommand(tabId, "Page.getLayoutMetrics");
  const { x, y } = toCss(frameOf(view.clientWidth, view.clientHeight), frameX, frameY);
  await sendCdpCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  // buttons is the mask of held buttons (1 = left). Some pages read it instead of button.
  await sendCdpCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await sendCdpCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}
