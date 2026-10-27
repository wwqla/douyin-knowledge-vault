"use strict";
// 处理状态（state.json）、同步锁、暂停开关、处理窗口与 worker 事件翻译（纯 Node，可单测）
const fs = require("fs");
const path = require("path");

const DONE = new Set(["written", "skipped"]);
const STALE_LOCK_MS = 6 * 3600 * 1000;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

class StateStore {
  constructor(file) {
    this.file = file;
    this.data = readJson(file, null) || { items: {}, countSnapshot: null };
    if (!this.data.items) this.data.items = {};
  }
  reload() {
    this.data = readJson(this.file, null) || this.data;
    if (!this.data.items) this.data.items = {};
    return this;
  }
  save() { writeJsonAtomic(this.file, this.data); }
  get(key) { return this.data.items[key] || null; }
  all() { return Object.values(this.data.items); }

  /** 采集到的条目入库：已存在只更新元数据，不动状态 */
  upsertDiscovered(item, folder) {
    const key = item.aweme_id || item.key || item.source_url;
    const now = new Date().toISOString();
    const cur = this.data.items[key];
    if (cur) {
      if (item.title && (!cur.title || /^抖音收藏 \d+$/.test(cur.title))) cur.title = item.title;
      if (item.create_time && !cur.create_time) cur.create_time = item.create_time;
      if (folder && !cur.folder) cur.folder = folder;
      return { item: cur, added: false };
    }
    const rec = {
      key,
      aweme_id: item.aweme_id || "",
      url: item.source_url || item.url,
      title: item.title || "",
      author: item.author || "",
      folder: folder || "",
      create_time: Number(item.create_time || 0),
      discovered_at: now,
      status: "discovered",
      stage: "",
      error: "",
      note: "",
      category: "", group: "", subcategory: "",
      attempts: 0,
      updated_at: now,
    };
    this.data.items[key] = rec;
    return { item: rec, added: true };
  }

  update(key, patch) {
    const cur = this.data.items[key];
    if (!cur) return null;
    Object.assign(cur, patch, { updated_at: new Date().toISOString() });
    return cur;
  }

  counts(filter) {
    const c = {};
    for (const it of this.all()) {
      if (filter && !filter(it)) continue;
      c[it.status] = (c[it.status] || 0) + 1;
    }
    return c;
  }

  /** 按数量模式：锁定“从目前往后数 N 条”快照（orderedKeys 为最新在前的收藏顺序） */
  ensureCountSnapshot(limit, orderedKeys) {
    const snap = this.data.countSnapshot;
    if (snap && snap.limit === limit && Array.isArray(snap.ids) && snap.ids.length) return snap;
    if (!orderedKeys || !orderedKeys.length) return snap || null;
    this.data.countSnapshot = { limit, ids: orderedKeys.slice(0, limit), takenAt: new Date().toISOString() };
    return this.data.countSnapshot;
  }
  clearCountSnapshot() { this.data.countSnapshot = null; }
}

/** 处理窗口过滤器：time = 视频发布时间 ≥ 起始日期；count = 快照内；all = 全部 */
function windowFilter(settings, store) {
  const mode = settings.processMode;
  if (mode === "count" && Number(settings.countLimit) > 0) {
    const snap = store.data.countSnapshot;
    if (!snap || !Array.isArray(snap.ids)) return () => true;
    const ids = new Set(snap.ids);
    return (it) => ids.has(it.key) || it.folder === "手动添加";
  }
  if (mode !== "all" && settings.startDate) {
    const t = Date.parse(settings.startDate + "T00:00:00");
    if (!Number.isNaN(t)) {
      const sec = t / 1000;
      return (it) => !it.create_time || it.create_time >= sec || it.folder === "手动添加";
    }
  }
  return () => true;
}

function pendingOf(store, filter) {
  return store.all()
    .filter((it) => !DONE.has(it.status) && (!filter || filter(it)))
    .filter((it) => !(it.status === "failed" && Number(it.attempts || 0) >= 3))
    .sort((a, b) => (b.create_time || 0) - (a.create_time || 0));
}

