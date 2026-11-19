// Starts the user's browser when a tool call arrives and no extension is connected, then waits for
// the extension to say hello. One launch runs at a time; calls that arrive during it share it.

import { spawn } from 'node:child_process';
import { browserLaunchCommand } from '../relay-lib.ts';
import { log } from '../log.ts';

/** Shell command that starts the browser; '' when auto-start is off (see browserLaunchCommand). */
export const BROWSER_LAUNCH = browserLaunchCommand(process.env.BROWSER_LAUNCH, process.platform);
export const LAUNCH_WAIT_MS = 20_000;
/**
 * When the browser is already running, the launch command opens another window instead of
 * starting it, so a call made while the extension is not connected must not trigger one per call.
 */
const LAUNCH_COOLDOWN_MS = 60_000;

/** When the browser was last launched (ms epoch); 0 = never. */
let lastLaunchAt = 0;
let launchInProgress: Promise<void> | null = null;
/** Ends the running launch's wait early. Set only while a launch is in progress. */
let endLaunchWait: (() => void) | null = null;

/** True once a launch was attempted, so the error text can say the browser was started. */
export function browserWasLaunched(): boolean {
  return lastLaunchAt > 0;
}

/**
 * Joins the launch in progress, or starts one when `mayStart` is true, auto-start is on and the
 * last launch is older than the cooldown; otherwise resolves at once.
 * Resolves when the extension says hello or after LAUNCH_WAIT_MS. It never rejects: the caller
 * checks for itself whether an extension connected.
 */
export function waitForBrowserLaunch(mayStart: boolean): Promise<void> {
  if (launchInProgress) return launchInProgress;
  if (!mayStart || !BROWSER_LAUNCH || Date.now() - lastLaunchAt < LAUNCH_COOLDOWN_MS) return Promise.resolve();
  launchInProgress = launchBrowser().finally(() => { launchInProgress = null; });
  return launchInProgress;
}

/** Called on every hello. Ends the launch wait early when one is running; otherwise does nothing. */
export function notifyExtensionConnected(): void {
  endLaunchWait?.();
}

function launchBrowser(): Promise<void> {
  lastLaunchAt = Date.now();
  log(`no browser connected; starting it with: ${BROWSER_LAUNCH}`);
  const child = spawn(BROWSER_LAUNCH, { shell: true, detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', (error) => log(`browser launch failed: ${error.message}`));
  child.unref(); // the relay must not wait for the browser to exit

  return new Promise((resolve) => {
    // Runs once: clearing endLaunchWait stops a late hello from finishing it a second time.
    const finish = (connected: boolean) => {
      clearTimeout(timer);
      endLaunchWait = null;
      const waited = Date.now() - lastLaunchAt;
      log(connected
        ? `browser launch: extension connected after ${waited}ms`
        : `browser launch: no extension after ${waited}ms; giving up`);
      resolve();
    };
    const timer = setTimeout(() => finish(false), LAUNCH_WAIT_MS);
    endLaunchWait = () => finish(true);
  });
}
