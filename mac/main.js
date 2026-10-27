"use strict";
// 抖音知识库 · macOS 版主进程
// 界面沿用 Windows 版（renderer/），后端换成 FavVault 处理引擎（Python worker：yt-dlp 下载 → 本地 Whisper 转写 →
// OpenAI 兼容接口提炼 → Obsidian Markdown）。抖音扫码登录与收藏采集在 Electron 内完成，不需要 Playwright。
const { app, BrowserWindow, ipcMain, dialog, shell, session, powerMonitor, Notification, net } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, execFile } = require("child_process");

const douyin = require("./lib/douyin");
const vault = require("./lib/vault");
const st = require("./lib/state");
const llm = require("./lib/llm");
const launchd = require("./lib/launchd");
const asr = require("./lib/asr");
const dweb = require("./lib/douyin-web");
const { createVaultIndex } = require("./lib/vault-index");
const vidx = createVaultIndex(); // 知识库异步索引：树/搜索/图谱/统计不阻塞主进程
const { createUpdater } = require("./lib/updater");
const { createFonts } = require("./lib/fonts");

// ---------------- 应用层信息（由 boot/bootstrap.js 提供） ----------------
// 本文件可能来自安装包内置的 app.asar，也可能来自数据目录 updates/ 里下载的新应用层；
// 所有资源路径都相对本文件的 __dirname，自然落在当前应用层里。
const LAYER_VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version; } catch { return app.getVersion(); } })();
const BOOT = global.__dkvBoot || {
  protocol: 0, version: LAYER_VERSION, bundledVersion: app.getVersion(), source: "bundled", electron: process.versions.electron,
  updatesDir: path.join(os.homedir(), "Library", "Application Support", "DouyinKnowledgeVault", "updates"), rejected: [],
  markReady() {}, markGood() {}, cancelLaunch() {}, fail() {},
};
const argValue = (name) => { const a = process.argv.find((x) => x.startsWith(name + "=")); return a ? a.slice(name.length + 1) : ""; };
const PRINT_LAYER_FILE = argValue("--print-layer");
const UPDATE_NOW_FILE = argValue("--update-now");
const LOGIN_PROBE_FILE = argValue("--login-probe");
const CONTRAST_FILE = argValue("--contrast-check"); // CI：每个皮肤 × 性能模式开/关，检查弹窗与设置卡片文字对比度 // CI：打开登录页，检查能否加载 + 自定义协议是否被拦截

// ---------------- 路径 ----------------
// 数据目录用纯英文名，避免中文路径在 Python 虚拟环境脚本里出问题
const DATA_DIR = path.join(os.homedir(), "Library", "Application Support", "DouyinKnowledgeVault");
app.setPath("userData", DATA_DIR);
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const VAR_DIR = path.join(DATA_DIR, "var");
const LOCK_FILE = path.join(VAR_DIR, "sync.lock");
const PAUSE_FILE = path.join(VAR_DIR, "pause.flag");
const PROGRESS_FILE = path.join(VAR_DIR, "sync-progress.json");
const LOG_DIR = path.join(VAR_DIR, "logs");
const SCHED_LOG = path.join(LOG_DIR, "scheduler.log");
const CARDS_DIR = path.join(DATA_DIR, "knowledge-cards");
const COOKIES_FILE = path.join(DATA_DIR, "douyin-cookies.txt");
const ENGINE_HOME = path.join(DATA_DIR, "engine"); // FAVVAULT_HOME：venv / python / worker 状态库 / 临时媒体
const VENV_PY = path.join(ENGINE_HOME, "venv", "bin", "python");
// 处理组件源码随应用层一起放在 app.asar/engine（增量更新也会带上新版本）；安装时拷贝出来再运行
const ENGINE_SRC = path.join(__dirname, "engine");
const FONTS_DIR = path.join(DATA_DIR, "fonts");
const DOUYIN_PARTITION = "persist:douyin";
const IS_ARM = process.arch === "arm64";
const LAUNCH_AGENT = path.join(os.homedir(), "Library", "LaunchAgents", `${launchd.LABEL}.plist`);

const DEFAULT_SETTINGS = {
  vaultPath: path.join(os.homedir(), "Documents", "抖音知识库"),
  llmBaseUrl: "https://api.deepseek.com/v1",
  llmApiKey: "",
  llmModel: "deepseek-chat",
  whisperModel: "mlx-community/whisper-large-v3-turbo",
  asrEngine: "sensevoice", // sensevoice | whisper；老用户（settings.json 里没有这个字段）保持 whisper，见 loadSettings
  modelsDir: "",           // 自定义模型文件夹（作为 HF_HUB_CACHE 交给 worker）；空 = 标准 Hugging Face 缓存
  startDate: "",
  startDateAcknowledged: false,
  processMode: "time",
  countLimit: 100,
  dailyLimit: 100,
  pauseAutoResumeMinutes: 0,
  cardMinVideos: 50,
  weeklyReport: { enabled: false, weekday: 2, lastShownDate: "", streak: 0, bestStreak: 0, totalShown: 0, aiSummary: "", aiSummaryWeek: "", aiDirection: "", aiDirectionWeek: "" },
  unlockedBadges: {},
  pinnedMajors: [],
  pinnedCards: [],
  apiUsage: { weekKey: "", tokens: 0, calls: 0 },
  apiBalance: { time: "", balance: "" },
  schedule: { time: "", weekday: 0, enabled: false, lastRun: "", lastResult: null },
  perfMode: true,     // 性能模式：关掉毛玻璃（backdrop-filter）、重阴影和装饰动画，背景图用缩小版
  autoUpdate: true,   // 启动时自动检查并后台下载增量更新
  updateMirrors: [],  // 下载源前缀，空数组 = 默认（先直连 GitHub，慢了换 ghfast.top 镜像）
  // 以下为 Windows 版字段，Mac 版不使用，仅为兼容界面保留
  projectPath: "", nodePath: "", pythonPath: "", cangjiePath: "", distillOutputDir: "",
};

function loadSettings() {
  let s;
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch (err) { if (err && err.code !== "ENOENT") raw = {}; }
  s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  s.asrEngine = asr.resolveAsrEngine(raw);
  if (!s.vaultPath) s.vaultPath = DEFAULT_SETTINGS.vaultPath;
  s.schedule = { ...DEFAULT_SETTINGS.schedule, ...(s.schedule || {}) };
  return s;
}

function saveSettings(patch) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const prev = loadSettings();
  const next = { ...prev, ...(patch || {}) };
  if (typeof next.vaultPath === "string") next.vaultPath = next.vaultPath.replace(/^~(?=\/|$)/, os.homedir());
  st.writeJsonAtomic(SETTINGS_FILE, next);
  // 处理方式/条数变了：按数量快照作废，下次采集时重新锁定
  if (patch && (("processMode" in patch && patch.processMode !== prev.processMode) || ("countLimit" in patch && Number(patch.countLimit) !== Number(prev.countLimit)))) {
    const store = new st.StateStore(STATE_FILE);
    store.clearCountSnapshot();
    store.save();
  }
  return next;
}

function ensureVaultDir(s) {
  try { if (s.vaultPath) fs.mkdirSync(path.join(s.vaultPath, "Knowledge"), { recursive: true }); } catch { /* 权限问题在处理时报出 */ }
}

function logSched(line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(SCHED_LOG, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch { /* ignore */ }
}

function writeProgress(p) {
  try { st.writeJsonAtomic(PROGRESS_FILE, { ...p, updatedAt: new Date().toISOString() }); } catch { /* ignore */ }
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && w.webContents && !w.webContents.isDestroyed()) w.webContents.send(channel, payload);
  }
}
const sendLog = (text) => broadcast("pipeline:log", text);
/** 知识库有变化：作废索引缓存，通知界面刷新 */
function vaultChanged() { vidx.invalidate(); broadcast("vault:changed"); }

// ---------------- 单实例 + 定时任务入口 ----------------
const SCHEDULED = process.argv.includes("--scheduled-sync");
const gotLock = (PRINT_LAYER_FILE || UPDATE_NOW_FILE || LOGIN_PROBE_FILE || CONTRAST_FILE) ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  BOOT.cancelLaunch();
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    if (argv.includes("--scheduled-sync")) { runScheduledSync().catch(() => {}); return; }
    if (!mainWindow) createWindow();
    else { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
  });
}

let mainWindow = null;

