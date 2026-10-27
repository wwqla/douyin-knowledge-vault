"use strict";
// 启动器：package.json 的 main。永远来自安装包内置的 app.asar（签名内的文件从不修改）。
// 启动时到 ~/Library/Application Support/DouyinKnowledgeVault/updates/ 找已下载的新应用层，
// 校验通过就加载它的 main.js，否则加载内置应用层。新应用层启动失败会自动退回内置版本。
const { app } = require("electron");
const path = require("path");
const os = require("os");
const ofs = require("original-fs"); // 把 .asar 当普通文件读写（Electron 的 fs 会把它当目录）
const core = require("../lib/update-core");

const BUNDLED_ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(os.homedir(), "Library", "Application Support", "DouyinKnowledgeVault");
const UPDATES_DIR = process.env.DKV_UPDATES_DIR || path.join(DATA_DIR, "updates");

function readPkgVersion(root) {
  try { return JSON.parse(require("fs").readFileSync(path.join(root, "package.json"), "utf8")).version || "0.0.0"; }
  catch { return app.getVersion(); }
}

const bundledVersion = readPkgVersion(BUNDLED_ROOT);
const electron = process.versions.electron;
const noUpdates = process.argv.includes("--no-updates") || process.env.DKV_NO_UPDATES === "1";

let state = core.readState(ofs, UPDATES_DIR);
let picked = { layer: null, rejected: [], changed: false };
if (!noUpdates) {
  try {
    picked = core.selectLayer({ fsImpl: ofs, updatesDir: UPDATES_DIR, bundledVersion, electron, state });
    state = picked.state;
  } catch (err) {
    picked = { layer: null, rejected: [{ version: "?", reason: "选择应用层出错：" + (err && err.message) }], changed: false };
  }
}

const layer = picked.layer;
const info = {
  protocol: core.BOOT_PROTOCOL,
  bundledVersion,
  electron,
  updatesDir: UPDATES_DIR,
  source: layer ? "update" : "bundled",
  version: layer ? layer.version : bundledVersion,
  root: layer ? layer.asarPath : BUNDLED_ROOT,
  rejected: picked.rejected,
};

let settled = false; // 已确认“能正常启动”或已放弃
function save() { core.writeState(ofs, UPDATES_DIR, state); }

function fallBack(reason) {
  if (settled || !layer) return;
  settled = true;
  core.markBad(state, layer.version, reason);
  save();
  try { console.error(`[boot] 应用层 ${layer.version} 启动失败，退回内置版本：${reason}`); } catch { /* ignore */ }
  // 主进程可能已经注册了一半的通道/窗口：最干净的做法是带原参数重启一次，下次会直接用内置层
  app.relaunch();
  app.exit(1);
}

if (layer) {
  core.beginBoot(state, layer.version);
  save();
  const onErr = (err) => fallBack(String((err && (err.stack || err.message)) || err));
  process.on("uncaughtException", onErr);
  process.on("unhandledRejection", onErr);
  info._detach = () => { process.removeListener("uncaughtException", onErr); process.removeListener("unhandledRejection", onErr); };
} else if (picked.changed) {
  save();
}

let readyTimer = null;
const boot = {
  ...info,
  // 窗口加载完成：再观察 10 秒没崩就记为“可正常启动”
  markReady() {
    if (!layer || settled) return;
    if (info._detach) { info._detach(); info._detach = null; }
    if (readyTimer) return;
    readyTimer = setTimeout(() => boot.markGood(), 10000);
    if (readyTimer.unref) readyTimer.unref();
  },
  markGood() {
    if (!layer || settled) return;
    settled = true;
    if (info._detach) { info._detach(); info._detach = null; }
    core.markGood(state, layer.version);
    save();
  },
  // 第二个实例（单实例锁拿不到）马上退出：不算启动失败
  cancelLaunch() {
    if (!layer || settled) return;
    settled = true;
    if (info._detach) { info._detach(); info._detach = null; }
    state = core.readState(ofs, UPDATES_DIR);
    core.cancelBoot(state, layer.version);
    save();
  },
  fail(reason) { fallBack(reason); },
};
delete boot._detach;
global.__dkvBoot = boot;

// 正常退出（包括定时任务模式跑完）也算一次成功启动
app.on("will-quit", () => { if (layer && !settled && app.isReady()) boot.markGood(); });

const entry = path.join(info.root, "main.js");
if (layer) {
  try {
    require(entry);
  } catch (err) {
    fallBack("加载 main.js 出错：" + String((err && (err.stack || err.message)) || err));
  }
} else {
  require(entry);
}
