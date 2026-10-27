"use strict";
// node --test mac/test   （不依赖 Electron）
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const douyin = require("../lib/douyin");
const launchd = require("../lib/launchd");
const st = require("../lib/state");
const vault = require("../lib/vault");
const llm = require("../lib/llm");

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "dkv-"));

// ---------- 采集字段映射 ----------
test("toStoreItem maps fields like collect-favorites.py", () => {
  const it = douyin.toStoreItem({
    aweme_id: "7312345678901234567", description: "定投的三个误区\n#理财 #基金", author: "老王", author_sec_uid: "MS4w",
    duration_seconds: 63.5, create_time: 1700000000.9, likes: "12", collects: 3, comments: 4, shares: 5, play_url: " https://v/1 ",
  }, "2026-10-27T00:00:00+00:00");
  assert.equal(it.aweme_id, "7312345678901234567");
  assert.equal(it.title, "定投的三个误区");
  assert.equal(it.source_url, "https://www.douyin.com/video/7312345678901234567");
  assert.equal(it.create_time, 1700000000);
  assert.equal(it.likes, 12);
  assert.equal(it.duration, 63.5);
  assert.equal(it.play_url, "https://v/1");
});

test("toStoreItem rejects bad ids and titles empty descriptions", () => {
  assert.equal(douyin.toStoreItem({ aweme_id: "abc" }, ""), null);
  assert.equal(douyin.toStoreItem({ aweme_id: "12345" }, ""), null);
  assert.equal(douyin.toStoreItem({ aweme_id: "1234567" }, "").title, "抖音收藏 1234567");
});

test("collectPaged follows cursors, dedupes and stops at max", async () => {
  const pages = {
    0: { ok: true, cursor: 10, has_more: true, items: [{ aweme_id: "1000001" }, { aweme_id: "1000002" }] },
    10: { ok: true, cursor: 20, has_more: true, items: [{ aweme_id: "1000002" }, { aweme_id: "1000003" }] },
    20: { ok: true, cursor: 30, has_more: false, items: [{ aweme_id: "1000004" }] },
  };
  const calls = [];
  const items = await douyin.collectPaged({
    fetchPage: async ({ cursor, count }) => { calls.push([cursor, count]); return pages[cursor]; },
    maxItems: 100, mapItem: (r) => douyin.toStoreItem(r, "t"), keyOf: (x) => x.aweme_id, sleep: async () => {},
  });
  assert.deepEqual(items.map((x) => x.aweme_id), ["1000001", "1000002", "1000003", "1000004"]);
  assert.deepEqual(calls.map((c) => c[0]), [0, 10, 20]);
  const capped = await douyin.collectPaged({
    fetchPage: async ({ cursor }) => pages[cursor], maxItems: 3,
    mapItem: (r) => douyin.toStoreItem(r, "t"), keyOf: (x) => x.aweme_id, sleep: async () => {},
  });
  assert.equal(capped.length, 3);
});

test("collectPaged reports Chinese errors for login failures and stuck cursors", async () => {
  await assert.rejects(douyin.collectPaged({
    fetchPage: async () => ({ ok: false, status_code: 8 }), maxItems: 5, mapItem: (x) => x, keyOf: (x) => x, sleep: async () => {},
  }), /登录已失效/);
  await assert.rejects(douyin.collectPaged({
    fetchPage: async () => ({ ok: false, empty: true }), maxItems: 5, mapItem: (x) => x, keyOf: (x) => x, sleep: async () => {},
  }), /空数据/);
  await assert.rejects(douyin.collectPaged({
    fetchPage: async () => ({ ok: true, cursor: 0, has_more: true, items: [{ aweme_id: "1000001" }] }),
    maxItems: 5, mapItem: (r) => douyin.toStoreItem(r, "t"), keyOf: (x) => x.aweme_id, sleep: async () => {},
  }), /游标/);
});

