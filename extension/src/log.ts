// Logging for the service worker. Lines appear in its console: chrome://extensions › Browser
// Bridge › Inspect views: service worker.

/** Writes one line. Each message starts with the function that wrote it, as in the relay log. */
export function log(message: string): void {
  console.info(`[bridge] ${message}`);
}

/** First 8 hex chars of a call id: the relay logs the same prefix, so the two logs line up. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