// ---------------- 同步锁（与 Windows 版 var\sync.lock 同语义） ----------------
function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
function readLock(file) {
  if (!fs.existsSync(file)) return null;
  return readJson(file, { pid: -1, createdAt: 0 });
}
/** 取锁：活着且未过 6 小时 → 抛错；否则清掉残留锁并返回提示 */
function acquireLock(file, pid = process.pid) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let note = "";
  const info = readLock(file);
  if (info) {
    const age = Date.now() - Number(info.createdAt || 0);
    const alive = pidAlive(Number(info.pid)) && Number(info.pid) !== pid;
    if (alive && age <= STALE_LOCK_MS) {
      const e = new Error(`已有处理任务在运行（PID ${info.pid}），请等它结束或在流水线页暂停`);
      e.code = "LOCK_BUSY";
      throw e;
    }
    fs.rmSync(file, { force: true });
    note = `STALE-LOCK-CLEARED age=${Math.round(age / 60000)}min alive=${alive}`;
  }
  fs.writeFileSync(file, JSON.stringify({ pid, createdAt: Date.now() }), { flag: "wx" });
  return note;
}
function releaseLock(file, pid = process.pid) {
  const info = readLock(file);
  if (info && Number(info.pid) === pid) fs.rmSync(file, { force: true });
}

// ---------------- worker JSON Lines → 中文日志 ----------------
const STAGE_TEXT = {
  download: "↓ 下载音频",
  transcribe: "🎙 本地语音转写",
  extract: "🧠 AI 提炼知识",
  write: "📝 写入笔记",
  model_download: "⬇ 下载 Whisper 模型（只需一次）",
};
const STATUS_TEXT = { written: "已生成笔记", skipped: "已跳过", failed: "失败", media_frozen: "已跳过（无可用语音）" };

function friendlyError(msg) {
  const s = String(msg || "");
  const rules = [
    [/LLM API key is not set/i, "没有填写 API Key（设置 → AI 接口配置）"],
    [/LLM HTTP 401/i, "API Key 无效或已过期（401）"],
    [/LLM HTTP 402|insufficient.?balance|余额不足/i, "API Key 余额不足，请充值后重试"],
    [/LLM HTTP 404/i, "AI 接口地址不对（404），检查 Base URL 是否以 /v1 结尾"],
    [/LLM HTTP 429/i, "AI 接口限流（429），稍后重试"],
    [/LLM request failed/i, "连不上 AI 接口，请检查网络"],
    [/Fresh cookies|cookies? (are|is) needed|login required|需要登录/i, "抖音要求登录 Cookie：请到设置页重新扫码登录"],
    [/HTTP Error 403|403: Forbidden/i, "抖音拒绝下载（403）：请重新扫码登录后重试"],
    [/Unable to download|Unable to extract|Unsupported URL/i, "无法下载该视频（可能已删除、私密或不是视频）"],
    [/media must contain complete audio stream/i, "视频没有音轨"],
    [/transcription produced no usable text|does not cover enough/i, "没有可识别的人声（纯音乐/无语音）"],
    [/contentType: "ad"/i, "广告/带货内容"],
    [/contentType: "shortdrama"/i, "短剧片段"],
    [/contentType: "music"/i, "音乐/无信息量内容"],
    [/keyPoints is empty/i, "没有可提炼的知识点"],
    [/vault path is not set/i, "还没设置知识库路径"],
    [/No module named|ModuleNotFoundError/i, "处理组件不完整，请在设置页重新安装处理组件"],
    [/sync already running/i, "另一个处理进程正在运行"],
  ];
  for (const [re, zh] of rules) if (re.test(s)) return s && zh !== s ? `${zh}（${s.slice(0, 160)}）` : zh;
  return s;
}

