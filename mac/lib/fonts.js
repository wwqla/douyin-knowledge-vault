"use strict";
// 界面字体按需下载：安装包里不再内置这 7 款中文字体（约 27 MB），用到哪款下哪款，存到数据目录 fonts/。
const path = require("path");
const core = require("./update-core");
const dl = require("./download");

const REPO = "wwqla/douyin-knowledge-vault";
const FONTS_TAG = "mac-fonts-v1"; // 一次性创建的字体 release（由 mac-release 工作流维护）
const JSDELIVR_REF = "9abf3cd288845b908729cc4abd98d1fdf1d1b0b8"; // 仓库根目录 renderer/fonts/vip 所在的提交

const FONTS = {
  qkhy: { name: "清刻黄油体", family: "ZCOOL QingKe HuangYou", css: "'ZCOOL QingKe HuangYou', 'PingFang SC', sans-serif", file: "ZCOOLQingKeHuangYou-Regular.ttf", size: 8328684, sha256: "54f0c0df4308cd74cd0f2fd3494ae054dbc4a1fd6fa7d71f4807eb4cdd8b4136" },
  kuaile: { name: "快乐体", family: "ZCOOL KuaiLe", css: "'ZCOOL KuaiLe', 'PingFang SC', sans-serif", file: "ZCOOLKuaiLe-Regular.ttf", size: 1514968, sha256: "812a6fc1fe54b6d73a419245c32dfeba8aa33104d5be90d1cf6af082007cb71d" },
  zhimang: { name: "志莽行书", family: "Zhi Mang Xing", css: "'Zhi Mang Xing', 'PingFang SC', cursive", file: "ZhiMangXing-Regular.woff2", size: 1927040, sha256: "10368ae6659323a22486361f295472d488533161b4ddfb4d7cabac84c8af0fd2" },
  xiaowei: { name: "站酷小薇", family: "ZCOOL XiaoWei", css: "'ZCOOL XiaoWei', 'PingFang SC', serif", file: "ZCOOLXiaoWei-Regular.woff2", size: 2194136, sha256: "f943c7337ff42159a70a21555604b8ae0e40599ecb1455b5c7b219f22642cff2" },
  maszheng: { name: "马善政毛笔", family: "Ma Shan Zheng", css: "'Ma Shan Zheng', 'PingFang SC', cursive", file: "MaShanZheng-Regular.woff2", size: 2708796, sha256: "5b31c15b66b61a62ce0ee2d12da1c667ef589272cbfdad1e5bbc930ddf01dabb" },
  wenkai: { name: "霞鹜文楷", family: "LXGW WenKai", css: "'LXGW WenKai', 'PingFang SC', serif", weight: "500", file: "LXGWWenKai-Medium.woff2", size: 7231496, sha256: "013fa90e3e7c3b30aeb0a5311ef92d9aee0d3def5817bc27c357198796d34306" },
  zhenkai: { name: "霞鹜臻楷", family: "LXGW ZhenKai", css: "'LXGW ZhenKai', 'PingFang SC', cursive", file: "LXGWZhenKai-Regular.ttf", size: 3881034, sha256: "457955ce330f2945428f92b4621c72d72435cf9028a82ac138283cfe5e1f553f" },
};

function fontUrls(f, mirrors) {
  const rel = `https://github.com/${REPO}/releases/download/${FONTS_TAG}/${f.file}`;
  return [...core.mirrorUrls(rel, mirrors), `https://cdn.jsdelivr.net/gh/${REPO}@${JSDELIVR_REF}/renderer/fonts/vip/${f.file}`];
}

function createFonts({ fetchImpl, fsImpl, dir, getMirrors }) {
  const inflight = new Map();
  const fileOf = (f) => path.join(dir, f.file);
  const isReady = (f) => { try { return fsImpl.statSync(fileOf(f)).size === f.size; } catch { return false; } };

  function list() {
    return Object.entries(FONTS).map(([key, f]) => ({ key, name: f.name, family: f.family, css: f.css, weight: f.weight || "normal", size: f.size, ready: isReady(f) }));
  }

  async function ensure(key, onProgress) {
    const f = FONTS[key];
    if (!f) return { ok: false, error: "没有这款字体" };
    if (isReady(f)) return { ok: true, key, ready: true };
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      const m = getMirrors && getMirrors();
      const r = await dl.downloadFile(fetchImpl, fsImpl, fontUrls(f, Array.isArray(m) && m.length ? m : ["", "https://ghfast.top/"]), fileOf(f), {
        sha256: f.sha256, size: f.size, onProgress: (pr) => onProgress && onProgress({ key, ...pr }),
      });
      return r.ok ? { ok: true, key, ready: true } : { ok: false, key, error: `「${f.name}」下载失败：${r.error}` };
    })();
    inflight.set(key, p);
    try { return await p; } finally { inflight.delete(key); }
  }

  // 渲染进程用 FontFace(二进制) 注入，不需要放开 file:// 或自定义协议
  function read(key) {
    const f = FONTS[key];
    if (!f || !isReady(f)) return null;
    return { family: f.family, weight: f.weight || "normal", data: fsImpl.readFileSync(fileOf(f)) };
  }

  return { list, ensure, read };
}

module.exports = { createFonts, FONTS, fontUrls, FONTS_TAG, JSDELIVR_REF };