test("buildFetchScript produces valid JS that maps the Douyin response", async () => {
  for (const kind of ["favorites", "folders", "folderVideos"]) {
    const src = douyin.buildFetchScript(kind, { cursor: 5, count: 20, collectsId: "77" });
    assert.doesNotThrow(() => new vm.Script(src), kind);
  }
  // 在沙箱里模拟页面 fetch，验证请求参数与字段映射
  let seen = null;
  const ctx = vm.createContext({
    URLSearchParams, navigator: { cookieEnabled: true, language: "zh-CN", platform: "MacIntel" },
    fetch: async (url, init) => {
      seen = { url, init };
      return { ok: true, text: async () => JSON.stringify({ status_code: 0, cursor: 99, has_more: 1, aweme_list: [
        { aweme_id: 7300000000000000001, desc: "标题", author: { nickname: "作者", sec_uid: "s" }, video: { duration: 61000, play_addr: { url_list: ["u1"] } }, create_time: 1700000000, statistics: { digg_count: 9 } },
      ] }) };
    },
  });
  const res = await vm.runInContext(douyin.buildFetchScript("favorites", { cursor: 5, count: 20 }), ctx);
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.credentials, "include");
  assert.match(seen.url, /listcollection\/\?device_platform=webapp&aid=6383/);
  assert.equal(seen.init.body, "count=20&cursor=5");
  assert.equal(res.ok, true);
  assert.equal(res.cursor, 99);
  assert.equal(res.items[0].author, "作者");
  assert.equal(res.items[0].duration_seconds, 61);
  assert.equal(res.items[0].likes, 9);

  const res2 = await vm.runInContext(douyin.buildFetchScript("folderVideos", { cursor: 0, count: 10, collectsId: "42" }), ctx);
  assert.equal(seen.init.method, "GET");
  assert.match(seen.url, /collects\/video\/list\/.*collects_id=42/);
  assert.equal(res2.items.length, 1);
});

// ---------- Cookie 导出 ----------
test("toNetscapeCookies writes yt-dlp compatible lines", () => {
  const txt = douyin.toNetscapeCookies([
    { name: "sessionid", value: "abc", domain: ".douyin.com", path: "/", secure: true, httpOnly: true, expirationDate: 1893456000.5, hostOnly: false },
    { name: "ttwid", value: "t\tw", domain: "www.douyin.com", path: "/", secure: false, httpOnly: false, session: true, hostOnly: true },
    { name: "x", value: "1", domain: "douyin.com", hostOnly: false },
  ]);
  const lines = txt.trim().split("\n");
  assert.equal(lines[0], "# Netscape HTTP Cookie File");
  assert.ok(lines.includes("#HttpOnly_.douyin.com\tTRUE\t/\tTRUE\t1893456000\tsessionid\tabc"));
  assert.ok(lines.includes("www.douyin.com\tFALSE\t/\tFALSE\t0\tttwid\ttw"));
  assert.ok(lines.includes(".douyin.com\tTRUE\t/\tFALSE\t0\tx\t1"));
  for (const l of lines.filter((x) => x && !x.startsWith("# "))) assert.equal(l.split("\t").length, 7);
});

test("session cookie detection and domain filter", () => {
  const now = 1800000000;
  assert.equal(douyin.hasSessionCookie([{ name: "sessionid", value: "v", expirationDate: now + 10 }], now), true);
  assert.equal(douyin.hasSessionCookie([{ name: "sessionid", value: "v", expirationDate: now - 10 }], now), false);
  assert.equal(douyin.hasSessionCookie([{ name: "ttwid", value: "v" }], now), false);
  assert.equal(douyin.isDouyinCookie({ domain: ".douyin.com" }), true);
  assert.equal(douyin.isDouyinCookie({ domain: "www.iesdouyin.com" }), true);
  assert.equal(douyin.isDouyinCookie({ domain: ".notdouyin.com" }), false);
});

