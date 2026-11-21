// Logging for the service worker. Lines appear in its console: chrome://extensions › Browser
// Bridge › Inspect views: service worker.

/** Set to false, then rebuild and reload the extension, to silence the log. */
const LOG_ENABLED = true;

/** Writes one line. Each message starts with the function that wrote it, as in the relay log. */
export function log(message: string): void {
  if (!LOG_ENABLED) {
    return;
  }
  console.info(`[bridge] ${message}`);
}

/** First 8 hex chars of a call id: the relay logs the same prefix, so the two logs line up. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
