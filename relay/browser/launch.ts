// Starts the user's browser when a tool call needs it and no extension is connected, then waits
// for the extension to say hello. Only one launch runs at a time: calls that arrive during a
// launch wait for that same launch instead of opening another browser window.
//
// Flow: requireExtension (socket.ts) → launchBrowserAndWait → startBrowserAndWaitForHello
//         → startBrowser, then waitForHello … until onHello (socket.ts) calls onExtensionConnected

import { spawn } from "node:child_process";
import { browserLaunchCommand } from "../relay-lib.ts";
import { log } from "../log.ts";

/** Shell command that starts the browser; '' when auto-start is off (see browserLaunchCommand). */
export const BROWSER_LAUNCH = browserLaunchCommand(
  process.env.BROWSER_LAUNCH,
  process.platform,
);
/** How long a launch waits for the extension to say hello before giving up. */
export const LAUNCH_WAIT_MS = 20_000;
/**
 * When the browser is already running, the launch command opens another window instead of
 * starting it, so a call made while the extension is not connected must not trigger one per call.
 */
const LAUNCH_COOLDOWN_MS = 60_000;

/** When the browser was last launched (ms since epoch); 0 = never. */
let lastLaunchAt = 0;
/** The launch now running, or null. Calls that arrive meanwhile await this same promise. */
let currentLaunch: Promise<void> | null = null;
/** Ends the current launch's wait as soon as the extension says hello; null when nothing waits. */
let stopWaiting: (() => void) | null = null;

/**
 * Starts the browser and waits until its extension says hello or LAUNCH_WAIT_MS passes.
 * Joins a launch that is already running instead of starting a second one, and does nothing
 * when auto-start is off or the last launch is within the cooldown.
 * Never rejects: the caller checks for itself whether an extension connected.
 */
export function launchBrowserAndWait(): Promise<void> {
  if (currentLaunch) {
    log("[launchBrowserAndWait:] a launch is already running; waiting for it");
    return currentLaunch;
  }
  const reason = reasonNotToLaunch();
  if (reason) {
    log(`[launchBrowserAndWait:] not starting the browser: ${reason}`);
    return Promise.resolve();
  }
  currentLaunch = startBrowserAndWaitForHello().finally(() => {
    currentLaunch = null;
  });
  return currentLaunch;
}

/** Called by onHello (socket.ts) on every hello. Ends the current launch's wait, if any. */
export function onExtensionConnected(): void {
  stopWaiting?.();
}

/** True once a launch was attempted, so the error text can say the browser was started. */
export function browserWasLaunched(): boolean {
  return lastLaunchAt > 0;
}

/** Why a new launch must not start now, or null when it may. */
function reasonNotToLaunch(): string | null {
  if (!BROWSER_LAUNCH) {
    return "auto-start is off (BROWSER_LAUNCH)";
  }
  const sinceLastLaunch = Date.now() - lastLaunchAt;
  if (sinceLastLaunch < LAUNCH_COOLDOWN_MS) {
    return `the last launch was ${sinceLastLaunch}ms ago (cooldown ${LAUNCH_COOLDOWN_MS}ms)`;
  }
  return null;
}

async function startBrowserAndWaitForHello(): Promise<void> {
  lastLaunchAt = Date.now();
  log(`[startBrowserAndWaitForHello:] starting the browser: ${BROWSER_LAUNCH}`);
  startBrowser();

  const connected = await waitForHello(LAUNCH_WAIT_MS);
  const waited = Date.now() - lastLaunchAt;
  log(
    connected
      ? `[startBrowserAndWaitForHello:] extension connected after ${waited}ms`
      : `[startBrowserAndWaitForHello:] no extension after ${waited}ms; giving up`,
  );
}

/** Runs the launch command in the background. The relay neither waits for it nor stops it. */
function startBrowser(): void {
  const child = spawn(BROWSER_LAUNCH, {
    shell: true,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", (error) =>
    log(`[startBrowser:] launch command failed: ${error.message}`),
  );
  child.unref(); // the relay must not wait for the browser to exit
}

/** Resolves true when onExtensionConnected runs, or false after `timeoutMs`. */
function waitForHello(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    stopWaiting = () => finish(true);

    // Clearing stopWaiting means a late hello cannot finish this wait a second time.
    function finish(connected: boolean): void {
      clearTimeout(timer);
      stopWaiting = null;
      resolve(connected);
    }
  });
}
