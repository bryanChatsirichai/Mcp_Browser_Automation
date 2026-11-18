// The agent works only in one tab group, so it stays visibly apart from the user's tabs. Where
// the group is created follows the tabWindow setting; new windows are never focused.

import { ToolError } from './errors.js';
import { loadSettings } from './settings.js';
import type { TabWindow } from './settings.js';

const GROUP_TITLE = 'MCP Browser';
const GROUP_COLOR = 'orange';
const MAX_TITLE = 100;
const MAX_URL = 200;

export interface TabContext {
  availableTabs: Array<{ tabId: number; title: string; url: string }>;
  tabGroupId: number | null;
}

/**
 * The group id is cached in session storage, but it changes when the browser restarts while
 * the group itself can survive, so fall back to finding the group by its title.
 */
async function findGroup(): Promise<chrome.tabGroups.TabGroup | undefined> {
  const { groupId } = await chrome.storage.session.get<{ groupId?: number }>('groupId');
  if (typeof groupId === 'number') {
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
async function mainWindow(): Promise<chrome.windows.Window | undefined> {
  try {
    const last = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (!last.incognito) return last;
  } catch {
    // No window has had focus yet; fall through to any open window.
  }
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  return windows.find((window) => !window.incognito);
}

/** The first tab of a new unfocused window. */
async function newWindowTab(incognito: boolean): Promise<chrome.tabs.Tab | undefined> {
  const window = await chrome.windows.create({ focused: false, incognito, url: 'about:blank' });
  return window?.tabs?.[0];
}

async function firstTab(placement: TabWindow): Promise<chrome.tabs.Tab | undefined> {
  if (placement === 'incognito') {
    if (!(await chrome.extension.isAllowedIncognitoAccess())) {
      throw new ToolError(
        'INCOGNITO_NOT_ALLOWED',
        'The extension is set to open agent tabs in an incognito window, but it is not allowed in incognito. ' +
          'Ask the user to enable "Allow in Incognito" for the extension (chrome://extensions > Details), ' +
          'or to choose another window in the extension popup.',
      );
    }
    return newWindowTab(true);
  }
  if (placement === 'current') {
    const window = await mainWindow();
    // Inactive, so the user's own tab stays in front.
    if (window?.id !== undefined) return chrome.tabs.create({ windowId: window.id, url: 'about:blank', active: false });
  }
  return newWindowTab(false);
}

/** One blank tab, grouped and titled, placed as the tabWindow setting says. Returns that tab. */
async function createGroup(): Promise<chrome.tabs.Tab> {
  const tab = await firstTab((await loadSettings()).tabWindow);
  if (tab?.id === undefined) throw new Error('The browser did not create a tab for the tab group.');

  const groupId = await chrome.tabs.group({ tabIds: tab.id, createProperties: { windowId: tab.windowId } });
  await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: GROUP_COLOR });
  await chrome.storage.session.set({ groupId });
  return tab;
}

/** Opens a blank tab in the group, creating the group first if there is none. */
export async function openTab(): Promise<chrome.tabs.Tab> {
  const group = await findGroup();
  if (!group) return createGroup();
  // Inactive, so the group's window is not brought to the front.
  const tab = await chrome.tabs.create({ windowId: group.windowId, url: 'about:blank', active: false });
  if (tab.id === undefined) throw new Error('The browser did not return an id for the new tab.');
  await chrome.tabs.group({ groupId: group.id, tabIds: tab.id });
  return tab;
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
        title: (tab.title ?? '').slice(0, MAX_TITLE),
        url: (tab.url ?? tab.pendingUrl ?? '').slice(0, MAX_URL),
      })),
    tabGroupId: group?.id ?? null,
  };
}
