"use strict";
// 知识库的异步索引 + 缓存（0.2.2 起）：目录树 / 搜索 / 图谱 / 统计不再在主进程里同步读文件，
// 避免 IPC 卡住界面。扫描用 fs.promises；笔记内容按 (mtime, size) 缓存，只重读变化的文件；
// 文件监听触发 invalidate() 后，下一次请求才重新扫描；同一时间的多个请求共用一次扫描。
const fsp = require("fs/promises");
const path = require("path");
const vault = require("./vault");

const byZh = (a, b) => a.localeCompare(b, "zh");

function createVaultIndex({ concurrency = 32 } = {}) {
  const contentCache = new Map(); // full -> { mtimeMs, size, content }
  let snap = null; // { vaultPath, dirs, files, at }
  let inflight = null;
  let generation = 0;

  async function readdir(dir) {
    try { return await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
  }

  async function scan(vaultPath) {
    const root = vault.knowledgeRoot(vaultPath);
    const dirs = []; // parts arrays
    const found = []; // { full, name, parts }
    const walk = async (dir, parts) => {
      const entries = await readdir(dir);
      const subdirs = [];
      for (const f of entries) {
        if (f.name.startsWith(".")) continue;
        const full = path.join(dir, f.name);
        if (f.isDirectory()) { dirs.push(parts.concat(f.name)); subdirs.push(walk(full, parts.concat(f.name))); }
        else if (f.isFile() && f.name.toLowerCase().endsWith(".md")) found.push({ full, name: f.name, parts });
      }
      await Promise.all(subdirs);
    };
    if (vaultPath) await walk(root, []);
    // stat + 读取变化的文件（限并发）
    const files = new Array(found.length);
    let i = 0;
    const worker = async () => {
      while (i < found.length) {
        const k = i++;
        const f = found[k];
        try {
          const st = await fsp.stat(f.full);
          let c = contentCache.get(f.full);
          if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
            c = { mtimeMs: st.mtimeMs, size: st.size, content: await fsp.readFile(f.full, "utf8") };
            contentCache.set(f.full, c);
          }
          files[k] = { ...f, mtimeMs: st.mtimeMs, size: st.size, content: c.content };
        } catch { files[k] = null; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, found.length || 1) }, worker));
    const list = files.filter(Boolean);
    const live = new Set(list.map((f) => f.full));
    for (const k of contentCache.keys()) if (!live.has(k)) contentCache.delete(k);
    // 与 walkMd 的遍历顺序无关，统一按路径排序，结果稳定
    list.sort((a, b) => byZh(a.full, b.full));
    return { vaultPath, dirs, files: list, at: Date.now() };
  }

  async function snapshot(vaultPath) {
    if (snap && snap.vaultPath === vaultPath) return snap;
    if (inflight && inflight.vaultPath === vaultPath) return inflight.promise;
    const gen = generation;
    const promise = scan(vaultPath).then((s) => {
      if (gen === generation) snap = s; // 扫描期间又有变化：结果照用，但不缓存
      return s;
    }).finally(() => { if (inflight && inflight.promise === promise) inflight = null; });
    inflight = { vaultPath, promise };
    return promise;
  }

  function invalidate() { generation++; snap = null; inflight = null; }

  async function tree(vaultPath) {
    const s = await snapshot(vaultPath);
    const out = { categories: [], files: {} };
    const kids = (parts) => s.dirs.filter((d) => d.length === parts.length + 1 && parts.every((p, i) => d[i] === p)).map((d) => d[d.length - 1]).sort(byZh);
    for (const major of kids([])) {
      const cat = { name: major, groups: [] };
      for (const group of kids([major])) {
        const g = { name: group, subs: [] };
        for (const sub of kids([major, group])) {
          const files = s.files.filter((f) => f.parts.length === 3 && f.parts[0] === major && f.parts[1] === group && f.parts[2] === sub).map((f) => f.name).sort(byZh);
          g.subs.push({ name: sub, files });
        }
        cat.groups.push(g);
      }
      out.categories.push(cat);
    }
    return out;
  }

  async function search(vaultPath, query) {
    const results = [];
    if (!query || !vaultPath) return { results };
    const s = await snapshot(vaultPath);
    const q = String(query).toLowerCase();
    const qEsc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const f of s.files) {
      if (results.length >= 60) break;
      const lower = f.content.toLowerCase();
      const idx = lower.indexOf(q);
      if (idx === -1) continue;
      const start = Math.max(0, idx - 70);
      results.push({
        title: f.name.replace(/\.md$/i, ""), path: f.full,
        snippet: f.content.slice(start, idx + q.length + 90).replace(/\s*\n+\s*/g, " "),
        count: (lower.match(new RegExp(qEsc, "g")) || []).length,
      });
    }
    return { results };
  }

  async function graph(vaultPath) {
    const nodes = [];
    const edges = [];
    if (!vaultPath) return { nodes, edges };
    const s = await snapshot(vaultPath);
    const index = new Map();
    for (const f of s.files) {
      const title = f.name.replace(/\.md$/i, "");
      const id = `${f.parts.join("/")}::${title}`;
      index.set(title, id);
      nodes.push({ id, title, path: f.full, group: f.parts[0] || "" });
    }
    s.files.forEach((f, i) => {
      const n = nodes[i];
      const links = new Set();
      const re = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g;
      let m;
      while ((m = re.exec(f.content)) !== null) {
        const t = m[1].trim();
        if (index.has(t)) links.add(index.get(t));
      }
      for (const t of links) if (t !== n.id) edges.push({ source: n.id, target: t });
    });
    return { nodes, edges };
  }

  async function notesOfMajor(vaultPath, major) {
    const s = await snapshot(vaultPath);
    return s.files.filter((f) => f.parts[0] === major).map((f) => ({
      ...vault.parseNote(f.content), file: f.full, name: f.name.replace(/\.md$/i, ""),
      group: f.parts[1] || "", sub: f.parts[2] || "", mtimeMs: f.mtimeMs,
    }));
  }

  /** 所有笔记的元数据（不含内容）：{ full, name, parts, mtimeMs, size } */
  async function files(vaultPath) {
    const s = await snapshot(vaultPath);
    return s.files.map(({ content, ...rest }) => rest); // eslint-disable-line no-unused-vars
  }

  return { snapshot, invalidate, tree, search, graph, notesOfMajor, files, _cache: contentCache };
}

module.exports = { createVaultIndex };
