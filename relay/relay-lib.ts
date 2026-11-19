// Pure helpers for relay.ts. Importing relay.ts starts a server, so testable logic lives here.

import type { IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import * as z from 'zod';
import type { ToRelay } from '../extension/src/protocol.ts';

const ToRelaySchema = z.union([
  // Short limits: these strings end up in the relay's log.
  z.object({ type: z.literal('hello'), token: z.string().max(512), browser: z.string().max(64), version: z.string().max(32) }),
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('pong') }),
  z.object({ type: z.literal('result'), id: z.string(), ok: z.literal(true), data: z.unknown() }),
  z.object({
    type: z.literal('result'),
    id: z.string(),
    ok: z.literal(false),
    error: z.looseObject({ code: z.string(), message: z.string() }),
  }),
]) satisfies z.ZodType<ToRelay>;

/**
 * The shell command that starts the browser when a call arrives and none is connected.
 * BROWSER_LAUNCH overrides the default; "off" or an empty value disables launching.
 * The default starts Chrome; `start` on Windows finds chrome.exe through its App Paths entry.
 */
export function browserLaunchCommand(configured: string | undefined, platform: NodeJS.Platform): string {
  if (configured !== undefined) {
    const command = configured.trim();
    return command.toLowerCase() === 'off' ? '' : command;
  }
  if (platform === 'win32') return 'start "" chrome';
  if (platform === 'darwin') return 'open -g -a "Google Chrome"';
  return 'google-chrome';
}

const FENCE = 'untrusted-browser-content';
// Characters a model reads but a person reviewing the page cannot see: Unicode tag characters
// (U+E0000-E007F), bidirectional embeddings and overrides (U+202A-202E) and isolates (U+2066-2069).
// Written as escapes because the literal characters are themselves invisible in an editor.
const INVISIBLE = /[\u{E0000}-\u{E007F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;

/**
 * Wraps text that came from web pages so the model can tell it is data, not instructions.
 * The nonce is random per result, so a page cannot write a closing tag that ends the block early;
 * the tag name inside the body is defanged so a page cannot even imitate it.
 */
export function fence(text: string, nonce = randomBytes(8).toString('hex')): string {
  const body = text.replace(INVISIBLE, '').replaceAll(FENCE, FENCE.replaceAll('-', '_'));
  return `<${FENCE} id="${nonce}">\n${body}\n</${FENCE} id="${nonce}">`;
}

/** A message from the extension, or null for anything that is not valid JSON of a known shape. */
export function parseToRelay(raw: string): ToRelay | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = ToRelaySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost']);

/** Minimal request shape, so tests can pass a plain object. */
export type RequestLike = Pick<IncomingMessage, 'headers'> & { socket: { remoteAddress?: string } };

/**
 * True only for a request from this machine that no web page, proxy or tunnel is involved in.
 * Limit: a raw TCP forward can forge Host and omit Origin, and is not detected.
 */
export function isLocal(req: RequestLike): boolean {
  if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? '')) return false; // other machines

  const host = req.headers.host;
  if (!host || !LOCAL_HOSTNAMES.has(hostnameOf(host))) return false; // DNS rebinding, HTTP tunnels

  if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host']) return false; // reverse proxies

  const origin = req.headers.origin;
  if (origin && !origin.startsWith('chrome-extension://')) return false; // web pages

  return true;
}

function hostnameOf(host: string): string {
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}
