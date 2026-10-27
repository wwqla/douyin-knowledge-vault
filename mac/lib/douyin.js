"use strict";
// 抖音收藏采集：接口地址、页面内 fetch 脚本、字段映射、游标翻页、Cookie 导出。
// 移植自 scripts/collect-favorites.py（Playwright 版），这里不依赖 Electron，便于 node 单元测试。

const COLLECTION_PAGE_URL = "https://www.douyin.com/user/self?showTab=favorite_collection";
const COLLECTION_API_URL = "https://www.douyin.com/aweme/v1/web/aweme/listcollection/";
const COLLECTS_LIST_API_URL = "https://www.douyin.com/aweme/v1/web/collects/list/";
const COLLECTS_VIDEO_API_URL = "https://www.douyin.com/aweme/v1/web/collects/video/list/";
const DETAIL_API_URL = "https://www.douyin.com/aweme/v1/web/aweme/detail/";
const SESSION_COOKIE_NAMES = new Set(["sessionid", "sessionid_ss", "sid_guard"]);
const AWEME_ID = /^[0-9]{6,30}$/;
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// 页面上下文里执行的公共参数 + 视频字段映射（与 Python 版 FETCH_JS 一致）
const PAGE_HELPERS = `
  const baseParams = () => new URLSearchParams({
    device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web',
    cookie_enabled: String(navigator.cookieEnabled),
    browser_language: navigator.language || 'zh-CN',
    browser_platform: navigator.platform || '', browser_name: 'Chrome',
  });
  const mapVideo = (item) => ({
    aweme_id: String(item.aweme_id || ''),
    description: item.desc || '',
    author: item.author ? item.author.nickname || '' : '',
    author_sec_uid: item.author ? item.author.sec_uid || '' : '',
    play_url: item.video && item.video.play_addr && item.video.play_addr.url_list ? item.video.play_addr.url_list[0] || '' : '',
    duration_seconds: Number(item.video && item.video.duration || 0) / 1000,
    create_time: Number(item.create_time || 0),
    likes: Number((item.statistics && item.statistics.digg_count) || 0),
    collects: Number((item.statistics && item.statistics.collect_count) || 0),
    comments: Number((item.statistics && item.statistics.comment_count) || 0),
    shares: Number((item.statistics && item.statistics.share_count) || 0),
  });
  const readJson = async (response) => {
    if (!response.ok) return { ok: false, http_status: response.status };
    const text = await response.text();
    if (!text) return { ok: false, empty: true };
    try { return { ok: true, data: JSON.parse(text) }; } catch (e) { return { ok: false, bad_json: true }; }
  };
`;

