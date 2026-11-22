// The Chrome DevTools Protocol (CDP) link to each tab, through chrome.debugger. 
// It is how the extension acts inside a page.
// While attached, Chrome shows a "started debugging this browser" bar.
//
// Only this file calls chrome.debugger:
//   sendCdpCommand        runs one CDP command on a tab, attaching first
//   detachCdpFromAllTabs  detaches from every tab, so the debugging bar goes away

import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping.js";
import { ToolError } from "../shared/errors.js";

type Commands = ProtocolMapping.Commands;

const PROTOCOL_VERSION = "1.3";

/** Tabs this worker is attached to. */
const attached = new Set<number>();
/** Attaches in progress, so two calls on one tab share a single attach. */
const attaching = new Map<number, Promise<void>>();

// Chrome detaches by itself when the tab closes or the user cancels the debugging bar.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) {
    attached.delete(source.tabId);
  }
});

/** Runs a CDP command on a tab and returns its typed result. Throws CDP_ERROR on failure. */
export async function sendCdpCommand<M extends keyof Commands>(
  tabId: number,
  method: M,
  ...params: Commands[M]["paramsType"]
): Promise<Commands[M]["returnType"]> {
  await attachCdp(tabId);
  try {
    const result = await chrome.debugger.sendCommand({ tabId }, method, params[0]);
    return result as Commands[M]["returnType"];
  } catch (error) {
    throw new ToolError("CDP_ERROR", `${method} failed on tab ${tabId}: ${errorMessage(error)}`);
  }
}

/** Detaches from every tab Chrome lists as attached; tabs attached by others are skipped. */
export async function detachCdpFromAllTabs(): Promise<void> {
  const targets = await chrome.debugger.getTargets();
  await Promise.all(
    targets
      .filter((target) => target.attached && target.tabId !== undefined)
      .map((target) => chrome.debugger.detach({ tabId: target.tabId }).catch(() => undefined)),
  );
  attached.clear();
}

/** Attaches once per tab; concurrent callers wait on the same attach. */
async function attachCdp(tabId: number): Promise<void> {
  if (attached.has(tabId)) {
    return;
  }
  let pending = attaching.get(tabId);
  if (!pending) {
    pending = attachCdpNow(tabId).finally(() => attaching.delete(tabId));
    attaching.set(tabId, pending);
  }
  return pending;
}

async function attachCdpNow(tabId: number): Promise<void> {
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  } catch (error) {
    // Chrome keeps an attachment when it stops the worker, but `attached` is lost with it.
    // Detach that leftover and attach again; any other failure is reported.
    if (!errorMessage(error).includes("already attached")) {
      throw new ToolError("CDP_ERROR", `Cannot attach to tab ${tabId}: ${errorMessage(error)}`);
    }
    await chrome.debugger.detach({ tabId });
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  }
  attached.add(tabId);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