/** 把一行 worker 事件翻译成日志文本（返回 "" 表示不显示）。progressState 用于节流进度 */
function formatEvent(ev, progressState = {}) {
  if (!ev || typeof ev !== "object") return "";
  switch (ev.event) {
    case "stage": {
      const t = STAGE_TEXT[ev.stage];
      if (!t) return "";
      const key = ev.stage + "|" + (ev.title || "");
      if (progressState.lastStage === key) return "";
      progressState.lastStage = key;
      return `  ${t}…\n`;
    }
    case "progress": {
      if (!ev.total) return "";
      const pct = Math.floor((Number(ev.done) / Number(ev.total)) * 100);
      const bucket = ev.stage + ":" + Math.floor(pct / 10);
      if (progressState.lastBucket === bucket) return "";
      progressState.lastBucket = bucket;
      if (ev.stage === "model_download") {
        return `    模型下载 ${pct}%（${(ev.done / 1048576).toFixed(0)}/${(ev.total / 1048576).toFixed(0)} MB）\n`;
      }
      return `    ${ev.stage === "transcribe" ? "转写" : ev.stage} ${pct}%\n`;
    }
    case "log":
      if (ev.level === "error") return "";  // item_done 会给出最终错误
      return ev.level === "warn" ? `  ⚠ ${friendlyError(ev.message)}\n` : "";
    case "retry":
      return `  ↻ 处理失败，${Math.round(ev.delay || 0)} 秒后自动重试一次…\n`;
    case "item_done": {
      const st = STATUS_TEXT[ev.status] || ev.status;
      if (ev.status === "written") return `  ✓ ${st}${ev.note ? "：" + ev.note : ""}\n`;
      return `  ${ev.status === "failed" ? "✗" : "↷"} ${st}${ev.error ? "：" + friendlyError(ev.error) : ""}\n`;
    }
    case "error":
      return `  ✗ ${ev.code === "lock_busy" ? "另一个处理进程正在运行，请稍后" : friendlyError(ev.message)}\n`;
    case "model_ready":
      return "  ✓ Whisper 模型已就绪\n";
    default:
      return "";
  }
}

/** 按行切分流式输出，逐行回调 JSON 或原文 */
function lineSplitter(onLine) {
  let buf = "";
  return {
    push(chunk) {
      buf += String(chunk);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
    },
    flush() { const l = buf.trim(); buf = ""; if (l) onLine(l); },
  };
}

function parseEventLine(line) {
  if (!line.startsWith("{")) return null;
  try { return JSON.parse(line); } catch { return null; }
}

/** 止损看板：按日期汇总失败/跳过条目，生成 Markdown 清单 */
function failureReports(items) {
  const byDay = new Map();
  for (const it of items) {
    if (!["failed", "skipped", "media_frozen"].includes(it.status)) continue;
    const day = String(it.updated_at || it.discovered_at || "").slice(0, 10) || "未知日期";
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(it);
  }
  const files = [];
  for (const [day, list] of byDay) {
    const failed = list.filter((x) => x.status === "failed");
    const skipped = list.filter((x) => x.status !== "failed");
    const line = (x) => `- [${(x.title || x.aweme_id || x.url).replace(/[[\]]/g, "")}](${x.url})${x.error ? " — " + friendlyError(x.error).slice(0, 160) : ""}`;
    const md = [
      `# 失败视频清单 ${day}`,
      "",
      `## 处理失败（${failed.length}）`,
      "",
      ...(failed.length ? failed.map(line) : ["- 无"]),
      "",
      "失败条目会在下次处理时自动重试，最多 3 次。",
      "",
      `## 已跳过（${skipped.length}）`,
      "",
      ...(skipped.length ? skipped.map(line) : ["- 无"]),
      "",
    ].join("\n");
    const mtime = list.map((x) => x.updated_at || "").sort().pop() || new Date().toISOString();
    files.push({ name: `失败视频清单-${day}.md`, mtime, content: md });
  }
  files.sort((a, b) => b.name.localeCompare(a.name));
  return files;
}

module.exports = {
  StateStore, windowFilter, pendingOf, DONE,
  pidAlive, readLock, acquireLock, releaseLock, STALE_LOCK_MS,
  friendlyError, formatEvent, lineSplitter, parseEventLine, failureReports, readJson, writeJsonAtomic,
};
