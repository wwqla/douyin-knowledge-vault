"use strict";
// 应用内增量更新：只下载应用层（app-update.asar，几 MB），不重新下载 Electron 内核。
const path = require("path");
const core = require("./update-core");
const dl = require("./download");

const REPO = "wwqla/douyin-knowledge-vault";
// 默认先直连 GitHub，太慢/连不上自动换镜像。可在 settings.json 的 updateMirrors 里改（"" 表示直连）
const DEFAULT_MIRRORS = ["", "https://ghfast.top/"];
// 固定通道：每次发版都会把 app-update.json 覆盖上传到这个 release，镜像友好，作为 GitHub API 的后备
const CHANNEL_TAG = "mac-latest";

function createUpdater({ fetchImpl, fsImpl, boot, getMirrors, repo = REPO }) {
  const updatesDir = boot.updatesDir;
  const mirrors = () => {
    const m = getMirrors && getMirrors();
    return Array.isArray(m) && m.length ? m : DEFAULT_MIRRORS;
  };
  let busy = null;
  let downloaded = null; // 本次运行下载好的版本，等重启

  function info() {
    return {
      version: boot.version,
      source: boot.source, // bundled | update
      bundledVersion: boot.bundledVersion,
      electron: boot.electron,
      electronMajor: core.electronMajor(boot.electron),
      bootProtocol: boot.protocol || 1,
      rejected: boot.rejected || [],
      downloaded,
      repo,
    };
  }

  async function fetchManifest() {
    const errs = [];
    // ① GitHub API：列出 releases，挑最新的 mac-v* 版本
    try {
      const { data } = await dl.fetchJson(fetchImpl, [`https://api.github.com/repos/${repo}/releases?per_page=30`], { headers: { Accept: "application/vnd.github+json" } });
      const best = core.pickMacRelease(data);
      if (best) {
        const { data: m } = await dl.fetchJson(fetchImpl, core.mirrorUrls(best.manifestUrl, mirrors()));
        return { manifest: m, releaseUrl: best.release.html_url };
      }
      errs.push("GitHub 上还没有带增量包的 Mac 版本");
    } catch (err) { errs.push("GitHub API " + err.message); }
    // ② 固定通道（可走镜像）
    try {
      const url = `https://github.com/${repo}/releases/download/${CHANNEL_TAG}/app-update.json`;
      const { data: m } = await dl.fetchJson(fetchImpl, core.mirrorUrls(url, mirrors()));
      return { manifest: m, releaseUrl: m.releaseUrl || `https://github.com/${repo}/releases/tag/mac-v${m.version}` };
    } catch (err) { errs.push("更新通道 " + err.message); }
    throw new Error(errs.join("；"));
  }

  async function check() {
    try {
      const { manifest: m, releaseUrl } = await fetchManifest();
      const err = core.validateManifest(m, { requireUrl: true });
      if (err) return { ok: false, error: "更新清单无效：" + err };
      const newer = core.compareVersions(m.version, boot.version) > 0;
      const full = newer ? core.needsFullInstall(m, { electron: boot.electron, bootProtocol: boot.protocol || 1 }) : "";
      const state = core.readState(fsImpl, updatesDir);
      return {
        ok: true,
        current: boot.version,
        latest: m.version,
        available: newer,
        needsFull: !!full,
        fullReason: full,
        badBefore: state.bad[m.version] || "",
        alreadyDownloaded: downloaded === m.version,
        size: m.size,
        notes: m.notes || "",
        releaseUrl: releaseUrl || m.releaseUrl || "",
        dmgUrl: m.dmgUrl || releaseUrl || "",
        manifest: m,
      };
    } catch (err) {
      return { ok: false, error: "检查更新失败：" + (err.message || err) };
    }
  }

  async function download(manifest, onProgress) {
    if (busy) return busy;
    busy = (async () => {
      const m = manifest;
      const err = core.validateManifest(m, { requireUrl: true });
      if (err) return { ok: false, error: "更新清单无效：" + err };
      if (core.needsFullInstall(m, { electron: boot.electron, bootProtocol: boot.protocol || 1 })) return { ok: false, error: "这个版本需要下载完整安装包" };
      const file = `app-${m.version}.asar`;
      const dest = path.join(updatesDir, file);
      const r = await dl.downloadFile(fetchImpl, fsImpl, core.mirrorUrls(m.asarUrl, mirrors()), dest, { sha256: m.sha256, size: m.size, onProgress });
      if (!r.ok) return { ok: false, error: "下载失败：" + r.error };
      const local = { version: m.version, electron: m.electron, bootstrap: m.bootstrap || 1, sha256: m.sha256, size: m.size, file, notes: m.notes || "", downloadedAt: new Date().toISOString() };
      const mf = path.join(updatesDir, `app-${m.version}.json`);
      fsImpl.writeFileSync(mf + ".tmp", JSON.stringify(local, null, 2));
      fsImpl.renameSync(mf + ".tmp", mf);
      // 用户主动重新下载：清掉这个版本以前的失败记录
      const state = core.readState(fsImpl, updatesDir);
      if (state.bad[m.version] || state.boots[m.version]) { delete state.bad[m.version]; delete state.boots[m.version]; core.writeState(fsImpl, updatesDir, state); }
      // 只保留正在用的版本和新版本
      try {
        const keep = [m.version, boot.source === "update" ? boot.version : ""];
        for (const n of core.filesToPrune(fsImpl.readdirSync(updatesDir), keep)) { try { fsImpl.unlinkSync(path.join(updatesDir, n)); } catch { /* ignore */ } }
      } catch { /* ignore */ }
      downloaded = m.version;
      return { ok: true, version: m.version, source: r.url };
    })();
    try { return await busy; } finally { busy = null; }
  }

  return { info, check, download, get downloading() { return !!busy; } };
}

module.exports = { createUpdater, REPO, DEFAULT_MIRRORS, CHANNEL_TAG };
