"use strict";
// 增量更新的纯逻辑（不依赖 Electron，便于 node --test）。
// 启动器（boot/bootstrap.js，永远来自安装包内置的 app.asar）和应用层里的更新器共用这一份代码。
//
// 目录约定：<数据目录>/updates/
//   app-<version>.asar   应用层（完整的 app.asar，含 main.js / preload.js / renderer / lib / assets / engine）
//   app-<version>.json   该层的清单：{ version, electron, bootstrap, sha256, size, file }
//   state.json           启动记录：{ bad: { "<ver>": "原因" }, boots: { "<ver>": { attempts, good } } }

const path = require("path");
const crypto = require("crypto");

// 启动器协议版本：应用层清单里的 bootstrap 字段大于它时，说明新应用层需要新的启动器 → 只能装完整安装包
const BOOT_PROTOCOL = 1;
// 连续启动失败（没走到“窗口加载完成 / 正常退出”）达到这个次数就判定该版本坏掉
const MAX_BOOT_ATTEMPTS = 2;

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || "").trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || "" };
}

// 语义化版本比较：a>b 返回 1，相等 0，a<b -1；无法解析的版本视为最小
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x && !y) return 0;
  if (!x) return -1;
  if (!y) return 1;
  for (const k of ["major", "minor", "patch"]) if (x[k] !== y[k]) return x[k] > y[k] ? 1 : -1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1; // 正式版 > 预发布
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

function electronMajor(v) {
  const m = /^v?(\d+)/.exec(String(v == null ? "" : v));
  return m ? Number(m[1]) : NaN;
}

// 校验发布清单（app-update.json）的字段是否齐全、格式正确。返回错误说明，合法时返回 ""
function validateManifest(m, { requireUrl = false } = {}) {
  if (!m || typeof m !== "object") return "清单不是对象";
  if (!parseVersion(m.version)) return "版本号格式不对";
  if (!Number.isFinite(electronMajor(m.electron))) return "缺少内核版本";
  if (!/^[0-9a-f]{64}$/i.test(String(m.sha256 || ""))) return "sha256 格式不对";
  if (!(Number.isInteger(m.size) && m.size > 0)) return "size 不对";
  if (m.bootstrap != null && !Number.isInteger(m.bootstrap)) return "bootstrap 字段不对";
  if (requireUrl && !/^https:\/\//.test(String(m.asarUrl || ""))) return "缺少下载地址";
  return "";
}

// 判断一个清单能不能做增量更新：内核大版本不一致 / 需要新启动器 → 只能下载完整安装包
function needsFullInstall(m, { electron, bootProtocol = BOOT_PROTOCOL }) {
  if (electronMajor(m.electron) !== electronMajor(electron)) return "内核版本变化（Electron " + electronMajor(m.electron) + "）";
  if ((m.bootstrap || 1) > bootProtocol) return "启动器需要升级";
  return "";
}

function sha256File(fsImpl, file) {
  const h = crypto.createHash("sha256");
  const fd = fsImpl.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fsImpl.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fsImpl.closeSync(fd); }
  return h.digest("hex");
}

function emptyState() { return { bad: {}, boots: {} }; }

function readState(fsImpl, updatesDir) {
  try {
    const s = JSON.parse(fsImpl.readFileSync(path.join(updatesDir, "state.json"), "utf8"));
    return { bad: s.bad && typeof s.bad === "object" ? s.bad : {}, boots: s.boots && typeof s.boots === "object" ? s.boots : {} };
  } catch { return emptyState(); }
}

function writeState(fsImpl, updatesDir, state) {
  try {
    fsImpl.mkdirSync(updatesDir, { recursive: true });
    const file = path.join(updatesDir, "state.json");
    const tmp = file + ".tmp";
    fsImpl.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fsImpl.renameSync(tmp, file);
  } catch { /* 写不了状态也不能影响启动 */ }
}

function markBad(state, version, reason) {
  state.bad[version] = String(reason || "启动失败").slice(0, 300);
  delete state.boots[version];
  return state;
}