test("parseShareInput extracts URLs and ids from share text", () => {
  assert.deepEqual(douyin.parseShareInput("7.43 复制打开抖音，看看【老王的作品】定投 https://v.douyin.com/iRNBho6u/ 你好"),
    { url: "https://v.douyin.com/iRNBho6u/", aweme_id: "" });
  assert.deepEqual(douyin.parseShareInput("https://www.douyin.com/video/7312345678901234567?previous_page=x"),
    { url: "https://www.douyin.com/video/7312345678901234567", aweme_id: "7312345678901234567" });
  assert.deepEqual(douyin.parseShareInput("https://www.douyin.com/user/self?modal_id=7312345678901234567"),
    { url: "https://www.douyin.com/video/7312345678901234567", aweme_id: "7312345678901234567" });
  assert.equal(douyin.parseShareInput("没有链接"), null);
});

// ---------- launchd ----------
test("launchd plist daily / weekly and next run", () => {
  const daily = launchd.buildPlist({ program: "/Applications/抖音知识库.app/Contents/MacOS/抖音知识库", args: ["--scheduled-sync"], hour: 8, minute: 5, weekday: 0, logPath: "/tmp/a&b.log" });
  assert.match(daily, /<key>Label<\/key><string>com\.douyin\.knowledge\.sync<\/string>/);
  assert.match(daily, /<string>--scheduled-sync<\/string>/);
  assert.doesNotMatch(daily, /Weekday/);
  assert.match(daily, /a&amp;b\.log/);
  assert.deepEqual(launchd.parsePlistSchedule(daily), { hour: 8, minute: 5, weekday: 0 });
  const weekly = launchd.buildPlist({ program: "/x", hour: 21, minute: 30, weekday: 7 });
  assert.match(weekly, /<key>Weekday<\/key><integer>0<\/integer>/); // 周日 → 0
  assert.deepEqual(launchd.parsePlistSchedule(weekly), { hour: 21, minute: 30, weekday: 7 });
  const now = new Date(2026, 9, 27, 9, 0, 0); // 周二 09:00
  assert.equal(launchd.fmtLocal(launchd.nextRun({ hour: 8, minute: 0, weekday: 0 }, now)), "2026-10-28 08:00:00");
  assert.equal(launchd.fmtLocal(launchd.nextRun({ hour: 10, minute: 0, weekday: 0 }, now)), "2026-10-27 10:00:00");
  assert.equal(launchd.fmtLocal(launchd.nextRun({ hour: 8, minute: 0, weekday: 1 }, now)), "2026-11-02 08:00:00");
});

// ---------- 状态 / 窗口 / 锁 ----------
test("state store: upsert keeps status, windows filter by mode", () => {
  const d = tmpdir();
  const store = new st.StateStore(path.join(d, "state.json"));
  const mk = (id, t) => douyin.toStoreItem({ aweme_id: id, description: "v" + id, create_time: t }, "now");
  assert.equal(store.upsertDiscovered(mk("1000001", Date.parse("2026-01-10") / 1000)).added, true);
  store.upsertDiscovered(mk("1000002", Date.parse("2025-06-01") / 1000));
  store.upsertDiscovered(mk("1000003", Date.parse("2026-03-01") / 1000));
  store.update("1000001", { status: "written" });
  assert.equal(store.upsertDiscovered(mk("1000001", 0)).added, false);
  assert.equal(store.get("1000001").status, "written");
  store.save();
  const re = new st.StateStore(path.join(d, "state.json"));
  assert.equal(re.all().length, 3);

  const timeF = st.windowFilter({ processMode: "time", startDate: "2026-01-01" }, re);
  assert.deepEqual(st.pendingOf(re, timeF).map((x) => x.key), ["1000003"]);
  assert.deepEqual(st.pendingOf(re, st.windowFilter({ processMode: "all", startDate: "2026-01-01" }, re)).map((x) => x.key), ["1000003", "1000002"]);
  re.ensureCountSnapshot(2, ["1000003", "1000001", "1000002"]);
  const countF = st.windowFilter({ processMode: "count", countLimit: 2 }, re);
  assert.deepEqual(re.all().filter(countF).map((x) => x.key).sort(), ["1000001", "1000003"]);
  assert.deepEqual(re.counts(countF), { written: 1, discovered: 1 });
  // 失败 3 次后不再自动重试
  re.update("1000003", { status: "failed", attempts: 3 });
  assert.deepEqual(st.pendingOf(re, countF), []);
});