function createWindow() {
  const { screen } = require("electron");
  const area = screen.getPrimaryDisplay().workArea;
  const w = Math.min(1280, area.width - 40);
  const h = Math.min(820, area.height - 60);
  mainWindow = new BrowserWindow({
    width: w,
    height: h,
    minWidth: 980,
    minHeight: 640,
    title: "抖音知识库",
    show: false,
    backgroundColor: "#0f172a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.once("ready-to-show", () => { mainWindow.center(); mainWindow.show(); mainWindow.focus(); });
  mainWindow.webContents.once("did-finish-load", () => BOOT.markReady());
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  // 笔记里的外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (dweb.isWebUrl(url)) shell.openExternal(url); // 只把 http(s) 交给系统浏览器
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith("file:")) return;
    e.preventDefault();
    if (dweb.isWebUrl(url)) shell.openExternal(url);
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

// ---------------- 抖音登录 / Cookie / 采集 ----------------
const DOUYIN_UA = dweb.chromeUA(process.versions.chrome); // 与内置 Chromium 版本一致，不带 Electron 字样
const DOUYIN_LOG = path.join(LOG_DIR, "douyin-web.log");
const blockedSchemes = []; // 最近拦截的自定义协议（调试 / CI 检查用）
function douyinDebug(line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(DOUYIN_LOG, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch { /* ignore */ }
}
function noteBlocked(kind, url) {
  const scheme = dweb.protocolOf(url) || String(url).slice(0, 40);
  blockedSchemes.push({ kind, scheme, at: Date.now() });
  if (blockedSchemes.length > 50) blockedSchemes.shift();
  douyinDebug(`[debug] blocked ${kind}: ${String(url).slice(0, 200)}`); // 只记到文件，不打扰用户
}

function douyinSession() {
  const ses = session.fromPartition(DOUYIN_PARTITION);
  if (!ses.__dkvSetup) {
    ses.__dkvSetup = true;
    ses.setUserAgent(DOUYIN_UA, "zh-CN,zh");
    // Client Hints 里也不能出现 Electron
    ses.webRequest.onBeforeSendHeaders({ urls: ["*://*/*"] }, (details, cb) => {
      cb({ requestHeaders: dweb.fixRequestHeaders(details.requestHeaders, process.versions.chrome) });
    });
    // 抖音页面会探测 bitbrowser:// 等协议；Electron 默认交给 macOS，就会弹「未设定用来打开 URL 的应用程序」
    ses.setPermissionRequestHandler((_wc, permission, cb, details) => {
      const ok = dweb.permissionDecision(permission, details);
      if (!ok && permission === "openExternal") noteBlocked("openExternal", (details && details.externalURL) || "");
      cb(ok);
    });
    ses.setPermissionCheckHandler((_wc, permission, _origin, details) => dweb.permissionDecision(permission, details));
  }
  return ses;
}

/** 给每个抖音会话里的 webContents 加上导航/弹窗守卫（登录窗口、隐藏采集窗口、它们的弹窗） */
function guardDouyinContents(wc, { allowPopups = false } = {}) {
  if (!wc || wc.__dkvGuard) return;
  wc.__dkvGuard = true;
  const block = (kind) => (e, url) => {
    const u = typeof url === "string" ? url : (e && e.url) || "";
    if (dweb.isExternalScheme(u)) { e.preventDefault(); noteBlocked(kind, u); }
  };
  wc.on("will-navigate", block("will-navigate"));
  wc.on("will-frame-navigate", (e) => { if (dweb.isExternalScheme(e.url)) { e.preventDefault(); noteBlocked("will-frame-navigate", e.url); } });
  wc.on("will-redirect", block("will-redirect"));
  wc.setWindowOpenHandler(({ url }) => {
    const d = dweb.windowOpenDecision(url, { allowPopups: allowPopups || !!wc.__dkvAllowPopups });
    if (d === "deny") { if (!dweb.isWebUrl(url)) noteBlocked("window-open", url); return { action: "deny" }; }
    return {
      action: "allow",
      overrideBrowserWindowOptions: { width: 900, height: 700, webPreferences: { partition: DOUYIN_PARTITION, contextIsolation: true, nodeIntegration: false } },
    };
  });
}

app.on("web-contents-created", (_e, wc) => {
  try {
    if (wc.session === session.fromPartition(DOUYIN_PARTITION)) {
      douyinSession();
      guardDouyinContents(wc);
    }
  } catch { /* ignore */ }
});

async function douyinCookies() {
  const all = await douyinSession().cookies.get({});
  return all.filter(douyin.isDouyinCookie);
}

async function isLoggedIn() {
  return douyin.hasSessionCookie(await douyinCookies());
}

async function exportCookies() {
  const cookies = await douyinCookies();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(COOKIES_FILE, douyin.toNetscapeCookies(cookies), { encoding: "utf8", mode: 0o600 });
  return { file: COOKIES_FILE, count: cookies.length, loggedIn: douyin.hasSessionCookie(cookies) };
}

let loginWindow = null;
let loginDiag = null; // 最近一次登录窗口的诊断信息（CI / 排查用）
function openLoginWindow({ show = true, url = dweb.LOGIN_HOME_URL } = {}) {
  if (loginWindow && !loginWindow.isDestroyed()) { if (show) { loginWindow.show(); loginWindow.focus(); } return loginWindow; }
  douyinSession();
  loginWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    show,
    title: "抖音扫码登录（登录成功后自动关闭）",
    backgroundColor: "#ffffff",
    webPreferences: { partition: DOUYIN_PARTITION, contextIsolation: true, nodeIntegration: false },
  });
  const win = loginWindow;
  const wc = win.webContents;
  wc.__dkvAllowPopups = true;
  guardDouyinContents(wc, { allowPopups: true });
  loginDiag = { domReady: false, failed: null, gone: null, consoleErrors: 0, probe: null, blank: false, autoLogin: null };
  let altIdx = 0;
  let consoleLogged = 0;
  wc.on("dom-ready", () => { loginDiag.domReady = true; });
  wc.on("did-fail-load", (_e, code, desc, failedUrl, isMain) => {
    if (code === -3 || !isMain) return; // -3 = 被新导航取消
    loginDiag.failed = { code, desc, url: failedUrl };
    sendLog(`⚠ 抖音登录页加载失败（${code} ${desc}）：${failedUrl}\n`);
    const alt = dweb.LOGIN_ALT_URLS[altIdx++ % dweb.LOGIN_ALT_URLS.length];
    wc.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(dweb.failPageHtml(`${desc}（${code}）`, dweb.LOGIN_HOME_URL, alt))).catch(() => {});
  });
  wc.on("render-process-gone", (_e, d) => {
    loginDiag.gone = d && d.reason;
    sendLog(`⚠ 抖音登录页进程退出（${d && d.reason}），正在重新加载…\n`);
    if (d && d.reason !== "clean-exit") setTimeout(() => { if (!win.isDestroyed()) wc.loadURL(dweb.LOGIN_HOME_URL, { userAgent: DOUYIN_UA }).catch(() => {}); }, 1000);
  });
  wc.on("console-message", (_e, level, message) => {
    if (level < 3) return;
    loginDiag.consoleErrors++;
    if (consoleLogged++ < 5) douyinDebug(`[console] ${String(message).slice(0, 300)}`);
  });
  // 首页加载完：没弹出扫码框就点一下「登录」；10 秒后仍空白就给出「重新加载 / 换一个登录页面」
  let checks = 0;
  const check = async () => {
    if (win.isDestroyed()) return;
    checks++;
    try {
      const info = await wc.executeJavaScript(dweb.PROBE_SCRIPT, true);
      loginDiag.probe = info;
      if (!info.hasQr && /douyin\.com/.test(info.url) && checks <= 3) loginDiag.autoLogin = await wc.executeJavaScript(dweb.AUTO_LOGIN_SCRIPT, true);
      if (checks >= 3 && dweb.looksBlank(info)) {
        loginDiag.blank = true;
        sendLog("⚠ 抖音登录页一直是空白：可以在登录窗口顶部点「重新加载」或「换一个登录页面」。\n");
        await wc.executeJavaScript(dweb.blankBannerScript(dweb.LOGIN_ALT_URLS[altIdx++ % dweb.LOGIN_ALT_URLS.length]), true);
      }
    } catch (err) { douyinDebug(`[probe] ${err && err.message}`); }
  };
  const probeTimers = [3500, 7000, 10500].map((ms) => setTimeout(check, ms));
  wc.on("did-navigate", () => { if (checks >= 3) setTimeout(check, 4000); });
  wc.loadURL(url, { userAgent: DOUYIN_UA }).catch(() => {});
  if (show) sendLog("已打开抖音登录窗口：请用抖音 App 扫码（没看到二维码就点页面右上角「登录」），登录成功后窗口会自动关闭。\n");
  let done = false;
  const timer = setInterval(async () => {
    if (done || win.isDestroyed()) { clearInterval(timer); return; }
    try {
      if (await isLoggedIn()) {
        done = true;
        clearInterval(timer);
        await exportCookies();
        sendLog("✓ 抖音登录成功，登录状态已保存。\n");
        broadcast("douyin:login", { ok: true });
        setTimeout(() => { if (!win.isDestroyed()) win.close(); }, 2500);
      }
    } catch { /* keep polling */ }
  }, 2000);
  win.on("closed", () => { clearInterval(timer); probeTimers.forEach(clearTimeout); if (loginWindow === win) loginWindow = null; });
  return win;
}

