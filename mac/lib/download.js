"use strict";
// 带进度、多源回退、sha256 校验的下载（增量更新和字体共用）。
// fetchImpl 在 Electron 里用 net.fetch（走系统代理），测试里可以换成假的。
const crypto = require("crypto");
const path = require("path");

const DEFAULTS = {
  firstByteTimeoutMs: 12000, // 迟迟连不上 → 换下一个源
  stallTimeoutMs: 20000,     // 中途卡住没数据 → 换下一个源
  slowCheckAfterMs: 8000,    // 下载这么久后检查速度
  minBytesPerSec: 80 * 1024, // 太慢且还有别的源 → 换下一个源（最后一个源不受限制）
};

async function fetchJson(fetchImpl, urls, { timeoutMs = 12000, headers = {} } = {}) {
  let lastErr = null;
  for (const url of urls) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ctl.signal, headers: { Accept: "application/json", ...headers } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      clearTimeout(t);
      return { data: j, url };
    } catch (err) {
      clearTimeout(t);
      lastErr = new Error(`${shortHost(url)}：${err && err.name === "AbortError" ? "超时" : (err && err.message) || err}`);
    }
  }
  throw lastErr || new Error("没有可用的地址");
}

function shortHost(url) {
  try { const u = new URL(url); return u.host + (u.pathname.startsWith("/https:") ? "（镜像）" : ""); } catch { return url; }
}

// 依次尝试 urls，下载到 dest（先写 dest.download，校验通过再改名）。
// onProgress({ received, total, pct, source })
async function downloadFile(fetchImpl, fsImpl, urls, dest, { sha256, size, onProgress, opts } = {}) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  const tmp = dest + ".download";
  fsImpl.mkdirSync(path.dirname(dest), { recursive: true });
  const errors = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const isLast = i === urls.length - 1;
    const ctl = new AbortController();
    let timer = null;
    let reason = "";
    const arm = (ms, why) => { clearTimeout(timer); timer = setTimeout(() => { reason = why; ctl.abort(); }, ms); };
    let fd = null;
    try {
      arm(o.firstByteTimeoutMs, "连接超时");
      const res = await fetchImpl(url, { signal: ctl.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get("content-length")) || size || 0;
      const hash = crypto.createHash("sha256");
      fd = fsImpl.openSync(tmp, "w");
      let received = 0;
      const started = Date.now();
      let lastEmit = 0;
      const reader = res.body.getReader();
      arm(o.stallTimeoutMs, "下载卡住");
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        fsImpl.writeSync(fd, chunk);
        hash.update(chunk);
        received += chunk.length;
        arm(o.stallTimeoutMs, "下载卡住");
        const elapsed = Date.now() - started;
        if (!isLast && elapsed > o.slowCheckAfterMs && received / (elapsed / 1000) < o.minBytesPerSec && (!total || received < total * 0.7)) {
          reason = "速度太慢";
          ctl.abort();
          try { await reader.cancel(); } catch { /* ignore */ }
          throw new Error(reason);
        }
        if (onProgress && (Date.now() - lastEmit > 200)) {
          lastEmit = Date.now();
          onProgress({ received, total, pct: total ? Math.min(99, Math.floor((received / total) * 100)) : 0, source: shortHost(url) });
        }
      }
      clearTimeout(timer);
      fsImpl.closeSync(fd); fd = null;
      if (size && received !== size) throw new Error(`大小不符（${received}/${size}）`);
      const got = hash.digest("hex");
      if (sha256 && got.toLowerCase() !== String(sha256).toLowerCase()) throw new Error("sha256 校验失败");
      fsImpl.renameSync(tmp, dest);
      if (onProgress) onProgress({ received, total: received, pct: 100, source: shortHost(url) });
      return { ok: true, url, size: received, sha256: got };
    } catch (err) {
      clearTimeout(timer);
      if (fd !== null) { try { fsImpl.closeSync(fd); } catch { /* ignore */ } }
      try { fsImpl.unlinkSync(tmp); } catch { /* ignore */ }
      const msg = reason || (err && err.name === "AbortError" ? "超时" : (err && err.message) || String(err));
      errors.push(`${shortHost(url)}：${msg}`);
    }
  }
  return { ok: false, error: errors.join("；") || "下载失败" };
}

module.exports = { fetchJson, downloadFile, shortHost, DEFAULTS };
