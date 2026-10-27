"use strict";
// 抖音网页窗口的纯逻辑（不依赖 Electron，便于单元测试）：
// - 与 Electron 真实 Chromium 版本一致的 macOS Chrome UA / Client Hints（不带 Electron 字样）
// - 拦截自定义 URL 协议（抖音会探测 bitbrowser:// 等指纹浏览器协议，交给系统就会弹出访达对话框）
// - 登录页地址、空白页检测与页面内脚本

const LOGIN_HOME_URL = "https://www.douyin.com/";
// 首页打不开/一直空白时的备选登录入口（都会弹出扫码登录框）
const LOGIN_ALT_URLS = ["https://www.douyin.com/jingxuan", "https://www.douyin.com/discover"];

function chromeMajor(chromeVersion) {
  const m = /^(\d+)/.exec(String(chromeVersion || ""));
  return m ? m[1] : "130";
}

/** macOS Chrome 的 UA（Chrome 的 UA 精简规则：只保留主版本号） */
function chromeUA(chromeVersion) {
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor(chromeVersion)}.0.0.0 Safari/537.36`;
}

function secChUa(chromeVersion) {
  const v = chromeMajor(chromeVersion);
  return `"Chromium";v="${v}", "Google Chrome";v="${v}", "Not?A_Brand";v="99"`;
}

/** 改写请求头：UA 与 sec-ch-ua* 跟真实 Chrome 一致，去掉任何 Electron 字样。返回新对象。 */
function fixRequestHeaders(headers, chromeVersion) {
  const out = {};
  const ver = String(chromeVersion || "");
  for (const [k, v] of Object.entries(headers || {})) {
    const lk = k.toLowerCase();
    if (lk === "user-agent") out[k] = chromeUA(ver);
    else if (lk === "sec-ch-ua") out[k] = secChUa(ver);
    else if (lk === "sec-ch-ua-full-version-list") {
      const full = /^\d+\.\d+\.\d+\.\d+$/.test(ver) ? ver : chromeMajor(ver) + ".0.0.0";
      out[k] = `"Chromium";v="${full}", "Google Chrome";v="${full}", "Not?A_Brand";v="99.0.0.0"`;
    } else if (lk === "sec-ch-ua-platform") out[k] = '"macOS"';
    else if (lk === "sec-ch-ua-mobile") out[k] = "?0";
    else if (typeof v === "string" && /electron/i.test(v)) out[k] = v.replace(/\s*Electron\/[\d.]+/gi, "").replace(/"Electron";v="[\d.]+",?\s*/gi, "");
    else out[k] = v;
  }
  return out;
}

const WEB_SCHEMES = new Set(["http:", "https:"]);
// 页面内部可以正常使用、不会交给系统的协议
const INTERNAL_SCHEMES = new Set(["http:", "https:", "about:", "data:", "blob:", "javascript:", "chrome-error:"]);

function protocolOf(url) {
  try { return new URL(String(url)).protocol.toLowerCase(); } catch { return ""; }
}
function isWebUrl(url) { return WEB_SCHEMES.has(protocolOf(url)); }
/** 导航到这个地址会不会被交给 macOS（bitbrowser:// 、snssdk:// 、weixin:// …） */
function isExternalScheme(url) {
  const p = protocolOf(url);
  return !!p && !INTERNAL_SCHEMES.has(p);
}

/** 抖音会话的权限决定：自定义协议一律不交给系统；也不弹通知/摄像头/定位 */
const DENIED_PERMISSIONS = new Set(["openExternal", "notifications", "media", "geolocation", "midi", "midiSysex", "hid", "serial", "usb", "bluetooth"]);
function permissionDecision(permission, details) {
  if (permission === "openExternal") return false; // 任何协议都不从抖音页面打开外部应用（尤其是非 http(s)）
  if (DENIED_PERMISSIONS.has(permission)) return false;
  void details;
  return true;
}

/** 弹出窗口：自定义协议拒绝；登录窗口里的 http(s) 弹窗在同一会话的子窗口打开；采集窗口不允许弹窗 */
function windowOpenDecision(url, { allowPopups }) {
  if (!isWebUrl(url)) return "deny";
  return allowPopups ? "allow" : "deny";
}

/** 页面内检测：正文长度、是否有二维码/登录按钮 */
const PROBE_SCRIPT = `(() => {
  const b = document.body;
  const text = b ? (b.innerText || "").trim() : "";
  const qr = document.querySelector('[class*="qrcode" i] img, [class*="qrcode" i] canvas, img[src*="qrcode" i], [id*="login" i] canvas, [class*="login" i] canvas, [class*="login" i] img[src^="data:image"]');
  const loginBtn = Array.from(document.querySelectorAll('button, a, div, span, p')).some((el) => el.childElementCount === 0 && /^\\s*(登录|扫码登录|登录抖音)\\s*$/.test(el.textContent || ""));
  return { url: location.href, title: document.title, textLen: text.length, hasQr: !!qr, hasLogin: loginBtn || /扫码登录|登录后/.test(text), elements: document.getElementsByTagName("*").length };
})()`;

/** 首页没弹出扫码框时，点一下「登录」按钮 */
const AUTO_LOGIN_SCRIPT = `(() => {
  if (document.querySelector('[class*="qrcode" i] img, [class*="qrcode" i] canvas, img[src*="qrcode" i]')) return "qr";
  const cands = Array.from(document.querySelectorAll('button, a, div, span, p')).filter((el) => el.childElementCount <= 1 && /^\\s*登录\\s*$/.test(el.textContent || ""));
  const el = cands.find((x) => x.offsetParent !== null) || cands[0];
  if (el) { el.click(); return "clicked"; }
  return "none";
})()`;

function looksBlank(info) {
  if (!info) return true;
  return (Number(info.textLen) || 0) < 20 && !info.hasQr && !info.hasLogin;
}

/** 页面一直空白时，在登录窗口顶部插入提示条：重新加载 / 换一个登录页面 */
function blankBannerScript(altUrl) {
  const alt = JSON.stringify(String(altUrl || LOGIN_ALT_URLS[0]));
  return `(() => {
    if (document.getElementById("__dkv_banner")) return true;
    const host = document.body || document.documentElement;
    const d = document.createElement("div");
    d.id = "__dkv_banner";
    d.style.cssText = "position:fixed;z-index:2147483647;left:0;right:0;top:0;padding:14px 18px;background:#1e293b;color:#f8fafc;font:14px -apple-system,PingFang SC,sans-serif;display:flex;gap:12px;align-items:center;box-shadow:0 2px 12px rgba(0,0,0,.4)";
    d.innerHTML = '<span style="flex:1">抖音页面加载不出来？可以重新加载，或换一个登录页面（扫码登录框会自动弹出）。</span>';
    const mk = (t, fn) => { const b = document.createElement("button"); b.textContent = t; b.style.cssText = "padding:6px 14px;border-radius:8px;border:0;background:#38bdf8;color:#0f172a;font-weight:600;cursor:pointer"; b.onclick = fn; d.appendChild(b); };
    mk("重新加载", () => location.reload());
    mk("换一个登录页面", () => { location.href = ${alt}; });
    host.appendChild(d);
    return true;
  })()`;
}

/** 主框架彻底打不开时显示的本地页面 */
function failPageHtml(errorText, retryUrl, altUrl) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return `<!doctype html><meta charset="utf-8"><title>抖音登录</title>
<body style="margin:0;background:#0f172a;color:#f8fafc;font:15px -apple-system,PingFang SC,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">
<div style="max-width:520px;text-align:center;line-height:1.8">
<h2 style="color:#f8fafc">抖音页面没有打开</h2>
<p style="color:#cbd5e1">${esc(errorText || "网络错误")}</p>
<p><a style="color:#38bdf8" href="${esc(retryUrl)}">重新加载</a> · <a style="color:#38bdf8" href="${esc(altUrl)}">换一个登录页面</a></p>
<p style="color:#94a3b8;font-size:13px">请检查网络或代理设置；登录成功后窗口会自动关闭。</p></div></body>`;
}

module.exports = {
  LOGIN_HOME_URL, LOGIN_ALT_URLS, chromeMajor, chromeUA, secChUa, fixRequestHeaders,
  protocolOf, isWebUrl, isExternalScheme, permissionDecision, windowOpenDecision,
  PROBE_SCRIPT, AUTO_LOGIN_SCRIPT, looksBlank, blankBannerScript, failPageHtml,
};
