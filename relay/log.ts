// Logging shared by every relay module.

/** Set to false to silence the log. */
const LOG_ENABLED = true;

/**
 * Writes one timestamped line to stdout.
 * Never pass tool arguments, results or page content here: ids, tool names, codes and timings
 * are enough to trace a call without copying the user's browsing data into the log.
 */
export function log(message: string): void {
  if (!LOG_ENABLED) {
    return;
  }
  console.log(`${new Date().toISOString()} ${message}`);
}

/** First 8 hex chars of a call id: the extension logs the same prefix, so the two logs line up. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}