/** 生成在抖音页面里执行的脚本（返回 Promise<结果对象>）。kind: favorites | folders | folderVideos */
function buildFetchScript(kind, { cursor = 0, count = 20, collectsId = "", awemeId = "" } = {}) {
  const args = JSON.stringify({ cursor: Number(cursor) || 0, count: Number(count) || 20, collectsId: String(collectsId || ""), awemeId: String(awemeId || "") });
  let body;
  if (kind === "favorites") {
    body = `
      const params = baseParams();
      const r = await readJson(await fetch(${JSON.stringify(COLLECTION_API_URL)} + '?' + params.toString(), {
        method: 'POST', credentials: 'include',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({count: String(a.count), cursor: String(a.cursor)}).toString(),
      }));
      if (!r.ok) return r;
      const data = r.data;
      return { ok: data.status_code === 0, status_code: data.status_code, cursor: Number(data.cursor || 0),
               has_more: Boolean(data.has_more), items: (data.aweme_list || []).map(mapVideo) };`;
  } else if (kind === "folderVideos") {
    body = `
      const params = baseParams();
      params.set('collects_id', a.collectsId); params.set('cursor', String(a.cursor)); params.set('count', String(a.count));
      const r = await readJson(await fetch(${JSON.stringify(COLLECTS_VIDEO_API_URL)} + '?' + params.toString(), {
        method: 'GET', credentials: 'include', headers: {'Content-Type': 'application/json'} }));
      if (!r.ok) return r;
      const data = r.data;
      return { ok: data.status_code === 0, status_code: data.status_code, cursor: Number(data.cursor || 0),
               has_more: Boolean(data.has_more), items: (data.aweme_list || []).map(mapVideo) };`;
  } else if (kind === "folders") {
    body = `
      const params = baseParams();
      params.set('cursor', String(a.cursor)); params.set('count', String(a.count));
      const r = await readJson(await fetch(${JSON.stringify(COLLECTS_LIST_API_URL)} + '?' + params.toString(), {
        method: 'GET', credentials: 'include', headers: {'Content-Type': 'application/json'} }));
      if (!r.ok) return r;
      const data = r.data;
      return { ok: data.status_code === 0, status_code: data.status_code, cursor: Number(data.cursor || 0),
               has_more: Boolean(data.has_more),
               items: (data.collects_list || []).map(c => ({
                 collects_id: String(c.collects_id_str || c.collects_id || ''),
                 name: String(c.collects_name || '').trim(),
                 total_number: Number(c.total_number || 0),
                 cover_url: (c.collects_cover && c.collects_cover.url_list && c.collects_cover.url_list[0]) || '',
                 create_time: Number(c.create_time || 0),
               })) };`;
  } else if (kind === "detail") {
    // 单条视频详情（含播放地址）：在已登录的抖音页面里同源请求，页面自带的签名脚本会补上参数；
    // 用来替代 yt-dlp 的抖音解析（yt-dlp 经常报 "Fresh cookies are needed"）
    body = `
      const params = baseParams();
      params.set('aweme_id', a.awemeId);
      const r = await readJson(await fetch(${JSON.stringify(DETAIL_API_URL)} + '?' + params.toString(), {
        method: 'GET', credentials: 'include', headers: {'Content-Type': 'application/json'} }));
      if (!r.ok) return r;
      const it = r.data && r.data.aweme_detail;
      if (!it) return { ok: false, status_code: r.data && r.data.status_code, empty_detail: true };
      const urls = [];
      const add = (x) => { if (x && x.url_list) for (const u of x.url_list) if (u && !urls.includes(u)) urls.push(u); };
      const v = it.video || {};
      // 只为转写取声音：优先纯音频流，其次码率最低的视频（省流量、下得快），最后才是默认播放地址
      (v.bit_rate_audio || []).forEach((b) => {
        const m = b && b.audio_meta; const l = m && m.url_list;
        if (Array.isArray(l)) add({ url_list: l });
        else if (l) add({ url_list: [l.main_url, l.backup_url, l.fallback_url].filter(Boolean) });
      });
      const audioOnly = urls.length;
      [...(v.bit_rate || [])].sort((x, y) => Number(x && x.bit_rate || 0) - Number(y && y.bit_rate || 0))
        .forEach((b) => add(b && b.play_addr));
      add(v.play_addr); add(v.download_addr);
      if (!urls.length && it.music) add(it.music.play_url);
      return { ok: true, item: { ...mapVideo(it), play_urls: urls, audio_only_count: audioOnly,
               tags: (it.text_extra || []).map((t) => t && t.hashtag_name).filter(Boolean) } };`;
  } else {
    throw new Error("unknown fetch kind: " + kind);
  }
  return `(async () => { try { const a = ${args}; ${PAGE_HELPERS} ${body} } catch (e) { return { ok: false, error: String(e && e.message || e) }; } })()`;
}

function pickTitle(description, awemeId) {
  const first = description ? String(description).split(/\r?\n/)[0].trim() : "";
  return first || `抖音收藏 ${awemeId}`;
}

/** 接口原始条目 → 统一收藏条目（非法 id 返回 null），字段与 Python 版 to_store_item 一致 */
function toStoreItem(raw, observedAt) {
  const awemeId = String((raw && raw.aweme_id) || "").trim();
  if (!AWEME_ID.test(awemeId)) return null;
  const description = String(raw.description || "").trim();
  return {
    aweme_id: awemeId,
    title: pickTitle(description, awemeId),
    author: String(raw.author || "").trim(),
    author_sec_uid: String(raw.author_sec_uid || "").trim(),
    description,
    duration: Number(raw.duration_seconds || 0),
    create_time: Math.trunc(Number(raw.create_time || 0)),
    likes: Math.trunc(Number(raw.likes || 0)),
    collects: Math.trunc(Number(raw.collects || 0)),
    comments: Math.trunc(Number(raw.comments || 0)),
    shares: Math.trunc(Number(raw.shares || 0)),
    play_url: String(raw.play_url || "").trim(),
    source_url: `https://www.douyin.com/video/${awemeId}`,
    observed_at: observedAt,
  };
}

function describeFailure(result, what) {
  if (!result) return `${what}失败：抖音没有返回数据`;
  if (result.http_status) return `${what}失败：抖音返回 HTTP ${result.http_status}（可能登录已失效，请重新扫码）`;
  if (result.empty || result.bad_json) return `${what}失败：抖音返回了空数据（多半是登录失效或触发风控，请重新扫码登录，稍等几分钟再试）`;
  if (result.error) return `${what}失败：${result.error}`;
  if (result.status_code === 8 || result.status_code === 2483) return `${what}失败：登录已失效，请到设置页重新扫码登录`;
  return `${what}失败（status_code=${result.status_code}）：请重新扫码登录后重试`;
}

