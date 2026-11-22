// Site policy: which URLs the agent may use. Kept free of chrome.* so node --test can load it.
//
//   checkUrl    throws BLOCKED for a URL the policy refuses
//   addScheme   turns `example.com` into `https://example.com`
//   parseSites  turns the popup's site lists (one per line) into host names

import { ToolError } from "../shared/errors.js";
import type { Settings } from "../shared/settings.js";

/**
 * The only schemes the agent may load, apart from `file:` (a popup setting) and about:blank.
 * Every other scheme is always blocked. Uncomment a line to allow it.
 */
const ALLOWED_SCHEMES = [
  "http:",
  "https:",
  // "data:",        // page content the agent writes itself
  // "javascript:",  // runs script in the open page
  // "chrome:",      // browser settings and internal pages
];

/** Hosts that are always blocked, subdomains not included. Comment out a line to allow it. */
const ALWAYS_BLOCKED_HOSTS = [
  // Cloud metadata: on a cloud server it hands out the server's credentials.
  "169.254.169.254", // AWS, Azure, Google Cloud and others
  "[::ffff:a9fe:a9fe]", // the same address written as IPv6
  "metadata.google.internal", // Google Cloud, by name
  "[fd00:ec2::254]", // AWS, over IPv6
];

export type SitePolicy = Pick<Settings, "blockedSites" | "allowedSites" | "allowFileUrls">;

/**
 * Throws BLOCKED unless the policy allows the URL. Empty and about:blank are always allowed.
 * Hosts are compared after URL parsing, so `http://2852039166/` counts as 169.254.169.254.
 */
export function checkUrl(url: string, policy: SitePolicy): void {
  if (url === "" || url === "about:blank") {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // `javascript:alert(1)` lands here once addScheme made it `https://javascript:alert(1)`.
    return block(url, "not a valid URL");
  }
  if (parsed.protocol === "file:") {
    if (!policy.allowFileUrls) {
      block(url, "file:// URLs are turned off");
    }
    return;
  }
  if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
    return block(url, `${parsed.protocol} URLs are not allowed`);
  }
  const host = hostOf(parsed);
  if (ALWAYS_BLOCKED_HOSTS.includes(host)) {
    return block(url, "an always-blocked address");
  }
  // Blocked wins over allowed.
  if (policy.blockedSites.some((site) => covers(site, host))) {
    return block(url, "on the blocked sites list");
  }
  if (policy.allowedSites.length > 0 && !policy.allowedSites.some((site) => covers(site, host))) {
    return block(url, "not on the allowed sites list");
  }
}

/** Adds `https://` to a URL without a scheme (`http://` for local hosts): `example.com` works. */
export function addScheme(url: string): string {
  const text = url.trim();
  if (text.includes("://") || text === "about:blank") {
    return text;
  }
  // localhost, 127.x.x.x or [::1], alone or before a port or path: "localhost:3000/x".
  const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])($|[:/?#])/i.test(text);
  return (local ? "http://" : "https://") + text;
}

/**
 * The host names in a site list, one entry per line. Loose input is accepted:
 * `https://www.Example.com/page` and `*.example.com` give `www.example.com` and `example.com`.
 * `bad` lists the entries with no host, so the popup can refuse them instead of dropping them.
 */
export function parseSites(text: string): { sites: string[]; bad: string[] } {
  const sites: string[] = [];
  const bad: string[] = [];
  for (const entry of text.split("\n").map((line) => line.trim()).filter(Boolean)) {
    let host = "";
    try {
      host = hostOf(new URL(addScheme(entry.replace(/^\*\./, ""))));
    } catch {
      // Not a URL; reported as bad below.
    }
    if (host) {
      sites.push(host);
    } else {
      bad.push(entry);
    }
  }
  return { sites, bad };
}

/** Lower-case host without a trailing dot; IPv6 keeps its brackets. */
function hostOf(url: URL): string {
  return url.hostname.replace(/\.$/, "");
}

/** A site entry covers its own host and every subdomain: `example.com` covers `www.example.com`. */
function covers(site: string, host: string): boolean {
  return host === site || host.endsWith(`.${site}`);
}

function block(url: string, reason: string): never {
  throw new ToolError(
    "BLOCKED",
    `"${url}" is blocked by the browser's site policy: ${reason}. ` +
      "Report it to the user; do not work around it.",
  );
}
