// The frame: the pixel space of screenshots, and of every coordinate the model sends.
// Pure arithmetic with no `chrome`, so tests can load it.
//
//   device px = CSS px x devicePixelRatio   what the screen has
//   CSS px                                  what CDP clips and input events use
//   frame px  = CSS px x ratio              what the model sees and sends

/**
 *  Anthropic's docs
 * https://platform.claude.com/docs/en/build-with-claude/vision#resolution-and-token-cost
 */
export const MAX_FRAME_EDGE = 1568;

export interface Frame {
  /** Frame px per CSS px; at most 1, so a small viewport is never enlarged. */
  ratio: number;
  width: number;
  height: number;
}

/** The frame for a CSS viewport: scaled so its longer edge is at most MAX_FRAME_EDGE. */
export function frameOf(cssWidth: number, cssHeight: number): Frame {
  const ratio = Math.min(1, MAX_FRAME_EDGE / Math.max(cssWidth, cssHeight));
  return { ratio, width: Math.round(cssWidth * ratio), height: Math.round(cssHeight * ratio) };
}