test("sync lock: busy when alive, stale lock cleared", () => {
  const d = tmpdir();
  const f = path.join(d, "var", "sync.lock");
  assert.equal(st.acquireLock(f, 111111), "");
  // 当前进程持有锁 → 另一个 pid 取锁应失败
  fs.writeFileSync(f, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
  assert.throws(() => st.acquireLock(f, 222222), /已有处理任务在运行/);
  // 进程不存在 → 清掉残留锁
  fs.writeFileSync(f, JSON.stringify({ pid: 999999, createdAt: Date.now() - 60000 }));
  assert.match(st.acquireLock(f, 333333), /STALE-LOCK-CLEARED/);
  st.releaseLock(f, 333333);
  assert.equal(fs.existsSync(f), false);
});

test("worker events are translated to Chinese log lines", () => {
  const s = {};
  assert.equal(st.formatEvent({ event: "stage", stage: "download" }, s), "  ↓ 下载音频…\n");
  assert.equal(st.formatEvent({ event: "stage", stage: "download" }, s), "");
  assert.match(st.formatEvent({ event: "item_done", status: "written", note: "/v/a.md" }, s), /✓ 已生成笔记：\/v\/a\.md/);
  assert.match(st.formatEvent({ event: "item_done", status: "failed", error: "ExtractError: LLM API key is not set (x)" }, s), /没有填写 API Key/);
  assert.match(st.formatEvent({ event: "item_done", status: "skipped", error: 'contentType: "ad"' }, s), /广告/);
  assert.match(st.formatEvent({ event: "progress", stage: "model_download", done: 524288000, total: 1048576000 }, s), /模型下载 50%/);
  assert.match(st.formatEvent({ event: "retry", delay: 30 }, s), /30 秒后自动重试/);
  const lines = [];
  const sp = st.lineSplitter((l) => lines.push(l));
  sp.push('{"event":"st'); sp.push('age"}\n{"a":1}\npartial'); sp.flush();
  assert.deepEqual(lines, ['{"event":"stage"}', '{"a":1}', "partial"]);
  assert.equal(st.parseEventLine("PROGRESS 5 x"), null);
});

test("failure reports group failed and skipped items by day", () => {
  const files = st.failureReports([
    { status: "failed", title: "A", url: "https://a", error: "LLM HTTP 401: bad", updated_at: "2026-10-27T01:00:00Z" },
    { status: "skipped", title: "B", url: "https://b", error: 'contentType: "shortdrama"', updated_at: "2026-10-27T02:00:00Z" },
    { status: "written", title: "C", url: "https://c", updated_at: "2026-10-26T02:00:00Z" },
  ]);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "失败视频清单-2026-10-27.md");
  assert.match(files[0].content, /处理失败（1）[\s\S]*API Key 无效[\s\S]*已跳过（1）[\s\S]*短剧/);
});

// ---------- 知识库 ----------
function sampleVault() {
  const v = tmpdir();
  const dir = path.join(v, "Knowledge", "抖音收藏", "投资理财", "指数基金");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "定投误区.md"), [
    "---", 'title: "定投误区"', 'collected_folder: "抖音收藏"', 'category: "投资理财/指数基金"', "tags:", "  - 定投", "  - 基金", "---", "",
    "# 定投误区", "", "> 定投不是越跌越买。", "", "## 关键观点", "", "1. **定投要看估值**", "    - 依据：PE", "2. **设置止盈**", "", "## 原文转写", "", "> [!note]- 展开转写稿", "> 你好", "",
  ].join("\n"));
  return v;
}

