import { test } from "node:test";
import assert from "node:assert/strict";
import { addScheme, checkUrl, parseSites } from "../extension/dist/policy/policy.js";
import type { SitePolicy } from "../extension/dist/policy/policy.js";

const OPEN: SitePolicy = { blockedSites: [], allowedSites: [], allowFileUrls: false };

function blocked(url: string, policy = OPEN): boolean {
  try {
    checkUrl(url, policy);
    return false;
  } catch (error) {
    assert.equal((error as { code?: string }).code, "BLOCKED");
    return true;
  }
}

test("checkUrl: web pages, localhost and about:blank are allowed by default", () => {
  for (const url of ["https://example.com/", "http://localhost:3000/", "about:blank", ""]) {
    assert.equal(blocked(url), false, url);
  }
});

test("checkUrl: non-web schemes are always blocked", () => {
  for (const url of ["javascript:alert(1)", "data:text/html,hi", "chrome://settings", "ftp://x.com"]) {
    assert.equal(blocked(url), true, url);
  }
  // addScheme turns these into invalid URLs, which are blocked too.
  assert.equal(blocked(addScheme("javascript:alert(1)")), true);
});

test("checkUrl: cloud metadata is blocked, including disguised forms", () => {
  for (const url of [
    "http://169.254.169.254/latest/meta-data/",
    "http://2852039166/",
    "http://0xa9fea9fe/",
    "http://[::ffff:169.254.169.254]/",
    "http://metadata.google.internal/",
    "http://[fd00:ec2::254]/",
  ]) {
    assert.equal(blocked(url), true, url);
  }
});

test("checkUrl: file:// follows the setting", () => {
  assert.equal(blocked("file:///C:/notes.txt"), true);
  assert.equal(blocked("file:///C:/notes.txt", { ...OPEN, allowFileUrls: true }), false);
});

test("checkUrl: blocked sites cover subdomains but not look-alikes", () => {
  const policy = { ...OPEN, blockedSites: ["example.com"] };
  assert.equal(blocked("https://example.com/", policy), true);
  assert.equal(blocked("https://www.EXAMPLE.com./", policy), true);
  assert.equal(blocked("https://notexample.com/", policy), false);
});

test("checkUrl: a non-empty allowed list allows only its sites; blocked wins", () => {
  const policy = { ...OPEN, allowedSites: ["example.com"] };
  assert.equal(blocked("https://docs.example.com/", policy), false);
  assert.equal(blocked("https://wikipedia.org/", policy), true);
  assert.equal(
    blocked("https://example.com/", { ...policy, blockedSites: ["example.com"] }),
    true,
  );
});

test("addScheme: https by default, http for local hosts", () => {
  assert.equal(addScheme(" example.com "), "https://example.com");
  assert.equal(addScheme("localhost:3000/x"), "http://localhost:3000/x");
  assert.equal(addScheme("[::1]:8080"), "http://[::1]:8080");
  assert.equal(addScheme("https://a.b"), "https://a.b");
});

test("parseSites: loose entries become host names; non-sites are reported", () => {
  assert.deepEqual(
    parseSites("https://www.Example.com/page\n\n *.bank.com \nlocalhost:3000\nnot a site\nfile:///x"),
    { sites: ["www.example.com", "bank.com", "localhost"], bad: ["not a site", "file:///x"] },
  );
});
