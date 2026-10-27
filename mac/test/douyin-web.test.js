"use strict";
// 抖音网页窗口：UA / Client Hints、自定义协议拦截（bitbrowser:// 不交给 macOS）、登录页脚本
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("vm");
const dweb = require("../lib/douyin-web");

test("UA matches the bundled Chromium major version and has no Electron token", () => {
  const ua = dweb.chromeUA("130.0.6723.191");
  assert.match(ua, /Macintosh; Intel Mac OS X 10_15_7/);
  assert.match(ua, /Chrome\/130\.0\.0\.0 Safari\/537\.36$/);
  assert.doesNotMatch(ua, /Electron/i);
  assert.equal(dweb.secChUa("130.0.6723.191"), '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"');
});

test("request headers: client hints rewritten, Electron stripped, others kept", () => {
  const h = dweb.fixRequestHeaders({
    "User-Agent": "Mozilla/5.0 ... Chrome/130.0.6723.191 Electron/33.2.1 Safari/537.36",
    "sec-ch-ua": '"Chromium";v="130", "Electron";v="33", "Not?A_Brand";v="99"',
    "sec-ch-ua-platform": '"Windows"',
    "sec-ch-ua-full-version-list": '"Electron";v="33.2.1"',
    "X-Custom": "foo Electron/33.2.1",
    Cookie: "a=b",
  }, "130.0.6723.191");
  assert.equal(h["User-Agent"], dweb.chromeUA("130.0.6723.191"));
  assert.doesNotMatch(JSON.stringify(h), /Electron/i);
  assert.equal(h["sec-ch-ua-platform"], '"macOS"');
  assert.match(h["sec-ch-ua-full-version-list"], /Google Chrome";v="130\.0\.6723\.191"/);
  assert.equal(h.Cookie, "a=b");
});

test("custom URL schemes are never handed to macOS", () => {
  for (const u of ["bitbrowser://cc/", "snssdk1128://aweme", "weixin://", "adspower://x", "BitBrowser://CC"]) {
    assert.equal(dweb.isExternalScheme(u), true, u);
    assert.equal(dweb.isWebUrl(u), false, u);
    assert.equal(dweb.windowOpenDecision(u, { allowPopups: true }), "deny", u);
  }
  for (const u of ["https://www.douyin.com/", "http://x.douyin.com/a", "about:blank", "data:text/html,hi", "blob:https://www.douyin.com/1"]) {
    assert.equal(dweb.isExternalScheme(u), false, u);
  }
  assert.equal(dweb.windowOpenDecision("https://sso.douyin.com/", { allowPopups: true }), "allow");
  assert.equal(dweb.windowOpenDecision("https://sso.douyin.com/", { allowPopups: false }), "deny");
  assert.equal(dweb.permissionDecision("openExternal", { externalURL: "bitbrowser://cc/" }), false);
  assert.equal(dweb.permissionDecision("openExternal", { externalURL: "https://x" }), false);
  assert.equal(dweb.permissionDecision("notifications", {}), false);
  assert.equal(dweb.permissionDecision("clipboard-sanitized-write", {}), true);
});

test("main.js never calls shell.openExternal on an unchecked / non-http URL from Douyin windows", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "main.js"), "utf8");
  const calls = src.split("\n").filter((l) => /shell\.openExternal\(/.test(l));
  for (const l of calls) {
    assert.ok(/isWebUrl\(url\)|https:\\\/\\\/github|obsidian:\/\//.test(l), "unguarded openExternal: " + l.trim());
  }
  assert.match(src, /setPermissionRequestHandler/);
  assert.match(src, /setPermissionCheckHandler/);
  assert.match(src, /web-contents-created/);
  assert.match(src, /will-frame-navigate/);
});

test("blank detection and in-page scripts compile", () => {
  assert.equal(dweb.looksBlank({ textLen: 0 }), true);
  assert.equal(dweb.looksBlank({ textLen: 3, hasQr: true }), false);
  assert.equal(dweb.looksBlank({ textLen: 500 }), false);
  assert.equal(dweb.looksBlank(null), true);
  for (const code of [dweb.PROBE_SCRIPT, dweb.AUTO_LOGIN_SCRIPT, dweb.blankBannerScript("https://www.douyin.com/jingxuan")]) {
    assert.doesNotThrow(() => new vm.Script(code));
  }
  const html = dweb.failPageHtml("<x>", dweb.LOGIN_HOME_URL, dweb.LOGIN_ALT_URLS[0]);
  assert.match(html, /&lt;x&gt;/);
  assert.match(html, /jingxuan/);
});
