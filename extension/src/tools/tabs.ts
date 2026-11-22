// The agent works only in one tab group, so it stays visibly apart from the user's tabs. Where
// the group is created follows the tabWindow setting; new windows are never focused.
//
// Used by tools.ts:
//   groupTabs     the group's tabs (never creates the group)
//   ensureGroup   the group's tabs, creating the group when there is none
//   openTab       a new tab in the group, creating the group when there is none
//   checkInGroup  refuses any tab outside the group with NOT_IN_GROUP (used by checkToolCall)
//   closeTab      closes a tab
//   navigateTab   loads a URL through CDP and waits for the load
//   tabContext    the tab list returned to the model
// Creating a group: createGroup → createFirstGroupTab (where, per tabWindow) → group and title it

import { sendCdpCommand } from "../cdp/cdp.js";
import { ToolError } from "../shared/errors.js";
import { loadSettings } from "../shared/settings.js";
import type { TabWindow } from "../shared/settings.js";

const GROUP_TITLE = "MCP Browser";
const GROUP_COLOR = "orange";
const MAX_TITLE = 100;
const MAX_URL = 200;
const LOAD_TIMEOUT_MS = 30_000;
const SAME_DOCUMENT_MS = 1_500;

export interface TabContext {
  availableTabs: Array<{ tabId: number; title: string; url: string }>;
  tabGroupId: number | null;
}

/**
 * The group id is cached in session storage, but it changes when the browser restarts while
 * the group itself can survive, so fall back to finding the group by its title.
 */
async function findGroup(): Promise<chrome.tabGroups.TabGroup | undefined> {
  const { groupId } = await chrome.storage.session.get<{ groupId?: number }>(
    "groupId",
  );
  if (typeof groupId === "number") {
    try {
      return await chrome.tabGroups.get(groupId);
    } catch {
      // The group was closed; look it up by title below.
    }
  }
  const [group] = await chrome.tabGroups.query({ title: GROUP_TITLE });
  await chrome.storage.session.set({ groupId: group?.id });
  return group;
}

/** The tabs in the agent's group; empty when there is no group. Never creates one. */
export async function groupTabs(): Promise<chrome.tabs.Tab[]> {
  const group = await findGroup();
  return group ? chrome.tabs.query({ groupId: group.id }) : [];
}

/**
 * The user's main window: the normal window they focused last, or, if that one is private,
 * any other open normal window. Undefined when no normal, non-private window is open.
 */
async function findMainWindow(): Promise<chrome.windows.Window | undefined> {
  try {
    const last = await chrome.windows.getLastFocused({
      windowTypes: ["normal"],
    });
    if (!last.incognito) {
      return last;
    }
  } catch {
    // No window has had focus yet; fall through to any open window.
  }
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  return windows.find((window) => !window.incognito);
}

/** The first tab of a new unfocused window. */
async function openTabInNewWindow(
  incognito: boolean,
): Promise<chrome.tabs.Tab | undefined> {
  const window = await chrome.windows.create({
    focused: false,
    incognito,
    url: "about:blank",
  });
  return window?.tabs?.[0];
}

async function createFirstGroupTab(
  placement: TabWindow,
): Promise<chrome.tabs.Tab | undefined> {
  if (placement === "incognito") {
    if (!(await chrome.extension.isAllowedIncognitoAccess())) {
      throw new ToolError(
        "INCOGNITO_NOT_ALLOWED",
        "The extension is set to open agent tabs in an incognito window, but it is not allowed in incognito. " +
          'Ask the user to enable "Allow in Incognito" for the extension (chrome://extensions > Details), ' +
          "or to choose another window in the extension popup.",
      );
    }
    return openTabInNewWindow(true);
  }
  if (placement === "current") {
    const window = await findMainWindow();
    // Inactive, so the user's own tab stays in front.
    if (window?.id !== undefined) {
      return chrome.tabs.create({
        windowId: window.id,
        url: "about:blank",
        active: false,
      });
    }
  }
  return openTabInNewWindow(false);
}

/** One blank tab, grouped and titled, placed as the tabWindow setting says. Returns that tab. */
async function createGroup(): Promise<chrome.tabs.Tab> {
  const tab = await createFirstGroupTab((await loadSettings()).tabWindow);
  if (tab?.id === undefined) {
    throw new Error("The browser did not create a tab for the tab group.");
  }

  const groupId = await chrome.tabs.group({
    tabIds: tab.id,
    createProperties: { windowId: tab.windowId },
  });
  await chrome.tabGroups.update(groupId, {
    title: GROUP_TITLE,
    color: GROUP_COLOR,
  });
  await chrome.storage.session.set({ groupId });
  return tab;
}