test("vault tree / search / parseNote", () => {
  const v = sampleVault();
  const tree = vault.vaultTree(v);
  assert.equal(tree.categories[0].name, "抖音收藏");
  assert.deepEqual(tree.categories[0].groups[0].subs[0].files, ["定投误区.md"]);
  assert.equal(vault.search(v, "止盈").results.length, 1);
  const notes = vault.notesOfMajor(v, "抖音收藏");
  assert.equal(notes[0].summary, "定投不是越跌越买。");
  assert.deepEqual(notes[0].points, ["定投要看估值", "设置止盈"]);
  assert.deepEqual(notes[0].tags, ["定投", "基金"]);
  assert.equal(notes[0].group, "投资理财");
  assert.deepEqual(vault.categoryOfPath(v, path.join(v, "Knowledge", "抖音收藏", "投资理财", "指数基金", "定投误区.md")),
    { major: "抖音收藏", group: "投资理财", sub: "指数基金" });
});

test("categories manage: add / rename / move / delete", () => {
  const v = sampleVault();
  const K = path.join(v, "Knowledge");
  assert.equal(vault.manageCategories(v, ["add", "major", "学习"]).ok, true);
  assert.equal(vault.manageCategories(v, ["add", "major", "学习"]).ok, false);
  assert.equal(vault.manageCategories(v, ["add", "sub", "学习", "英语", "口语"]).ok, true);
  assert.ok(fs.existsSync(path.join(K, "学习", "英语", "口语")));
  assert.equal(vault.manageCategories(v, ["rename", "group", "抖音收藏", "投资理财", "理财"]).ok, true);
  const moved = path.join(K, "抖音收藏", "理财", "指数基金", "定投误区.md");
  assert.match(fs.readFileSync(moved, "utf8"), /category: "理财\/指数基金"/);
  const r = vault.manageCategories(v, ["move", moved, "学习", "英语", "口语"]);
  assert.equal(r.ok, true);
  const txt = fs.readFileSync(r.path, "utf8");
  assert.match(txt, /category: "英语\/口语"/);
  assert.match(txt, /collected_folder: "学习"/);
  assert.equal(vault.manageCategories(v, ["delete", "major", "../../etc"]).ok, false);
  assert.equal(vault.manageCategories(v, ["delete", "major", "抖音收藏"]).ok, true);
  assert.equal(fs.existsSync(path.join(K, "抖音收藏")), false);
  assert.match(vault.manageCategories(v, ["frobnicate"]).error, /不支持/);
});

// ---------- AI ----------
test("llm.chat handles missing key, errors and json fallback", async () => {
  assert.match((await llm.chat({ llmBaseUrl: "https://x/v1" }, [])).error, /API Key/);
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.response_format) return { ok: false, status: 400, text: async () => "response_format not supported" };
    return { ok: true, json: async () => ({ choices: [{ message: { content: '```json\n{"summary":"s"}\n```' } }], usage: { total_tokens: 5 } }) };
  };
  const r = await llm.chat({ llmBaseUrl: "https://x/v1/", llmApiKey: "k" }, [{ role: "user", content: "hi" }], { json: true, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(llm.parseJsonLoose(r.content), { summary: "s" });
  const r402 = await llm.chat({ llmBaseUrl: "https://x", llmApiKey: "k" }, [], { fetchImpl: async () => ({ ok: false, status: 402, text: async () => "Insufficient Balance" }) });
  assert.match(r402.error, /余额不足/);
});

test("normalizeCard fills the shape the renderer expects", () => {
  const c = llm.normalizeCard({ summary: "s", consensus_points: [{ title: "t", statement: "x", source_videos: ["a", "b"] }], table: { rows: [{ topic: "q", verdict: "v" }] } }, "抖音收藏", 60);
  assert.equal(c.major, "抖音收藏");
  assert.equal(c.count, 60);
  assert.equal(c.consensus_points[0].confirmed_by, 2);
  assert.deepEqual(c.mindmap, { root: "抖音收藏", children: [] });
  assert.deepEqual(c.network, { nodes: [], links: [] });
  assert.equal(c.table.rows.length, 1);
  assert.ok(c.generatedAt);
});