// 启动时挑选应用层。不修改磁盘，返回 { layer, rejected, state, changed }。
//   layer: { version, asarPath, manifest } 或 null（使用安装包内置的应用层）
//   fsImpl 在 Electron 里必须是 original-fs（把 .asar 当普通文件读），测试里用 fs
function selectLayer({ fsImpl, updatesDir, bundledVersion, electron, state, verifyHash = true, bootProtocol = BOOT_PROTOCOL }) {
  state = state || readState(fsImpl, updatesDir);
  const rejected = [];
  let changed = false;
  let names = [];
  try { names = fsImpl.readdirSync(updatesDir); } catch { return { layer: null, rejected, state, changed }; }
  const manifests = [];
  for (const n of names) {
    if (!/^app-.+\.json$/.test(n)) continue;
    try {
      const m = JSON.parse(fsImpl.readFileSync(path.join(updatesDir, n), "utf8"));
      manifests.push(m);
    } catch { rejected.push({ version: n, reason: "清单损坏" }); }
  }
  manifests.sort((a, b) => compareVersions(b.version, a.version));
  for (const m of manifests) {
    const v = String(m.version || "");
    const err = validateManifest(m);
    if (err) { rejected.push({ version: v, reason: err }); continue; }
    if (compareVersions(v, bundledVersion) <= 0) { rejected.push({ version: v, reason: "不比内置版本新" }); continue; }
    if (state.bad[v]) { rejected.push({ version: v, reason: "已标记为坏版本：" + state.bad[v] }); continue; }
    const full = needsFullInstall(m, { electron, bootProtocol });
    if (full) { rejected.push({ version: v, reason: full }); continue; }
    const asarPath = path.join(updatesDir, path.basename(String(m.file || `app-${v}.asar`)));
    let size = -1;
    try { size = fsImpl.statSync(asarPath).size; } catch { /* 缺文件 */ }
    if (size !== m.size) { rejected.push({ version: v, reason: size < 0 ? "文件缺失" : "文件大小不符" }); markBad(state, v, "文件大小不符"); changed = true; continue; }
    if (verifyHash) {
      let h = "";
      try { h = sha256File(fsImpl, asarPath); } catch { /* 读不了 */ }
      if (h.toLowerCase() !== String(m.sha256).toLowerCase()) { rejected.push({ version: v, reason: "sha256 校验失败" }); markBad(state, v, "sha256 校验失败"); changed = true; continue; }
    }
    const boot = state.boots[v] || { attempts: 0, good: false };
    if (!boot.good && boot.attempts >= MAX_BOOT_ATTEMPTS) {
      rejected.push({ version: v, reason: `连续 ${boot.attempts} 次启动失败` });
      markBad(state, v, `连续 ${boot.attempts} 次启动失败`);
      changed = true;
      continue;
    }
    return { layer: { version: v, asarPath, manifest: m }, rejected, state, changed };
  }
  return { layer: null, rejected, state, changed };
}

// 记一次启动尝试（加载应用层之前调用）
function beginBoot(state, version) {
  const b = state.boots[version] || { attempts: 0, good: false };
  if (!b.good) b.attempts += 1;
  state.boots[version] = b;
  return state;
}
// 第二个实例立即退出：这次不算启动失败
function cancelBoot(state, version) {
  const b = state.boots[version];
  if (b && !b.good && b.attempts > 0) b.attempts -= 1;
  return state;
}
// 窗口加载完成 / 正常退出：这个版本可以正常启动
function markGood(state, version) {
  state.boots[version] = { attempts: 0, good: true };
  delete state.bad[version];
  return state;
}

// 从 GitHub releases 列表里挑最新的 Mac 版本（tag 形如 mac-v1.2.3，带 app-update.json 资产）
function pickMacRelease(releases, { tagPrefix = "mac-v" } = {}) {
  let best = null;
  for (const r of Array.isArray(releases) ? releases : []) {
    if (!r || r.draft || typeof r.tag_name !== "string" || !r.tag_name.startsWith(tagPrefix)) continue;
    const v = r.tag_name.slice(tagPrefix.length);
    if (!parseVersion(v)) continue;
    const asset = (r.assets || []).find((a) => a && a.name === "app-update.json");
    if (!asset) continue;
    if (!best || compareVersions(v, best.version) > 0) best = { version: v, release: r, manifestUrl: asset.browser_download_url };
  }
  return best;
}

// 给 github.com 下载地址加镜像前缀；"" 表示直连。只对 github.com / raw.githubusercontent.com 生效
function mirrorUrls(url, mirrors) {
  const out = [];
  const list = Array.isArray(mirrors) && mirrors.length ? mirrors : [""];
  const isGithub = /^https:\/\/(github\.com|raw\.githubusercontent\.com|objects\.githubusercontent\.com)\//.test(url);
  for (const m of list) {
    const p = String(m || "").trim();
    const u = !p ? url : (isGithub ? p.replace(/\/?$/, "/") + url : null);
    if (u && !out.includes(u)) out.push(u);
  }
  if (!out.length) out.push(url);
  return out;
}

// 下载完成后该保留哪些文件：当前正在用的版本 + 新版本，其余旧版本清理掉
function filesToPrune(names, keepVersions) {
  const keep = new Set(keepVersions.filter(Boolean).map(String));
  return names.filter((n) => {
    const m = /^app-(.+)\.(asar|json)(\.download)?$/.exec(n);
    return m && !keep.has(m[1]);
  });
}

module.exports = {
  BOOT_PROTOCOL, MAX_BOOT_ATTEMPTS,
  parseVersion, compareVersions, electronMajor, validateManifest, needsFullInstall,
  sha256File, emptyState, readState, writeState, markBad,
  selectLayer, beginBoot, cancelBoot, markGood,
  pickMacRelease, mirrorUrls, filesToPrune,
};