/** Opens a blank tab in the group, creating the group first if there is none. */
export async function openTab(): Promise<chrome.tabs.Tab> {
  const group = await findGroup();
  if (!group) {
    return createGroup();
  }
  // Inactive, so the group's window is not brought to the front.
  const tab = await chrome.tabs.create({
    windowId: group.windowId,
    url: "about:blank",
    active: false,
  });
  if (tab.id === undefined) {
    throw new Error("The browser did not return an id for the new tab.");
  }
  await chrome.tabs.group({ groupId: group.id, tabIds: tab.id });
  return tab;
}

/** Returns the tab if it is in the group; throws NOT_IN_GROUP for any other, including closed ones. */
export async function checkInGroup(tabId: number): Promise<chrome.tabs.Tab> {
  const tab = (await groupTabs()).find((groupTab) => groupTab.id === tabId);
  if (!tab) {
    throw new ToolError(
      "NOT_IN_GROUP",
      `Tab ${tabId} is not in the "${GROUP_TITLE}" tab group, so it cannot be used. ` +
        "Call tabs_list for the current tab ids.",
    );
  }
  return tab;
}

/** Closes a tab. checkToolCall has already refused tabs outside the group. */
export async function closeTab(tabId: number): Promise<void> {
  await chrome.tabs.remove(tabId);
}

/**
 * Loads a URL (scheme already added and policy-checked by checkToolCall) and waits up to
 * LOAD_TIMEOUT_MS. A same-document navigation never reports `loading`, so none after
 * SAME_DOCUMENT_MS counts as done. Returns the tab and stillLoading.
 */
export async function navigateTab(
  tabId: number,
  target: string,
): Promise<{ tab: chrome.tabs.Tab; stillLoading: boolean }> {
  // Listen before navigating, or a fast load can finish unseen.
  let started = false;
  let finish: (complete: boolean) => void = () => {};
  const finished = new Promise<boolean>((resolve) => (finish = resolve));
  const onUpdated = (id: number, change: { status?: string }) => {
    if (id !== tabId) {
      return;
    }
    if (change.status === "loading") {
      started = true;
    } else if (change.status === "complete" && started) {
      finish(true);
    }
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
  const sameDocument = setTimeout(() => started || finish(true), SAME_DOCUMENT_MS);
  const timeout = setTimeout(() => finish(false), LOAD_TIMEOUT_MS);

  try {
    await startNavigation(tabId, target);
    const complete = await finished;
    return { tab: await chrome.tabs.get(tabId), stillLoading: !complete };
  } finally {
    chrome.tabs.onUpdated.removeListener(onUpdated);
    clearTimeout(sameDocument);
    clearTimeout(timeout);
  }
}

/**
 * Starts loading through CDP, which reports load errors such as an unknown domain. Falls back to
 * chrome.tabs.update when CDP cannot attach (chrome:// pages, or another debugger on the tab).
 */
async function startNavigation(tabId: number, url: string): Promise<void> {
  let errorText: string | undefined;
  try {
    ({ errorText } = await sendCdpCommand(tabId, "Page.navigate", { url }));
  } catch {
    await chrome.tabs.update(tabId, { url });
    return;
  }
  // net::ERR_ABORTED comes from downloads and same-page jumps, which are not failures.
  if (errorText && errorText !== "net::ERR_ABORTED") {
    throw new ToolError("NAVIGATE_FAILED", `Could not load ${url}: ${errorText}.`);
  }
}

/** The group's tabs, creating the group with one blank tab when it has none. */
export async function ensureGroup(): Promise<chrome.tabs.Tab[]> {
  const tabs = await groupTabs();
  return tabs.length > 0 ? tabs : [await createGroup()];
}

/**
 * The tab list returned to the model: titles cut to MAX_TITLE and URLs to MAX_URL characters,
 * tabs without an id skipped.
 */
export async function tabContext(tabs: chrome.tabs.Tab[]): Promise<TabContext> {
  const group = await findGroup();
  return {
    availableTabs: tabs
      .filter((tab) => tab.id !== undefined)
      .map((tab) => ({
        tabId: tab.id!,
        title: (tab.title ?? "").slice(0, MAX_TITLE),
        url: (tab.url ?? tab.pendingUrl ?? "").slice(0, MAX_URL),
      })),
    tabGroupId: group?.id ?? null,
  };
}