/** 在隐藏的抖音页面里执行采集脚本（携带登录 Cookie，同源 fetch） */
async function withDouyinPage(fn) {
  douyinSession();
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: { partition: DOUYIN_PARTITION, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  guardDouyinContents(win.webContents, { allowPopups: false });
  win.webContents.setAudioMuted(true);
  try {
    await Promise.race([
      win.loadURL(douyin.COLLECTION_PAGE_URL, { userAgent: DOUYIN_UA }).catch(() => {}),
      new Promise((r) => setTimeout(r, 30000)),
    ]);
    if (!/douyin\.com/.test(win.webContents.getURL())) throw new Error("打不开抖音网页，请检查网络后重试");
    await new Promise((r) => setTimeout(r, 2000)); // 等页面初始化签名/风控脚本
    return await fn((script) => win.webContents.executeJavaScript(script, true));
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function fetchFolders(maxItems = 100) {
  return withDouyinPage((exec) => douyin.collectPaged({
    fetchPage: ({ cursor, count }) => exec(douyin.buildFetchScript("folders", { cursor, count })),
    maxItems,
    mapItem: (f) => (f && f.collects_id && f.name ? f : null),
    keyOf: (f) => f.collects_id,
    what: "读取收藏夹",
  }));
}

async function fetchFavorites({ collectsId = "", maxItems = 3000, onPage } = {}) {
  const observedAt = new Date().toISOString();
  return withDouyinPage((exec) => douyin.collectPaged({
    fetchPage: ({ cursor, count }) => exec(collectsId
      ? douyin.buildFetchScript("folderVideos", { cursor, count, collectsId })
      : douyin.buildFetchScript("favorites", { cursor, count })),
    maxItems,
    mapItem: (raw) => douyin.toStoreItem(raw, observedAt),
    keyOf: (it) => it.aweme_id,
    what: collectsId ? "读取收藏夹视频" : "读取收藏",
    onPage,
  }));
}

// ---------------- 处理引擎（FavVault worker） ----------------
let engineCache = null; // 最近一次 doctor 结果

// 从访达打开的应用读不到 ~/.zshrc 里的 HF_HOME / HF_HUB_CACHE：启动时问一次登录 shell，与其他软件共用同一个模型缓存
let shellHfEnv = {};
function probeShellHfEnv() {
  return new Promise((resolve) => {
    const sh = process.env.SHELL && /(zsh|bash)$/.test(process.env.SHELL) ? process.env.SHELL : "/bin/zsh";
    try {
      execFile(sh, ["-ilc", asr.SHELL_PROBE], { timeout: 4000, env: { HOME: os.homedir(), USER: os.userInfo().username, PATH: "/usr/bin:/bin" } }, (_err, stdout) => {
        shellHfEnv = asr.parseShellProbe(stdout);
        resolve(shellHfEnv);
      });
    } catch { resolve({}); }
  });
}

function modelsCacheDir(s) {
  return asr.hfHubCache({ ...asr.modelEnv(s || loadSettings(), process.env, shellHfEnv) }, os.homedir());
}
function modelsInfo(s) {
  s = s || loadSettings();
  const dir = modelsCacheDir(s);
  const custom = !!(s.modelsDir && s.modelsDir.trim());
  const def = asr.hfHubCache(asr.modelEnv({}, process.env, shellHfEnv), os.homedir());
  return { cacheDir: dir, custom, defaultDir: def, models: asr.allModelStatus(dir) };
}

function engineInstalled() {
  return fs.existsSync(VENV_PY) && fs.existsSync(path.join(ENGINE_HOME, "venv", "bin", "favvault-worker"));
}

function workerEnv(s) {
  return {
    ...process.env,
    FAVVAULT_HOME: ENGINE_HOME,
    FAVVAULT_VAULT: s.vaultPath || "",
    FAVVAULT_LLM_BASE_URL: s.llmBaseUrl || "",
    FAVVAULT_LLM_MODEL: s.llmModel || "deepseek-chat",
    FAVVAULT_LLM_API_KEY: s.llmApiKey || "",
    FAVVAULT_ASR_ENGINE: asr.workerEngine(s.asrEngine, IS_ARM),
    FAVVAULT_ASR_MODEL: s.asrEngine === "whisper" && IS_ARM ? (s.whisperModel || "") : "",
    ...asr.modelEnv(s, process.env, shellHfEnv),
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
    HF_HUB_DISABLE_TELEMETRY: "1",
    PATH: [path.join(ENGINE_HOME, "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
  };
}

/** 运行 worker 子命令，逐行回调 JSON 事件。返回 {code, events, stderr} */
function runWorker(args, { onEvent, onChild, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const s = loadSettings();
    let child;
    try {
      child = spawn(VENV_PY, ["-m", "favvault_worker", ...args], { env: workerEnv(s), cwd: ENGINE_HOME });
    } catch (err) {
      return resolve({ code: -1, events: [], stderr: String(err.message || err) });
    }
    if (onChild) onChild(child);
    const events = [];
    let stderr = "";
    const splitter = st.lineSplitter((line) => {
      const ev = st.parseEventLine(line);
      if (ev) { events.push(ev); if (onEvent) onEvent(ev); }
    });
    child.stdout.on("data", (c) => splitter.push(c));
    child.stderr.on("data", (c) => { stderr = (stderr + String(c)).slice(-4000); });
    let timer = null;
    if (timeoutMs) timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    child.on("error", (err) => { stderr += String(err.message || err); });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      splitter.flush();
      resolve({ code: code === null ? -1 : code, events, stderr });
    });
  });
}

async function engineDoctor() {
  if (!engineInstalled()) {
    engineCache = { installed: false };
    return engineCache;
  }
  const r = await runWorker(["doctor"], { timeoutMs: 90000 });
  const ev = r.events.find((e) => e.event === "doctor");
  if (!ev) {
    engineCache = { installed: false, broken: true, error: "处理组件自检失败：" + (r.stderr.trim().split("\n").pop() || `退出码 ${r.code}`) };
    return engineCache;
  }
  const whisperReady = IS_ARM ? !!(ev.mlx && ev.whisperReady) : true; // Intel 用 faster-whisper，首次转写时自动下载小模型
  engineCache = { installed: true, ffmpeg: !!ev.ffmpeg, ytdlp: !!ev.ytdlp, mlx: !!ev.mlx, whisperReady, sensevoice: !!ev.sensevoice };
  return engineCache;
}

let installing = false;
// 递归复制（只用 Electron 支持 asar 的基础 fs 接口，源目录可以在 .asar 里）
function copyTree(src, dst, filter) {
  if (filter && !filter(src)) return;
  const stt = fs.statSync(src);
  if (stt.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const n of fs.readdirSync(src)) copyTree(path.join(src, n), path.join(dst, n), filter);
  } else {
    fs.writeFileSync(dst, fs.readFileSync(src));
  }
}

async function installEngine(opts = {}) {
  if (installing) return { ok: false, error: "正在安装中，请稍候" };
  const script = path.join(ENGINE_SRC, "install-worker.sh");
  const src = path.join(ENGINE_SRC, "worker");
  if (!fs.existsSync(script) || !fs.existsSync(src)) return { ok: false, error: "安装包不完整：找不到内置的处理组件，请重新下载应用" };
  installing = true;
  const progress = (pct, msg) => { broadcast("engine:progress", { kind: "install", pct, msg }); };
  try {
    progress(1, "准备安装文件");
    const workDir = path.join(ENGINE_HOME, "src", "worker");
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(workDir), { recursive: true });
    copyTree(src, workDir, (p) => !/(__pycache__|\.pytest_cache|\/tests(\/|$))/.test(p));
    // 脚本可能在 .asar 里（增量应用层），bash 读不了：先拷出来
    const scriptCopy = path.join(ENGINE_HOME, "src", "install-worker.sh");
    fs.writeFileSync(scriptCopy, fs.readFileSync(script));
    const s0 = loadSettings();
    const extra = opts.extra || asr.installExtras(opts.engine || s0.asrEngine, IS_ARM, engineCache);
    return await new Promise((resolve) => {
      const child = spawn("/bin/bash", [scriptCopy, workDir, extra], {
        env: { ...process.env, FAVVAULT_HOME: ENGINE_HOME, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        cwd: ENGINE_HOME,
      });
      let failed = "";
      let done = false;
      const tail = [];
      const splitter = st.lineSplitter((line) => {
        let m;
        if ((m = /^PROGRESS\s+(\d+)\s*(.*)$/.exec(line))) progress(Number(m[1]), m[2]);
        else if (line === "DONE") done = true;
        else if ((m = /^FAILED\s*(.*)$/.exec(line))) failed = m[1] || "安装失败";
        else { tail.push(line); if (tail.length > 8) tail.shift(); }
      });
      child.stdout.on("data", (c) => splitter.push(c));
      child.stderr.on("data", (c) => { for (const l of String(c).split("\n")) if (l.trim()) { tail.push(l.trim()); if (tail.length > 8) tail.shift(); } });
      child.on("error", (err) => { failed = "无法启动安装程序：" + (err.message || err); });
      child.on("close", async (code) => {
        splitter.flush();
        if (done && code === 0) {
          const doc = await engineDoctor();
          progress(100, "处理组件安装完成");
          resolve({ ok: true, engine: doc });
        } else {
          const detail = tail.length ? "\n" + tail.slice(-4).join("\n") : "";
          resolve({ ok: false, error: (failed || `安装失败（退出码 ${code}）`) + detail });
        }
      });
    });
  } catch (err) {
    return { ok: false, error: "安装失败：" + String(err.message || err) };
  } finally {
    installing = false;
  }
}

let modelDownloading = false; // 正在下载的引擎名，或 false
/** 下载某个引擎的模型（默认当前引擎）到 Hugging Face 缓存；需要的组件没装时先装上 */
async function downloadModel(engineKey) {
  if (!engineInstalled()) return { ok: false, error: "请先安装处理组件" };
  const s = loadSettings();
  const eng = asr.normEngine(engineKey || s.asrEngine);
  if (eng === "whisper" && !IS_ARM) return { ok: true, message: "Intel Mac 使用 faster-whisper，首次转写时会自动下载小模型" };
  if (modelDownloading) return { ok: false, error: "模型正在下载中" };
  const spec = asr.ENGINES[eng];
  modelDownloading = eng;
  const prog = (pct, msg) => broadcast("engine:progress", { kind: "model", engine: eng, pct, msg });
  try {
    let doc = engineCache && engineCache.installed ? engineCache : await engineDoctor();
    if (!doc[spec.module]) {
      prog(0, `先安装 ${spec.label} 组件…`);
      const r = await installEngine({ engine: eng, extra: asr.installExtras(eng, IS_ARM, doc) });
      if (!r.ok) return { ok: false, error: r.error };
      doc = engineCache;
      if (!doc || !doc[spec.module]) return { ok: false, error: `${spec.label} 组件安装后自检未通过` };
    }
    prog(0, "连接模型下载服务器…");
    const args = ["download-model", "--engine", eng === "whisper" ? "mlx" : "sensevoice"];
    if (eng === "whisper" && s.whisperModel) args.push("--model", s.whisperModel);
    const r = await runWorker(args, {
      onEvent: (ev) => {
        if (ev.event === "progress" && ev.stage === "model_download" && ev.total) {
          const pct = Math.min(99, Math.floor((ev.done / ev.total) * 100));
          prog(pct, `正在下载 ${spec.label} 模型 ${(ev.done / 1048576).toFixed(0)} / ${(ev.total / 1048576).toFixed(0)} MB`);
        } else if (ev.event === "log" && /downloading .* from (.*)/.test(ev.message || "")) {
          prog(1, "下载源：" + /from (.*)$/.exec(ev.message)[1]);
        }
      },
    });
    const ready = r.events.find((e) => e.event === "model_ready");
    if (ready) {
      if (eng === "whisper") engineCache = { ...(engineCache || {}), installed: true, whisperReady: true, mlx: true };
      prog(100, `${spec.label} 模型已就绪`);
      return { ok: true, path: ready.path };
    }
    const err = r.events.find((e) => e.event === "error");
    return { ok: false, error: (err && err.message) || ("模型下载失败：" + (r.stderr.trim().split("\n").pop() || `退出码 ${r.code}`)) };
  } finally {
    modelDownloading = false;
  }
}

function asrReadyNow(s, doc) {
  return asr.engineReady(s.asrEngine, doc, modelsInfo(s).models, IS_ARM);
}

/** 处理前检查：组件、模型、知识库、登录。返回中文错误或空串 */
async function preflight(s, { needLogin = true } = {}) {
  if (!engineInstalled()) return "还没安装处理组件：请到「设置 → 处理组件」点「一键安装」";
  const doc = engineCache && engineCache.installed ? engineCache : await engineDoctor();
  if (!doc.installed) return doc.error || "处理组件不可用：请到「设置 → 处理组件」重新安装";
  if (!asrReadyNow(s, doc)) {
    const spec = asr.ENGINES[s.asrEngine] || asr.ENGINES.sensevoice;
    return `还没准备好 ${spec.label} 语音识别模型：请到「设置 → 处理组件」点「下载」`;
  }
  if (!s.vaultPath) return "还没设置知识库路径（设置 → 项目配置）";
  ensureVaultDir(s);
  if (!s.llmApiKey) return "还没填写 API Key：请到「设置 → AI 接口配置」填写，否则无法生成知识笔记";
  if (needLogin && !(await isLoggedIn())) return "未登录抖音：请到「设置 → 抖音账号」点「打开抖音扫码登录」";
  return "";
}

// ---------------- 批量处理（锁 / 暂停 / 重试 / 进度） ----------------
let currentJob = null; // { cancelled, child }

function isPaused() { return fs.existsSync(PAUSE_FILE); }

async function waitWhilePaused(job, progressBase) {
  if (!isPaused()) return;
  sendLog("⏸ 已暂停：点「继续任务」后接着处理\n");
  writeProgress({ ...progressBase, running: true, stage: "paused" });
  logSched("PAUSED");
  while (isPaused() && !job.cancelled) {
    const mins = Number(loadSettings().pauseAutoResumeMinutes || 0);
    if (mins > 0) {
      try {
        if (powerMonitor.getSystemIdleTime() >= mins * 60) {
          fs.rmSync(PAUSE_FILE, { force: true });
          sendLog(`▶ 电脑已空闲 ${mins} 分钟，自动恢复处理\n`);
          logSched("AUTO-RESUME idle");
          break;
        }
      } catch { /* ignore */ }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!job.cancelled) sendLog("▶ 继续处理\n");
}

/**
 * 逐条处理 keys 对应的条目。worker 内部失败会自动重试一次（30 秒后）。
 * 返回 {ok, written, failed, skipped, cancelled, error}
 */
async function runBatch(keys, { label = "处理", scheduled = false } = {}) {
  const s = loadSettings();
  let note = "";
  try { note = st.acquireLock(LOCK_FILE); }
  catch (err) { return { ok: false, error: err.message, busy: true }; }
  if (note) { sendLog(`🛠 已清理残留同步锁（${note}）\n`); logSched(note); }
  const job = { cancelled: false, child: null };
  currentJob = job;
  const result = { ok: true, written: 0, failed: 0, skipped: 0, cancelled: false };
  const total = keys.length;
  const base = { running: true, done: 0, total, percent: 0, stage: "", startedAt: new Date().toISOString(), scheduled };
  writeProgress(base);
  logSched(`START ${label} total=${total}${scheduled ? " scheduled" : ""}`);
  try {
    const ck = await exportCookies();
    if (!ck.loggedIn) sendLog("⚠ 没有检测到抖音登录 Cookie，下载可能失败；建议先到设置页扫码登录\n");
    const store = new st.StateStore(STATE_FILE);
    for (let i = 0; i < keys.length; i++) {
      await waitWhilePaused(job, { ...base, done: i, percent: Math.round((i / Math.max(1, total)) * 100) });
      if (job.cancelled) { result.cancelled = true; break; }
      store.reload();
      const it = store.get(keys[i]);
      if (!it) continue;
      if (st.DONE.has(it.status)) { sendLog(`[${i + 1}/${total}] 已处理过，跳过：${it.title || it.url}\n`); continue; }
      sendLog(`\n[${i + 1}/${total}] ${it.title || it.url}\n`);
      writeProgress({ ...base, done: i, percent: Math.round((i / Math.max(1, total)) * 100), stage: (it.title || "").slice(0, 30) });
      const fmtState = {};
      let doneEv = null;
      let errEv = null;
      const args = ["process", it.url, "--folder", it.folder || "抖音收藏", "--cookies", COOKIES_FILE, "--retry-delay", "30"];
      const r = await runWorker(args, {
        onChild: (c) => { job.child = c; },
        onEvent: (ev) => {
          if (ev.event === "item_done") doneEv = ev;
          if (ev.event === "error") errEv = ev;
          if (ev.event === "retry") logSched(`RETRY-1 ${it.key}`);
          const text = st.formatEvent(ev, fmtState);
          if (text) sendLog(text);
        },
      });
      job.child = null;
      if (job.cancelled) { result.cancelled = true; break; }
      if (r.code === 3 || (errEv && errEv.code === "lock_busy")) {
        result.ok = false;
        result.error = "另一个处理进程正在运行（可能是定时任务），请稍后再试";
        break;
      }
      const patch = { attempts: Number(it.attempts || 0) + 1 };
      if (doneEv && doneEv.status === "written") {
        const cat = vault.categoryOfPath(s.vaultPath, doneEv.note);
        Object.assign(patch, { status: "written", error: "", note: doneEv.note || "", title: doneEv.title || it.title, category: cat.major, group: cat.group, subcategory: cat.sub });
        result.written++;
      } else if (doneEv && (doneEv.status === "skipped" || doneEv.status === "media_frozen")) {
        Object.assign(patch, { status: "skipped", error: doneEv.error || "", title: doneEv.title || it.title });
        result.skipped++;
      } else {
        const msg = (doneEv && doneEv.error) || (errEv && errEv.message) || (r.stderr.trim().split("\n").pop() || `处理进程退出码 ${r.code}`);
        Object.assign(patch, { status: "failed", stage: (doneEv && doneEv.stage) || "", error: msg, title: (doneEv && doneEv.title) || it.title });
        if (!doneEv) sendLog(`  ✗ 失败：${st.friendlyError(msg)}\n`);
        result.failed++;
      }
      store.update(it.key, patch);
      store.save();
      writeProgress({ ...base, done: i + 1, percent: Math.round(((i + 1) / Math.max(1, total)) * 100), stage: "" });
    }
  } catch (err) {
    result.ok = false;
    result.error = String(err.message || err);
  } finally {
    st.releaseLock(LOCK_FILE);
    currentJob = null;
    const fin = { running: false, done: result.written + result.failed + result.skipped, total, percent: 100, finishedAt: new Date().toISOString(), scheduled };
    if (result.error) fin.error = result.error;
    writeProgress(fin);
    logSched(`${result.error ? "FAILED " + result.error : "DONE"} written=${result.written} skipped=${result.skipped} failed=${result.failed}${result.cancelled ? " cancelled" : ""}`);
    vaultChanged();
  }
  sendLog(`\n本轮结果：生成 ${result.written} 篇 · 跳过 ${result.skipped} 条 · 失败 ${result.failed} 条${result.cancelled ? " · 已取消" : ""}\n`);
  return result;
}

/** 采集收藏 → 入库 → 返回待处理 keys */
async function collectAndQueue(s, { mode = "all", collectsId = "", collectsName = "", limit = 100 }) {
  const folderMode = mode === "folder" && collectsId;
  sendLog(`[1/3] 正在读取${folderMode ? `收藏夹「${collectsName}」` : "全部收藏"}…\n`);
  const isCount = !folderMode && s.processMode === "count" && Number(s.countLimit) > 0;
  const max = isCount ? Number(s.countLimit) : 3000;
  let lastShown = 0;
  const items = await fetchFavorites({
    collectsId: folderMode ? collectsId : "",
    maxItems: max,
    onPage: (n) => { if (n - lastShown >= 100 || n < 40) { lastShown = n; sendLog(`  已读取 ${n} 条…\n`); } },
  });
  sendLog(`  共读取 ${items.length} 条收藏\n`);
  sendLog("[2/3] 导入待处理列表…\n");
  const store = new st.StateStore(STATE_FILE);
  let added = 0;
  for (const it of items) if (store.upsertDiscovered(it, folderMode ? collectsName : "").added) added++;
  if (isCount) store.ensureCountSnapshot(Number(s.countLimit), items.map((x) => x.aweme_id));
  store.save();
  sendLog(`  新增 ${added} 条，已存在 ${items.length - added} 条\n`);
  const filter = st.windowFilter(s, store);
  const collected = new Set(items.map((x) => x.aweme_id));
  let pending = st.pendingOf(store, filter);
  if (folderMode) pending = pending.filter((x) => collected.has(x.key));
  const keys = pending.slice(0, Math.max(1, Number(limit) || 100)).map((x) => x.key);
  return { keys, totalPending: pending.length, collected: items.length };
}

// ---------------- IPC：设置 / 知识库 ----------------
ipcMain.handle("settings:get", () => loadSettings());
ipcMain.handle("settings:save", (_e, patch) => {
  const next = saveSettings(patch || {});
  ensureVaultDir(next);
  watchVault(next.vaultPath);
  return next;
});

ipcMain.handle("dialog:pickVault", async () => {
  const s = loadSettings();
  const r = await dialog.showOpenDialog(mainWindow || undefined, {
    title: "选择知识库文件夹（可以是现有的 Obsidian 库）",
    defaultPath: s.vaultPath || path.join(os.homedir(), "Documents"),
    properties: ["openDirectory", "createDirectory"],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  return { ok: true, path: r.filePaths[0] };
});

ipcMain.handle("llm:test", async (_e, settings) => {
  try {
    const { base, key } = llm.llmConfig(settings || {});
    if (!base) return { ok: false, message: "还没填 Base URL" };
    if (!key) return { ok: false, message: "还没填 API Key" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(base + "/models", { headers: { Authorization: "Bearer " + key }, signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) return { ok: true, message: "连接成功，Key 有效" };
    if (res.status === 401) return { ok: false, message: "Key 无效或过期（401），去官网核对一下" };
    if (res.status === 404) return { ok: false, message: "地址不对（404），检查 Base URL 结尾是不是 /v1" };
    return { ok: false, message: `服务器返回 ${res.status}，稍后重试或换个地址` };
  } catch (err) {
    if (err.name === "AbortError") return { ok: false, message: "连接超时（10 秒），检查网络或地址" };
    return { ok: false, message: "网络不通：" + (err.message || String(err)) };
  }
});

ipcMain.handle("categories:manage", (_e, _settings, args) => {
  const r = vault.manageCategories(loadSettings().vaultPath, args);
  if (r.ok) vaultChanged();
  return r;
});

ipcMain.handle("vault:tree", (_e, vaultPath) => vidx.tree(vaultPath || loadSettings().vaultPath));
ipcMain.handle("vault:read", (_e, { vaultPath, filePath }) => {
  const base = vaultPath || loadSettings().vaultPath;
  const abs = path.isAbsolute(filePath) ? filePath : path.join(base, String(filePath).replace(/\\/g, "/"));
  if (!fs.existsSync(abs)) return { ok: false, error: "文件不存在" };
  return { ok: true, content: fs.readFileSync(abs, "utf8"), path: abs };
});
ipcMain.handle("vault:openInObsidian", async (_e, vaultPath) => {
  const p = vaultPath || loadSettings().vaultPath;
  if (!p || !fs.existsSync(p)) return { ok: false, error: "知识库文件夹不存在" };
  if (fs.existsSync("/Applications/Obsidian.app")) {
    try { await shell.openExternal("obsidian://open?path=" + encodeURIComponent(p)); return { ok: true }; } catch { /* 回退到访达 */ }
  }
  const r = await shell.openPath(p);
  return { ok: r === "", error: r || undefined };
});
ipcMain.handle("vault:search", (_e, { vaultPath, query }) => vidx.search(vaultPath || loadSettings().vaultPath, query));
ipcMain.handle("vault:write", (_e, { path: p, content }) => {
  try {
    if (!p || !fs.existsSync(p)) return { ok: false, error: "文件不存在" };
    fs.writeFileSync(p, content, "utf8");
    vidx.invalidate();
    return { ok: true };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});
ipcMain.handle("vault:graph", (_e, vaultPath) => vidx.graph(vaultPath || loadSettings().vaultPath));

// ---------------- IPC：处理组件 ----------------
function engineStatusPayload(doc) {
  const s = loadSettings();
  const info = modelsInfo(s);
  const asrReady = asr.engineReady(s.asrEngine, doc, info.models, IS_ARM);
  return {
    ok: true, ...doc, arch: process.arch, engineHome: ENGINE_HOME, installing, modelDownloading,
    asrEngine: s.asrEngine, asrReady,
    // 旧字段：当前引擎的模型是否就绪 / 是否需要单独下载
    whisperReady: asrReady, needsModel: s.asrEngine === "sensevoice" || IS_ARM,
    isArm: IS_ARM, modelsDir: info.cacheDir, modelsDirCustom: info.custom, modelsDirDefault: info.defaultDir, models: info.models,
    engines: Object.fromEntries(asr.ENGINE_KEYS.map((k) => [k, { title: asr.ENGINES[k].title, label: asr.ENGINES[k].label, repo: asr.ENGINES[k].repo, size: asr.ENGINES[k].size }])),
  };
}
ipcMain.handle("engine:status", async (_e, opts) => {
  const doc = opts && opts.cached && engineCache ? engineCache : await engineDoctor();
  return engineStatusPayload(doc);
});
ipcMain.handle("engine:install", () => installEngine());
ipcMain.handle("engine:downloadModel", (_e, engineKey) => downloadModel(engineKey));
ipcMain.handle("engine:setAsr", async (_e, engineKey) => {
  if (!asr.ENGINE_KEYS.includes(engineKey)) return { ok: false, error: "未知的识别引擎" };
  saveSettings({ asrEngine: engineKey });
  return engineStatusPayload(engineCache || await engineDoctor());
});
ipcMain.handle("engine:revealModels", async (_e, engineKey) => {
  const info = modelsInfo();
  const m = engineKey && info.models[engineKey];
  let target = m && m.downloaded ? m.repoDir : info.cacheDir;
  try { fs.mkdirSync(info.cacheDir, { recursive: true }); } catch { /* 只读位置：打开最近的上级 */ }
  while (target && !fs.existsSync(target) && path.dirname(target) !== target) target = path.dirname(target);
  const r = await shell.openPath(target);
  return { ok: r === "", path: target, error: r || undefined };
});
ipcMain.handle("engine:chooseModelsDir", async () => {
  const s = loadSettings();
  const r = await dialog.showOpenDialog(mainWindow || undefined, {
    title: "选择模型文件夹（Hugging Face 缓存）",
    message: "模型会下载到这个文件夹，其他使用 Hugging Face 的软件把 HF_HUB_CACHE 指向它即可共用",
    defaultPath: modelsCacheDir(s), properties: ["openDirectory", "createDirectory"],
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
  saveSettings({ modelsDir: r.filePaths[0] });
  return engineStatusPayload(engineCache || await engineDoctor());
});
ipcMain.handle("engine:resetModelsDir", async () => {
  saveSettings({ modelsDir: "" });
  return engineStatusPayload(engineCache || await engineDoctor());
});

// ---------------- IPC：流水线 ----------------
ipcMain.on("pipeline:cancel", () => {
  if (!currentJob) return;
  currentJob.cancelled = true;
  if (currentJob.child) { try { currentJob.child.kill("SIGTERM"); } catch {} }
  sendLog("\n已请求取消：当前步骤结束后停止\n");
});

ipcMain.handle("pipeline:run", async (_e, _settings, args) => {
  const s = loadSettings();
  const a = Array.isArray(args) ? args.map(String) : [];
  if (a[0] !== "sync") return { ok: false, error: `Mac 版不支持命令：${a.join(" ")}` };
  const err = await preflight(s, { needLogin: false });
  if (err) { sendLog(`✗ ${err}\n`); return { ok: false, error: err }; }
  const ni = a.indexOf("--newest");
  const limit = ni >= 0 ? Math.max(1, Number(a[ni + 1]) || 20) : 1;
  const store = new st.StateStore(STATE_FILE);
  const pending = st.pendingOf(store, st.windowFilter(s, store));
  if (!pending.length) {
    const msg = "没有待处理的收藏：请先在「首次处理收藏」点「开始处理收藏」读取抖音收藏，或在「新增收藏」粘贴链接";
    sendLog(msg + "\n");
    return { ok: false, error: msg };
  }
  const r = await runBatch(pending.slice(0, limit).map((x) => x.key), { label: `sync ${limit}` });
  if (r.error) sendLog(`✗ ${r.error}\n`);
  return { ok: r.ok && !r.failed, code: r.ok ? 0 : 1, ...r };
});

ipcMain.handle("pipeline:login", () => {
  try { openLoginWindow(); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err.message || err) }; }
});

ipcMain.handle("pipeline:authStatus", async () => {
  try {
    const ok = await isLoggedIn();
    if (ok) await exportCookies();
    const status = ok ? "authenticated" : "login_required";
    return { ok, status, raw: JSON.stringify({ status, message: ok ? "已登录抖音" : "未登录：请点「打开抖音扫码登录」" }) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle("collects:list", async () => {
  try {
    if (!(await isLoggedIn())) return { ok: false, error: "未登录抖音，请在设置页扫码登录" };
    const list = await fetchFolders(100);
    return { ok: true, folders: list.map((f) => ({ collects_id: String(f.collects_id), name: String(f.name).trim(), total: Number(f.total_number || 0) })) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle("collects:start", async (_e, _settings, payload) => {
  const s = loadSettings();
  const opts = payload || {};
  const err = await preflight(s);
  if (err) { sendLog(`✗ ${err}\n`); return { ok: false, error: err }; }
  if (currentJob) return { ok: false, error: "已有处理任务在运行" };
  try {
    const q = await collectAndQueue(s, { mode: opts.mode, collectsId: String(opts.collectsId || ""), collectsName: String(opts.collectsName || ""), limit: opts.limit || s.dailyLimit });
    if (!q.keys.length) {
      sendLog("[3/3] 处理窗口内没有待处理的收藏（都处理过了，或不在起始日期/条数范围内）\n");
      return { ok: true, nothing: true };
    }
    sendLog(`[3/3] 开始处理：本轮 ${q.keys.length} 条（窗口内待处理共 ${q.totalPending} 条）\n`);
    const r = await runBatch(q.keys, { label: "collect" });
    return { ok: r.ok, cancelled: r.cancelled, error: r.error, written: r.written, failed: r.failed, skipped: r.skipped };
  } catch (e) {
    const msg = String(e.message || e);
    sendLog(`✗ ${msg}\n`);
    return { ok: false, error: msg };
  }
});

ipcMain.handle("newarrivals:list", (_e, _settings, payload) => {
  const { days = 7, limit = 100 } = payload || {};
  const store = new st.StateStore(STATE_FILE);
  const since = Number(days) > 0 ? Date.now() - Number(days) * 86400000 : 0;
  const items = store.all()
    .filter((it) => !since || Date.parse(it.discovered_at || 0) >= since)
    .sort((a, b) => String(b.discovered_at).localeCompare(String(a.discovered_at)))
    .slice(0, Number(limit) || 100)
    .map((it) => ({
      aweme_id: it.aweme_id || it.key, title: it.title, discovered_at: it.discovered_at, status: it.status,
      category: it.category, group: it.group, subcategory: it.subcategory, source_url: it.url,
    }));
  return { ok: true, items };
});

ipcMain.handle("videos:add", async (_e, _settings, payload) => {
  const { urls = [], processNow = false } = payload || {};
  const store = new st.StateStore(STATE_FILE);
  const results = [];
  const keys = [];
  for (const raw of Array.isArray(urls) ? urls : []) {
    const p = douyin.parseShareInput(raw);
    if (!p) { results.push({ ok: false, input: raw }); continue; }
    const { item, added } = store.upsertDiscovered({ aweme_id: p.aweme_id, source_url: p.url, title: "", key: p.aweme_id || p.url }, "手动添加");
    results.push({ ok: true, added, status: item.status, aweme_id: item.aweme_id || item.key });
    if (!st.DONE.has(item.status)) keys.push(item.key);
  }
  store.save();
  if (!results.some((r) => r.ok)) return { ok: false, error: "没有可解析的链接" };
  if (!processNow) return { ok: true, results };
  const s = loadSettings();
  const err = await preflight(s, { needLogin: false });
  if (err) return { ok: false, error: err, results };
  openLogHint();
  const r = await runBatch(keys, { label: "manual" });
  if (r.error) return { ok: false, error: r.error, results };
  const after = new st.StateStore(STATE_FILE);
  const processed = keys.map((k) => { const it = after.get(k) || {}; return { aweme_id: it.aweme_id || k, code: st.DONE.has(it.status) ? 0 : 1, error: it.error || "" }; });
  return { ok: true, results, processed };
});
function openLogHint() { sendLog("\n==== 处理手动添加的视频 ====\n"); }

ipcMain.handle("sync:pause", () => {
  try { fs.mkdirSync(VAR_DIR, { recursive: true }); fs.writeFileSync(PAUSE_FILE, new Date().toISOString()); logSched("PAUSE user"); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err.message || err) }; }
});
ipcMain.handle("sync:resume", () => {
  try { fs.rmSync(PAUSE_FILE, { force: true }); logSched("RESUME user"); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err.message || err) }; }
});
ipcMain.handle("sync:pause-status", () => {
  const lk = st.readLock(LOCK_FILE);
  const running = !!(lk && st.pidAlive(Number(lk.pid)));
  return { ok: true, paused: isPaused(), running, pauseAutoResumeMinutes: Number(loadSettings().pauseAutoResumeMinutes || 0) };
});

ipcMain.handle("cleanup:media", () => {
  const lk = st.readLock(LOCK_FILE);
  if (lk && st.pidAlive(Number(lk.pid))) return { ok: true, blocked: true, notice: "处理任务正在运行，等它结束后再清理" };
  const dir = path.join(ENGINE_HOME, "media");
  let removed = 0, bytesFreed = 0;
  try {
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        try { const s = fs.statSync(p); if (s.isFile()) { bytesFreed += s.size; fs.rmSync(p, { force: true }); removed++; } } catch { /* ignore */ }
      }
    }
    return { ok: true, removed, bytesFreed };
  } catch (err) { return { ok: false, error: String(err.message || err) }; }
});

ipcMain.handle("sync:reset-stuck", async () => {
  try {
    for (const file of [LOCK_FILE, path.join(ENGINE_HOME, "var", "sync.lock")]) {
      const lk = st.readLock(file);
      if (!lk) continue;
      const pid = Number(lk.pid || 0);
      if (pid && pid !== process.pid && st.pidAlive(pid)) {
        return { ok: false, reason: "running", msg: `处理进程（PID ${pid}）仍在运行，无需复位，请等它跑完` };
      }
      if (pid === process.pid && currentJob) return { ok: false, reason: "running", msg: "处理任务正在运行，可在流水线页暂停" };
      fs.rmSync(file, { force: true });
    }
    writeProgress({ running: false, done: 0, total: 0, percent: 0, stage: "" });
    logSched("STUCK-RESET user-click: lock cleared, progress reset");
    return { ok: true };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

ipcMain.handle("stats:overview", () => {
  const s = loadSettings();
  const store = new st.StateStore(STATE_FILE);
  const counts = store.counts(st.windowFilter(s, store));
  const remaining = (counts.discovered || 0) + (counts.media_frozen || 0) + (counts.transcribed || 0) + (counts.extracted || 0) + (counts.failed || 0);
  const done = (counts.written || 0) + (counts.skipped || 0);
  const isCount = s.processMode === "count" && Number(s.countLimit) > 0;
  return {
    ok: true, counts, total: done + remaining, remaining, done,
    windowStart: s.processMode === "time" ? s.startDate || "" : "",
    countMode: isCount, countLimit: isCount ? Number(s.countLimit) : 0, windowInfo: null,
  };
});

ipcMain.handle("failures:list", () => {
  const store = new st.StateStore(STATE_FILE);
  return { ok: true, files: st.failureReports(store.all()) };
});

// ---------------- IPC：知识卡片（Node 直连 AI 接口） ----------------
function cardSafeName(v) {
  return String(v || "").replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "").trim().slice(0, 40) || "未分类";
}
function readCard(major) {
  return st.readJson(path.join(CARDS_DIR, `${cardSafeName(major)}.json`), null);
}

ipcMain.handle("cards:list", async () => {
  const s = loadSettings();
  const tree = await vidx.tree(s.vaultPath);
  const min = Number(s.cardMinVideos || 50);
  const cards = tree.categories.map((c) => {
    const count = c.groups.reduce((m, g) => m + g.subs.reduce((k, sub) => k + sub.files.length, 0), 0);
    const card = readCard(c.name);
    const status = card ? "generated" : count < min ? "below-threshold" : "pending";
    return { major: c.name, count, status, card, generatedAt: card ? card.generatedAt : "" };
  });
  return { ok: true, cards };
});
ipcMain.handle("cards:read", (_e, _settings, major) => {
  const card = readCard(major);
  return { ok: true, exists: !!card, card };
});
ipcMain.handle("cards:delete", (_e, _settings, major) => {
  const file = path.join(CARDS_DIR, `${cardSafeName(major)}.json`);
  if (!fs.existsSync(file)) return { ok: false, error: "卡片文件不存在，可能尚未生成" };
  try { fs.unlinkSync(file); return { ok: true }; } catch (err) { return { ok: false, error: String(err.message || err) }; }
});
ipcMain.handle("cards:generate", async (_e, _settings, major) => {
  const s = loadSettings();
  const notes = await vidx.notesOfMajor(s.vaultPath, String(major || ""));
  const min = Number(s.cardMinVideos || 50);
  if (!notes.length) return { ok: true, status: "no-material" };
  if (notes.length < min) return { ok: true, status: "below-threshold" };
  sendLog(`正在整理「${major}」的 ${notes.length} 篇笔记…\n`);
  const r = await llm.chat(s, [
    { role: "system", content: llm.CARD_SYSTEM },
    { role: "user", content: llm.buildCardPrompt(String(major), notes) },
  ], { json: true, temperature: 0.3 });
  if (!r.ok) return { ok: false, error: r.error };
  recordApiUsage(r.raw);
  let parsed;
  try { parsed = llm.parseJsonLoose(r.content); } catch { return { ok: false, error: "AI 返回的内容不是有效 JSON，请重试" }; }
  const card = llm.normalizeCard(parsed, String(major), notes.length);
  fs.mkdirSync(CARDS_DIR, { recursive: true });
  st.writeJsonAtomic(path.join(CARDS_DIR, `${cardSafeName(major)}.json`), card);
  sendLog(`「${major}」知识卡片已生成：${card.consensus_points.length} 条印证观点 · ${card.knowledge_points.length} 条知识\n`);
  return { ok: true, status: "generated", card };
});

// ---------------- IPC：定时任务（launchd） ----------------
function launchctl(args) {
  return new Promise((resolve) => {
    execFile("/bin/launchctl", args, { timeout: 15000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code || 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") }));
  });
}
async function agentLoaded() {
  const uid = process.getuid ? process.getuid() : 501;
  const r = await launchctl(["print", `gui/${uid}/${launchd.LABEL}`]);
  return r.code === 0;
}
async function loadAgent() {
  const uid = process.getuid ? process.getuid() : 501;
  await launchctl(["bootout", `gui/${uid}`, LAUNCH_AGENT]);
  let r = await launchctl(["bootstrap", `gui/${uid}`, LAUNCH_AGENT]);
  if (r.code !== 0) r = await launchctl(["load", "-w", LAUNCH_AGENT]);
  return r;
}
async function unloadAgent() {
  const uid = process.getuid ? process.getuid() : 501;
  const r = await launchctl(["bootout", `gui/${uid}`, LAUNCH_AGENT]);
  if (r.code !== 0) await launchctl(["unload", "-w", LAUNCH_AGENT]);
}

ipcMain.handle("schedule:status", async () => {
  const s = loadSettings();
  const sch = s.schedule || {};
  const exists = !!sch.time;
  let enabled = false;
  if (exists && fs.existsSync(LAUNCH_AGENT)) enabled = await agentLoaded();
  let nextRunStr = "";
  if (exists && enabled) {
    const [hh, mm] = sch.time.split(":").map(Number);
    nextRunStr = launchd.fmtLocal(launchd.nextRun({ hour: hh, minute: mm, weekday: Number(sch.weekday || 0) }));
  }
  const task = {
    exists, enabled, state: enabled ? "Ready" : "Disabled",
    lastRun: sch.lastRun || "", lastResult: sch.lastResult === null || sch.lastResult === undefined ? 0 : Number(sch.lastResult),
    nextRun: nextRunStr, startBoundary: exists ? `2000-01-01T${sch.time.padStart(5, "0")}:00` : "", weekday: Number(sch.weekday || 0),
  };
  const store = new st.StateStore(STATE_FILE);
  const counts = store.counts(st.windowFilter(s, store));
  const progress = st.readJson(PROGRESS_FILE, null);
  let lock = null;
  try {
    if (fs.existsSync(LOCK_FILE)) lock = { raw: fs.readFileSync(LOCK_FILE, "utf8").trim(), mtime: fs.statSync(LOCK_FILE).mtime.toISOString() };
  } catch { /* ignore */ }
  let logTail = "";
  let selfHeal = [];
  try {
    if (fs.existsSync(SCHED_LOG)) {
      const lines = fs.readFileSync(SCHED_LOG, "utf8").split(/\r?\n/).filter((l) => l.trim());
      logTail = lines.slice(-12).join("\n");
      selfHeal = lines.filter((l) => /RETRY-1|STALE-LOCK-CLEARED/.test(l)).slice(-4).map((l) => l.replace(/^.*?(RETRY-1|STALE-LOCK-CLEARED)/, "$1").slice(0, 140));
    }
  } catch { /* ignore */ }
  const isCount = s.processMode === "count" && Number(s.countLimit) > 0;
  return {
    ok: true, task, counts, progress, lock, logTail, selfHeal,
    windowStart: s.processMode === "time" ? s.startDate || "" : "", countMode: isCount, countLimit: isCount ? Number(s.countLimit) : 0,
    dailyWindow: null, aiDiagnosis: "", diagFailed: false,
  };
});

ipcMain.handle("schedule:set", async (_e, payload) => {
  try {
    const { time, enable, weekday } = payload || {};
    const s = loadSettings();
    const sch = { ...s.schedule };
    if (time !== undefined) {
      if (!/^\d{1,2}:\d{2}$/.test(String(time))) return { ok: false, error: "时间格式不对" };
      sch.time = String(time);
      sch.enabled = true;
    }
    if (weekday !== undefined) sch.weekday = Math.max(0, Math.min(7, Number(weekday) || 0));
    if (enable === true) { if (!sch.time) sch.time = "08:00"; sch.enabled = true; }
    if (enable === false) sch.enabled = false;
    if (sch.enabled) {
      const exe = process.execPath;
      if (!app.isPackaged) return { ok: false, error: "开发模式下不安装定时任务（请使用打包后的应用）" };
      if (/^\/Volumes\//.test(exe) || /AppTranslocation/.test(exe)) {
        return { ok: false, error: "请先把「抖音知识库」拖到「应用程序」文件夹，从那里打开后再设置定时任务" };
      }
      const [hh, mm] = sch.time.split(":").map(Number);
      fs.mkdirSync(path.dirname(LAUNCH_AGENT), { recursive: true });
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.writeFileSync(LAUNCH_AGENT, launchd.buildPlist({
        program: exe, args: ["--scheduled-sync"], hour: hh, minute: mm, weekday: Number(sch.weekday || 0),
        logPath: path.join(LOG_DIR, "launchd.log"),
      }), "utf8");
      const r = await loadAgent();
      if (r.code !== 0 && !(await agentLoaded())) return { ok: false, error: "启用定时任务失败：" + (r.stderr || r.stdout || `launchctl 返回 ${r.code}`).trim().slice(0, 200) };
    } else {
      if (fs.existsSync(LAUNCH_AGENT)) { await unloadAgent(); fs.rmSync(LAUNCH_AGENT, { force: true }); }
    }
    saveSettings({ schedule: sch });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

/** launchd 到点启动：读取最新收藏 → 处理窗口内未完成的条目 */
let scheduledRunning = false;
async function runScheduledSync() {
  if (scheduledRunning) return;
  scheduledRunning = true;
  const s = loadSettings();
  let result = 1;
  let summary = "";
  try {
    logSched("SCHEDULED start");
    const err = await preflight(s);
    if (err) throw new Error(err);
    const q = await collectAndQueue(s, { mode: "all", limit: 500 });
    if (!q.keys.length) { result = 0; summary = "没有新的待处理收藏"; }
    else {
      const r = await runBatch(q.keys, { label: "scheduled", scheduled: true });
      if (r.error && !r.written) throw new Error(r.error);
      result = r.failed && !r.written ? 1 : 0;
      summary = `生成 ${r.written} 篇笔记，跳过 ${r.skipped} 条，失败 ${r.failed} 条`;
    }
  } catch (err) {
    summary = String(err.message || err);
    logSched("SCHEDULED FAILED " + summary);
    writeProgress({ running: false, done: 0, total: 0, percent: 0, error: summary });
  } finally {
    const sch = { ...loadSettings().schedule, lastRun: launchd.fmtLocal(new Date()), lastResult: result };
    saveSettings({ schedule: sch });
    scheduledRunning = false;
    try { if (Notification.isSupported()) new Notification({ title: "抖音知识库 · 定时同步", body: summary || (result === 0 ? "完成" : "失败") }).show(); } catch { /* ignore */ }
  }
  return result;
}

// ---------------- IPC：周报 ----------------
function weekKeyOf(date) {
  const d = new Date(date);
  const dow = d.getDay();
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}
function recordApiUsage(respJson) {
  try {
    const tokens = Number(respJson && respJson.usage && respJson.usage.total_tokens) || 0;
    if (!tokens) return;
    const key = weekKeyOf(new Date());
    const au = { ...(loadSettings().apiUsage || {}) };
    if (au.weekKey !== key) { au.weekKey = key; au.tokens = 0; au.calls = 0; }
    au.tokens += tokens;
    au.calls += 1;
    saveSettings({ apiUsage: au });
  } catch { /* 统计失败不影响主流程 */ }
}

ipcMain.handle("weekly:stats", async () => {
  try {
    const s = loadSettings();
    const root = vault.knowledgeRoot(s.vaultPath);
    const today = new Date();
    const weekStart = new Date(today);
    const dow = today.getDay();
    weekStart.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));
    weekStart.setHours(0, 0, 0, 0);
    const ws = weekStart.getTime();
    const lws = ws - 7 * 86400000;
    const byCat = new Map(), lastCat = new Map();
    let totalNotes = 0, weekNewNotes = 0, lastWeekNewNotes = 0;
    const weekNewTitles = [];
    let weekTopNote = null;
    void root;
    {
      for (const { full, name, parts, mtimeMs, size } of await vidx.files(s.vaultPath)) {
        totalNotes++;
        const major = parts[0] || "未分类";
        try {
          const stt = { mtimeMs, size };
          if (stt.mtimeMs >= ws) {
            weekNewNotes++;
            byCat.set(major, (byCat.get(major) || 0) + 1);
            const title = name.replace(/\.md$/i, "").trim();
            weekNewTitles.push(title);
            if (!weekTopNote || stt.size > weekTopNote.size) weekTopNote = { title, absPath: full, size: stt.size };
          } else if (stt.mtimeMs >= lws) {
            lastWeekNewNotes++;
            lastCat.set(major, (lastCat.get(major) || 0) + 1);
          }
        } catch { /* ignore */ }
      }
    }
    let weekNewCards = 0, lastWeekNewCards = 0, totalCards = 0;
    if (fs.existsSync(CARDS_DIR)) {
      for (const f of fs.readdirSync(CARDS_DIR)) {
        if (!f.endsWith(".json")) continue;
        totalCards++;
        try { const m = fs.statSync(path.join(CARDS_DIR, f)).mtimeMs; if (m >= ws) weekNewCards++; else if (m >= lws) lastWeekNewCards++; } catch { /* ignore */ }
      }
    }
    const toList = (m) => Array.from(m.entries()).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const au = s.apiUsage || {};
    const thisWeek = au.weekKey === weekKeyOf(today);
    return {
      ok: true, weekNewNotes, lastWeekNewNotes, totalNotes, weekNewCards, lastWeekNewCards, totalCards,
      byCategory: toList(byCat), lastByCategory: toList(lastCat), weekNewTitles, weekTopNote,
      weekStart: fmt(weekStart), weekEnd: fmt(today),
      apiUsage: { tokens: thisWeek ? au.tokens || 0 : 0, calls: thisWeek ? au.calls || 0 : 0 },
    };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle("weekly:ack", (_e, { dateKey, hasNew }) => {
  const s = loadSettings();
  const wr = s.weeklyReport || {};
  const last = wr.lastShownDate || "";
  let streak = Number(wr.streak || 0);
  if (hasNew) {
    if (last) streak = Math.round((Date.parse(dateKey) - Date.parse(last)) / 86400000) === 7 ? streak + 1 : 1;
    else streak = 1;
  }
  const next = {
    ...wr,
    enabled: wr.enabled !== false, weekday: wr.weekday || 2, lastShownDate: dateKey, streak,
    bestStreak: Math.max(Number(wr.bestStreak || 0), streak), totalShown: Number(wr.totalShown || 0) + 1,
  };
  saveSettings({ weeklyReport: next });
  return next;
});

function weeklyDigest(data) {
  const d = data || {};
  const cats = (d.byCategory || []).slice(0, 10).map((c) => `${c.name} ${c.count} 篇`).join("、") || "无";
  const titles = (d.weekNewTitles || []).slice(0, 40).join("；") || "无";
  return `本周（${d.weekStart || ""} ~ ${d.weekEnd || ""}）新增笔记 ${d.weekNewNotes || 0} 篇（上周 ${d.lastWeekNewNotes || 0} 篇），知识库共 ${d.totalNotes || 0} 篇。\n按大类：${cats}\n本周新笔记标题：${titles}`;
}
ipcMain.handle("weekly:aiSummary", async (_e, _settings, data) => {
  const s = loadSettings();
  if (!data || !Number(data.weekNewNotes)) return { ok: false, error: "本周还没有新笔记，暂不生成小结" };
  const r = await llm.chat(s, [
    { role: "system", content: "你是用户的学习助手。根据用户本周收藏整理出的笔记情况，写一段 80~150 字的中文周小结：概括本周关注的主题与收获，语气温和、具体，不要编造笔记里没有的内容，不要用 Markdown。" },
    { role: "user", content: weeklyDigest(data) },
  ], { temperature: 0.6, timeoutMs: 60000 });
  if (!r.ok) return { ok: false, error: r.error };
  recordApiUsage(r.raw);
  return { ok: true, summary: r.content.trim() };
});
ipcMain.handle("weekly:aiDirection", async (_e, _settings, data) => {
  const s = loadSettings();
  if (!data || !Number(data.weekNewNotes)) return { ok: false, error: "本周还没有新笔记，暂无可分析的方向" };
  const r = await llm.chat(s, [
    { role: "system", content: "你是用户的学习规划助手。分析用户本周收藏笔记的主题集中度，给出 1~2 个下周值得深入研究的方向（每个方向一句话，说明理由），总共不超过 100 字，中文，不要用 Markdown。" },
    { role: "user", content: weeklyDigest(data) },
  ], { temperature: 0.6, timeoutMs: 60000 });
  if (!r.ok) return { ok: false, error: r.error };
  recordApiUsage(r.raw);
  return { ok: true, direction: r.content.trim() };
});

ipcMain.handle("weekly:balance", async () => {
  try {
    const s = loadSettings();
    const cached = s.apiBalance || {};
    if (cached.time && cached.balance && Date.now() - new Date(cached.time).getTime() < 6 * 3600000) return { ok: true, balance: cached.balance, cached: true };
    const { base, key } = llm.llmConfig(s);
    if (!base || !key) return { ok: false, error: "未配置 AI API Key" };
    let resp = null;
    try { resp = await fetch(`${base.replace(/\/v1$/, "")}/user/balance`, { headers: { Authorization: `Bearer ${key}` } }); } catch { resp = null; }
    if (!resp || !resp.ok) { try { resp = await fetch(`${base}/user/balance`, { headers: { Authorization: `Bearer ${key}` } }); } catch { resp = null; } }
    if (!resp || !resp.ok) return { ok: false, error: "unsupported" };
    const j = await resp.json();
    const bal = j.total_balance ?? (j.data && j.data.total_balance) ?? (j.balance_infos && j.balance_infos[0] && j.balance_infos[0].total_balance) ?? null;
    if (bal === null || bal === undefined) return { ok: false, error: "unsupported" };
    const balance = `¥${Number(bal).toFixed(2)}`;
    saveSettings({ apiBalance: { time: new Date().toISOString(), balance } });
    return { ok: true, balance };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// ---------------- IPC：蒸馏（Mac 版暂未提供）与 AI 问答 ----------------
const DISTILL_NA = "Mac 版暂未提供知识蒸馏（仓颉引擎仅 Windows 版内置）。可以直接在「AI 问答」里选择知识库分类提问。";
ipcMain.handle("distill:estimate", () => ({ ok: false, error: DISTILL_NA }));
ipcMain.handle("distill:run", () => ({ ok: false, error: DISTILL_NA }));
ipcMain.handle("distill:delete", () => ({ ok: false, error: DISTILL_NA }));
// AI 问答的“技能”= 知识库大类（kb:<大类>），问答时把该大类笔记摘要作为上下文
ipcMain.handle("distill:list", async () => {
  const s = loadSettings();
  const tree = await vidx.tree(s.vaultPath);
  const list = tree.categories.map((c) => {
    const n = c.groups.reduce((m, g) => m + g.subs.reduce((k, sub) => k + sub.files.length, 0), 0);
    return { name: `知识库 · ${c.name}`, path: `kb:${c.name}`, description: `基于「${c.name}」${n} 篇笔记回答`, engine: "kb", notes: n };
  }).filter((x) => x.notes > 0);
  return { ok: true, list };
});

ipcMain.handle("chat:ask", async (_e, _settings, payload) => {
  try {
    if (!payload || !payload.skillPath || !payload.question) return { ok: false, error: "缺少知识库分类或问题" };
    const s = loadSettings();
    let context;
    if (String(payload.skillPath).startsWith("kb:")) {
      const major = String(payload.skillPath).slice(3);
      const notes = await vidx.notesOfMajor(s.vaultPath, major);
      if (!notes.length) return { ok: false, error: `「${major}」下还没有笔记` };
      context = llm.buildKbContext(major, notes);
    } else if (fs.existsSync(payload.skillPath)) {
      context = fs.readFileSync(payload.skillPath, "utf8");
    } else {
      return { ok: false, error: "找不到所选的知识来源" };
    }
    const system = `你是基于用户个人知识库的 AI 助手。以下是知识库内容，请优先基于其中的知识回答；知识库没有覆盖的问题，先说明"该问题超出当前知识库范围"，再结合通用知识简要回答。回答用中文，简洁、要点式，可注明依据的笔记标题。\n\n--- 知识库内容开始 ---\n${context}\n--- 知识库内容结束 ---`;
    const messages = [{ role: "system", content: system }];
    for (const m of (payload.history || []).slice(-12)) {
      if (m && (m.role === "user" || m.role === "assistant") && m.content) messages.push({ role: m.role, content: m.content });
    }
    messages.push({ role: "user", content: payload.question });
    const r = await llm.chat(s, messages, { temperature: 0.5, timeoutMs: 120000 });
    if (!r.ok) return { ok: false, error: r.error };
    recordApiUsage(r.raw);
    return { ok: true, answer: r.content };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// ---------------- 应用内增量更新 / 按需字体 ----------------
const ofs = (() => { try { return require("original-fs"); } catch { return fs; } })(); // .asar 当普通文件写
const updateMirrors = () => loadSettings().updateMirrors;
const updater = createUpdater({ fetchImpl: (u, o) => net.fetch(u, o), fsImpl: ofs, boot: BOOT, getMirrors: updateMirrors });
const fonts = createFonts({ fetchImpl: (u, o) => net.fetch(u, o), fsImpl: fs, dir: FONTS_DIR, getMirrors: updateMirrors });
let lastCheck = null;

async function checkAndMaybeDownload({ auto } = {}) {
  const r = await updater.check();
  lastCheck = r;
  broadcast("update:status", { phase: "checked", result: stripManifest(r) });
  // 启动时自动检查：有可增量更新的新版本就直接在后台下载（几 MB），下载完提示重启
  if (auto && r.ok && r.available && !r.needsFull && !r.badBefore && !r.alreadyDownloaded && loadSettings().autoUpdate !== false) {
    await downloadUpdate(r.manifest);
  }
  return r;
}
function stripManifest(r) { if (!r) return r; const { manifest, ...rest } = r; return rest; }
async function downloadUpdate(manifest) {
  broadcast("update:progress", { pct: 0, received: 0, total: manifest.size, source: "" });
  const r = await updater.download(manifest, (p) => broadcast("update:progress", p));
  broadcast("update:status", { phase: r.ok ? "downloaded" : "error", result: r });
  return r;
}
ipcMain.handle("update:info", () => ({ ...updater.info(), lastCheck: stripManifest(lastCheck), downloading: updater.downloading }));
ipcMain.handle("update:check", async () => stripManifest(await checkAndMaybeDownload({ auto: false })));
ipcMain.handle("update:download", async () => {
  if (!lastCheck || !lastCheck.ok || !lastCheck.available) await checkAndMaybeDownload({ auto: false });
  if (!lastCheck || !lastCheck.ok) return { ok: false, error: (lastCheck && lastCheck.error) || "检查更新失败" };
  if (!lastCheck.available) return { ok: false, error: "已是最新版本" };
  if (lastCheck.needsFull) return { ok: false, needsFull: true, error: "需要下载完整安装包" };
  return downloadUpdate(lastCheck.manifest);
});
ipcMain.handle("update:restart", () => { app.relaunch(); app.exit(0); return true; });
ipcMain.handle("update:openUrl", (_e, url) => { if (/^https:\/\/github\.com\//.test(String(url))) shell.openExternal(url); return true; });

ipcMain.handle("fonts:list", () => fonts.list());
ipcMain.handle("fonts:ensure", (_e, key) => fonts.ensure(key, (p) => broadcast("fonts:progress", p)));
ipcMain.handle("fonts:read", (_e, key) => fonts.read(key));

// CI：--print-layer=<文件> 写出当前加载的应用层信息后退出；--update-now=<文件> 跑一遍真实的检查+下载后退出
async function runLoginProbe() {
  const out = {};
  const hard = setTimeout(() => { try { fs.writeFileSync(LOGIN_PROBE_FILE, JSON.stringify({ ...out, timeout: true }, null, 2)); } catch {} app.exit(0); }, 100000);
  try {
    const win = openLoginWindow({ show: false });
    const wc = win.webContents;
    for (let i = 0; i < 60 && !loginDiag.domReady; i++) await new Promise((r) => setTimeout(r, 1000));
    await new Promise((r) => setTimeout(r, 13000)); // 等首页渲染 + 自动点「登录」+ 10 秒空白检查
    out.diag = JSON.parse(JSON.stringify(loginDiag));
    out.page = await wc.executeJavaScript(dweb.PROBE_SCRIPT, true).catch((e) => ({ error: String(e) }));
    out.nav = await wc.executeJavaScript(`({ ua: navigator.userAgent, brands: (navigator.userAgentData && navigator.userAgentData.brands || []).map((b) => b.brand + "/" + b.version) })`, true).catch(() => null);
    out.expectedUa = DOUYIN_UA;
    // 模拟抖音的指纹浏览器探测：iframe / 链接 / window.open 指向 bitbrowser://
    const before = blockedSchemes.length;
    await wc.executeJavaScript(`(() => {
      const f = document.createElement("iframe"); f.style.display = "none"; f.src = "bitbrowser://cc/"; (document.body || document.documentElement).appendChild(f);
      const a = document.createElement("a"); a.href = "bitbrowser://cc/"; (document.body || document.documentElement).appendChild(a); a.click();
      try { window.open("bitbrowser://cc/"); } catch (e) {}
      return true;
    })()`, true).catch(() => {});
    await new Promise((r) => setTimeout(r, 3000));
    out.blocked = blockedSchemes.slice(before);
    out.openWindows = BrowserWindow.getAllWindows().length;
  } catch (err) {
    out.error = String((err && err.stack) || err);
  }
  clearTimeout(hard);
  try { fs.writeFileSync(LOGIN_PROBE_FILE, JSON.stringify(out, null, 2)); } catch { /* ignore */ }
  app.exit(0);
}

async function runPrintLayer() {
  const out = { version: LAYER_VERSION, source: BOOT.source, bundledVersion: BOOT.bundledVersion, electron: BOOT.electron, root: __dirname, rejected: BOOT.rejected || [] };
  const finish = (extra) => {
    try { fs.writeFileSync(PRINT_LAYER_FILE, JSON.stringify({ ...out, ...extra }, null, 2)); } catch { /* ignore */ }
    BOOT.markGood();
    app.exit(0);
  };
  const t = setTimeout(() => finish({ windowLoaded: false }), 45000);
  mainWindow.webContents.once("did-finish-load", async () => {
    let api = false;
    try { api = await mainWindow.webContents.executeJavaScript("typeof window.api === 'object' && !!document.getElementById('page-settings')", true); } catch { /* ignore */ }
    clearTimeout(t);
    finish({ windowLoaded: true, rendererOk: api });
  });
}
async function runUpdateNow() {
  let res;
  try {
    const c = await updater.check();
    res = { check: stripManifest(c) };
    if (c.ok && c.available && !c.needsFull) res.download = await updater.download(c.manifest, () => {});
  } catch (err) { res = { error: String((err && err.stack) || err) }; }
  try { fs.writeFileSync(UPDATE_NOW_FILE, JSON.stringify({ from: LAYER_VERSION, source: BOOT.source, ...res }, null, 2)); } catch { /* ignore */ }
  app.exit(0);
}

// 开源版没有会员体系：界面里的会员接口统一放行
ipcMain.handle("vip:verify", () => ({ active: true }));
ipcMain.handle("vip:issue", () => ({ ok: true, active: true }));
ipcMain.handle("vip:redeem", () => ({ ok: true, active: true }));

// ---------------- 知识库文件监听 ----------------
let vaultWatchers = [];
let vaultWatchDebounce = null;
function watchVault(vaultPath) {
  clearVaultWatchers();
  const root = vault.knowledgeRoot(vaultPath);
  if (!vaultPath || !fs.existsSync(root)) return;
  const notify = () => {
    vidx.invalidate(); // 立即作废缓存（便宜）；通知界面去抖 800 ms
    if (vaultWatchDebounce) clearTimeout(vaultWatchDebounce);
    vaultWatchDebounce = setTimeout(() => { vaultWatchDebounce = null; vaultChanged(); }, 800);
  };
  try {
    // macOS 支持递归监听
    const w = fs.watch(root, { persistent: false, recursive: true }, notify);
    w.on("error", () => {});
    vaultWatchers.push(w);
  } catch { /* ignore */ }
}
function clearVaultWatchers() {
  if (vaultWatchDebounce) { clearTimeout(vaultWatchDebounce); vaultWatchDebounce = null; }
  for (const w of vaultWatchers) { try { w.close(); } catch { /* ignore */ } }
  vaultWatchers = [];
}

// ---------------- CI 对比度检查：--contrast-check=<file> ----------------
function runContrastCheck() {
  const contrast = require("./lib/contrast");
  const CRITICAL = ["#engine-overlay .date-ask-card", "#engine-panel", "#perf-panel", "#update-panel"];
  const EXTRA = ["#first-run-overlay .date-ask-card", "#date-ask-overlay .date-ask-card", ".settings-grid .panel", ".kb-toast"];
  const hard = setTimeout(() => { console.log("CONTRAST TIMEOUT"); app.exit(2); }, 120000);
  mainWindow.webContents.once("did-finish-load", async () => {
    await new Promise((r) => setTimeout(r, 4000));
    const out = { runs: [] };
    try {
      const skins = await mainWindow.webContents.executeJavaScript("SKINS.map((s) => ({ key: s.key, light: !!s.light }))", true);
      for (const sk of skins) {
        for (const perf of [true, false]) {
          await mainWindow.webContents.executeJavaScript(`(() => {
            document.body.classList.toggle("perf", ${perf});
            applySkin(${JSON.stringify(sk.key)});
            switchPage("settings");
            const ov = document.getElementById("engine-overlay"); if (ov) ov.hidden = false;
            if (typeof toast === "function") toast("对比度检查");
            return true;
          })()`, true);
          await new Promise((r) => setTimeout(r, 400));
          const crit = await mainWindow.webContents.executeJavaScript(contrast.browserScript(CRITICAL, sk.key, sk.light), true);
          const extra = await mainWindow.webContents.executeJavaScript(contrast.browserScript(EXTRA, sk.key, sk.light), true);
          out.runs.push({ skin: sk.key, light: sk.light, perf, checked: crit.checked, failures: crit.failures, extraChecked: extra.checked, extraFailures: extra.failures });
        }
      }
    } catch (err) {
      out.error = String((err && err.stack) || err);
    }
    clearTimeout(hard);
    try { fs.writeFileSync(CONTRAST_FILE, JSON.stringify(out, null, 2)); } catch { /* ignore */ }
    app.exit(0);
  });
}

// ---------------- CI 冒烟测试：--smoke-test 启动窗口、调用一遍主要通道后退出 ----------------
function runSmokeTest() {
  const errors = [];
  const hardStop = setTimeout(() => { console.log("SMOKE TIMEOUT"); app.exit(2); }, 90000);
  mainWindow.webContents.on("console-message", (_e, level, message) => { if (level >= 3) errors.push(message); });
  mainWindow.webContents.once("did-finish-load", async () => {
    await new Promise((r) => setTimeout(r, 4000));
    try {
      const out = await mainWindow.webContents.executeJavaScript(`(async () => {
        const a = window.api, s = await a.getSettings();
        const r = {};
        const calls = {
          stats: () => a.statsOverview(s), tree: () => a.vaultTree(s.vaultPath), sched: () => a.scheduleStatus(s),
          engine: () => a.engineStatus(), auth: () => a.authStatus(s), cards: () => a.cardsList(s), kb: () => a.distillList(s),
          fail: () => a.failuresList(s), news: () => a.newArrivals(s, { days: 7 }), weekly: () => a.weeklyStats(s),
          pause: () => a.pauseStatus(s), cat: () => a.categoriesManage(s, ["frobnicate"]), distill: () => a.distillRun(s, {}),
          run: () => a.runPipeline(s, ["sync"]), graph: () => a.vaultGraph(s), search: () => a.vaultSearch(s, "x"),
        };
        for (const [k, f] of Object.entries(calls)) {
          try { const v = await f(); r[k] = v && typeof v === "object" ? (v.ok === false ? "ok:false " + (v.error || v.message || "") : "ok") : String(v); }
          catch (e) { r[k] = "THROW " + e.message; }
        }
        r.page = document.querySelector(".nav-item.active") ? document.querySelector(".nav-item.active").textContent.trim() : "none";
        r.engineOverlay = !!document.getElementById("engine-overlay");
        return r;
      })()`, true);
      console.log("SMOKE RESULT " + JSON.stringify(out));
      const thrown = Object.entries(out).filter(([, v]) => String(v).startsWith("THROW"));
      if (errors.length) console.log("SMOKE RENDERER ERRORS " + JSON.stringify(errors));
      clearTimeout(hardStop);
      app.exit(thrown.length || errors.length || !out.engineOverlay ? 1 : 0);
    } catch (err) {
      console.log("SMOKE FAILED " + (err && err.stack || err));
      app.exit(1);
    }
  });
}

// ---------------- 启动 ----------------
if (gotLock) {
  app.whenReady().then(async () => {
    fs.mkdirSync(VAR_DIR, { recursive: true });
    const s = loadSettings();
    if (!fs.existsSync(SETTINGS_FILE)) { try { saveSettings({ asrEngine: s.asrEngine }); } catch { /* ignore */ } } // 新安装锁定默认引擎
    probeShellHfEnv().catch(() => {});
    ensureVaultDir(s);
    if (SCHEDULED) {
      if (app.dock) app.dock.hide();
      await runScheduledSync();
      if (!mainWindow) app.quit();
      return;
    }
    if (UPDATE_NOW_FILE) { await runUpdateNow(); return; }
    if (LOGIN_PROBE_FILE) { await runLoginProbe(); return; }
    createWindow();
    if (PRINT_LAYER_FILE) { runPrintLayer(); return; }
    watchVault(s.vaultPath);
    if (CONTRAST_FILE) runContrastCheck();
    else if (process.argv.includes("--smoke-test")) runSmokeTest();
    else if (!process.argv.includes("--no-update-check")) setTimeout(() => { checkAndMaybeDownload({ auto: true }).catch(() => {}); }, 6000);
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on("window-all-closed", () => {
    // 定时任务进程没有窗口：任务结束由 runScheduledSync 退出；普通模式按 macOS 习惯保留在 Dock
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    if (currentJob) {
      currentJob.cancelled = true;
      if (currentJob.child) { try { currentJob.child.kill("SIGTERM"); } catch { /* ignore */ } }
      st.releaseLock(LOCK_FILE);
    }
  });
}