/**
 * 通用游标翻页。fetchPage({cursor, count}) → {ok, cursor, has_more, items}
 * mapItem(raw) → 条目或 null；keyOf(item) → 去重键。
 */
async function collectPaged({ fetchPage, maxItems, mapItem, keyOf, what = "读取收藏", sleep, pageSize = 20, onPage }) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const collected = new Map();
  let cursor = 0;
  const seen = new Set();
  while (collected.size < maxItems) {
    const count = Math.min(pageSize, maxItems - collected.size);
    const result = await fetchPage({ cursor, count });
    if (!result || !result.ok) throw new Error(describeFailure(result, what));
    const items = result.items;
    if (!Array.isArray(items)) throw new Error(`${what}失败：抖音返回的列表格式不对`);
    for (const raw of items) {
      const item = mapItem(raw);
      if (item) {
        collected.set(keyOf(item), item);
        if (collected.size >= maxItems) break;
      }
    }
    if (onPage) onPage(collected.size);
    if (!result.has_more || !items.length) break;
    const next = Number(result.cursor || 0);
    if (seen.has(next) || next === cursor) throw new Error(`${what}失败：翻页游标不再前进（抖音接口异常，稍后重试）`);
    seen.add(cursor);
    cursor = next;
    await wait(500);
  }
  return Array.from(collected.values());
}

function hasSessionCookie(cookies, nowSec = Date.now() / 1000) {
  return (cookies || []).some(
    (c) => SESSION_COOKIE_NAMES.has(c.name) && c.value && (!c.expirationDate || c.expirationDate > nowSec)
  );
}

/** Electron cookies → Netscape cookies.txt（yt-dlp --cookies 可读） */
function toNetscapeCookies(cookies) {
  const lines = ["# Netscape HTTP Cookie File", "# 由 抖音知识库 导出，供 yt-dlp 使用", ""];
  for (const c of cookies || []) {
    if (!c || !c.name || !c.domain) continue;
    const hostOnly = c.hostOnly === true;
    let domain = String(c.domain);
    if (!hostOnly && !domain.startsWith(".")) domain = "." + domain;
    if (hostOnly && domain.startsWith(".")) domain = domain.slice(1);
    const value = String(c.value ?? "").replace(/[\t\r\n]/g, "");
    const expires = c.session || !c.expirationDate ? 0 : Math.trunc(c.expirationDate);
    lines.push([
      (c.httpOnly ? "#HttpOnly_" : "") + domain,
      hostOnly ? "FALSE" : "TRUE",
      c.path || "/",
      c.secure ? "TRUE" : "FALSE",
      String(expires),
      c.name,
      value,
    ].join("\t"));
  }
  return lines.join("\n") + "\n";
}

function isDouyinCookie(c) {
  const d = String((c && c.domain) || "").replace(/^\./, "");
  return /(^|\.)(douyin\.com|iesdouyin\.com|amemv\.com|snssdk\.com|bytedance\.com|byteimg\.com|douyinvod\.com|douyinpic\.com)$/.test(d);
}

/** 从用户粘贴的分享文案/链接里提取 URL 与 aweme_id（短链没有 id 时 id 为空） */
function parseShareInput(text) {
  const m = String(text || "").match(/https?:\/\/[^\s，。！？、\u3000]+/);
  let url = m ? m[0].replace(/[).,;'"]+$/, "") : "";
  const raw = String(text || "").trim();
  if (!url && /^[0-9]{6,30}$/.test(raw)) url = `https://www.douyin.com/video/${raw}`;
  if (!url) return null;
  const idm = url.match(/\/(?:video|note)\/(\d{6,30})/) || url.match(/[?&](?:modal_id|aweme_id)=(\d{6,30})/);
  const awemeId = idm ? idm[1] : "";
  return { url: awemeId ? `https://www.douyin.com/video/${awemeId}` : url, aweme_id: awemeId };
}

module.exports = {
  COLLECTION_PAGE_URL, COLLECTION_API_URL, COLLECTS_LIST_API_URL, COLLECTS_VIDEO_API_URL, CHROME_UA,
  buildFetchScript, pickTitle, toStoreItem, collectPaged, describeFailure,
  hasSessionCookie, toNetscapeCookies, isDouyinCookie, parseShareInput,
};
