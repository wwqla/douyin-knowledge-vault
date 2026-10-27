"use strict";
// 知识库文件系统操作：目录树、搜索、图谱、分类管理、笔记解析（纯 fs，无 Electron 依赖）
const fs = require("fs");
const path = require("path");

const ILLEGAL = /[\\/:*?"<>|#^[\]\x00-\x1f]/g;

function cleanName(name, max = 80) {
  let s = String(name || "").normalize("NFC").replace(ILLEGAL, " ").replace(/\s+/g, " ").trim().replace(/^[ .]+|[ .]+$/g, "");
  if (s.length > max) s = s.slice(0, max).replace(/[ .]+$/, "");
  return s;
}

function knowledgeRoot(vaultPath) {
  return path.join(vaultPath || "", "Knowledge");
}

function listNotes(dir) {
  const files = [];
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (f.isFile() && f.name.toLowerCase().endsWith(".md")) files.push(f.name);
  }
  files.sort((a, b) => a.localeCompare(b, "zh"));
  return files;
}

function vaultTree(vaultPath) {
  const root = knowledgeRoot(vaultPath);
  const tree = { categories: [], files: {} };
  if (!vaultPath || !fs.existsSync(root)) return tree;
  const dirs = (p) => fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("."));
  for (const major of dirs(root)) {
    const cat = { name: major.name, groups: [] };
    const majorDir = path.join(root, major.name);
    for (const group of dirs(majorDir)) {
      const g = { name: group.name, subs: [] };
      const groupDir = path.join(majorDir, group.name);
      for (const sub of dirs(groupDir)) g.subs.push({ name: sub.name, files: listNotes(path.join(groupDir, sub.name)) });
      g.subs.sort((a, b) => a.name.localeCompare(b.name, "zh"));
      cat.groups.push(g);
    }
    cat.groups.sort((a, b) => a.name.localeCompare(b.name, "zh"));
    tree.categories.push(cat);
  }
  tree.categories.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  return tree;
}

function walkMd(dir, cb, parts = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const f of entries) {
    if (f.name.startsWith(".")) continue;
    const full = path.join(dir, f.name);
    if (f.isDirectory()) walkMd(full, cb, parts.concat(f.name));
    else if (f.isFile() && f.name.toLowerCase().endsWith(".md")) cb(full, f.name, parts);
  }
}

function search(vaultPath, query) {
  const root = knowledgeRoot(vaultPath);
  const results = [];
  if (!query || !vaultPath || !fs.existsSync(root)) return { results };
  const q = String(query).toLowerCase();
  const qEsc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  walkMd(root, (full, name) => {
    if (results.length >= 60) return;
    const content = fs.readFileSync(full, "utf8");
    const lower = content.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx === -1) return;
    const start = Math.max(0, idx - 70);
    results.push({
      title: name.replace(/\.md$/i, ""),
      path: full,
      snippet: content.slice(start, idx + q.length + 90).replace(/\s*\n+\s*/g, " "),
      count: (lower.match(new RegExp(qEsc, "g")) || []).length,
    });
  });
  return { results };
}

function graph(vaultPath) {
  const root = knowledgeRoot(vaultPath);
  const nodes = [];
  const edges = [];
  const index = new Map();
  if (!vaultPath || !fs.existsSync(root)) return { nodes, edges };
  walkMd(root, (full, name, parts) => {
    const title = name.replace(/\.md$/i, "");
    const id = `${parts.join("/")}::${title}`;
    index.set(title, id);
    nodes.push({ id, title, path: full, group: parts[0] || "" });
  });
  for (const n of nodes) {
    const content = fs.readFileSync(n.path, "utf8");
    const links = new Set();
    const re = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const t = m[1].trim();
      if (index.has(t)) links.add(index.get(t));
    }
    for (const t of links) if (t !== n.id) edges.push({ source: n.id, target: t });
  }
  return { nodes, edges };
}

/** 解析 FavVault 生成的笔记：frontmatter + 摘要 + 关键观点 */
function parseNote(content) {
  const out = { title: "", summary: "", tags: [], points: [], url: "", category: "" };
  const text = String(content || "");
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  if (fm) {
    const body = fm[1];
    const get = (k) => { const m = new RegExp(`^${k}:\\s*(.*)$`, "m").exec(body); return m ? m[1].trim().replace(/^"|"$/g, "") : ""; };
    out.title = get("title");
    out.url = get("url");
    out.category = get("category");
    const tagBlock = /^tags:\n((?:\s+-\s.*\n?)*)/m.exec(body);
    if (tagBlock) out.tags = tagBlock[1].split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean);
  }
  const sm = /^>\s+(?!\[!)(.+)$/m.exec(text);
  if (sm) out.summary = sm[1].trim();
  const kp = /## 关键观点\n([\s\S]*?)(\n## |$)/.exec(text);
  if (kp) {
    for (const line of kp[1].split("\n")) {
      const m = /^\d+\.\s+\*\*(.+?)\*\*/.exec(line);
      if (m) out.points.push(m[1].trim());
    }
  }
  if (!out.title) { const h = /^#\s+(.+)$/m.exec(text); if (h) out.title = h[1].trim(); }
  return out;
}

/** 某大类下全部笔记（用于知识卡片 / AI 问答上下文） */
function notesOfMajor(vaultPath, major) {
  const dir = path.join(knowledgeRoot(vaultPath), major);
  const notes = [];
  if (!fs.existsSync(dir)) return notes;
  walkMd(dir, (full, name, parts) => {
    try {
      const st = fs.statSync(full);
      const info = parseNote(fs.readFileSync(full, "utf8"));
      notes.push({ ...info, file: full, name: name.replace(/\.md$/i, ""), group: parts[0] || "", sub: parts[1] || "", mtimeMs: st.mtimeMs });
    } catch { /* ignore unreadable */ }
  });
  return notes;
}

function inside(root, p) {
  const rel = path.relative(root, p);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function rewriteCategoryInNotes(dir, fn) {
  walkMd(dir, (full) => {
    try {
      const txt = fs.readFileSync(full, "utf8");
      const next = fn(txt);
      if (next !== txt) fs.writeFileSync(full, next, "utf8");
    } catch { /* ignore */ }
  });
}

/**
 * 分类管理（与原 manage-categories.mjs 参数一致）：
 *   add major <名> | add group <大类> <名> | add sub <大类> <父类> <名>
 *   delete major <名> | delete group <大类> <名> | delete sub <大类> <父类> <名>
 *   rename major <旧> <新> | rename group <大类> <旧> <新> | rename sub <大类> <父类> <旧> <新>
 *   move <笔记绝对路径> <大类> <父类> <子类>
 */
function manageCategories(vaultPath, args) {
  const a = Array.isArray(args) ? args.map((x) => String(x == null ? "" : x)) : [];
  if (!vaultPath) return { ok: false, error: "还没设置知识库路径" };
  const root = knowledgeRoot(vaultPath);
  const [op, kind] = a;
  const need = (n) => a.length >= n && a.slice(0, n).every((x) => x.trim());
  const clean = (s) => cleanName(s);
  try {
    if (op === "add") {
      const levels = { major: 3, group: 4, sub: 5 }[kind];
      if (!levels || !need(levels)) return { ok: false, error: "参数不完整" };
      const parts = a.slice(2, levels).map(clean);
      if (parts.some((x) => !x)) return { ok: false, error: "名称不能为空或只含特殊字符" };
      const target = path.join(root, ...parts);
      if (fs.existsSync(target)) return { ok: false, error: "同名分类已存在" };
      fs.mkdirSync(target, { recursive: true });
      return { ok: true, path: target };
    }
    if (op === "delete") {
      const levels = { major: 3, group: 4, sub: 5 }[kind];
      if (!levels || !need(levels)) return { ok: false, error: "参数不完整" };
      const target = path.join(root, ...a.slice(2, levels));
      if (!inside(root, target)) return { ok: false, error: "非法路径" };
      if (!fs.existsSync(target)) return { ok: false, error: "分类不存在" };
      fs.rmSync(target, { recursive: true, force: true });
      return { ok: true };
    }
    if (op === "rename") {
      const levels = { major: 4, group: 5, sub: 6 }[kind];
      if (!levels || !need(levels)) return { ok: false, error: "参数不完整" };
      const parentParts = a.slice(2, levels - 2);
      const oldName = a[levels - 2];
      const newName = clean(a[levels - 1]);
      if (!newName) return { ok: false, error: "新名称不能为空或只含特殊字符" };
      const from = path.join(root, ...parentParts, oldName);
      const to = path.join(root, ...parentParts, newName);
      if (!inside(root, from) || !inside(root, to)) return { ok: false, error: "非法路径" };
      if (!fs.existsSync(from)) return { ok: false, error: "原分类不存在" };
      if (fs.existsSync(to)) return { ok: false, error: "目标名称已存在" };
      fs.renameSync(from, to);
      // 同步笔记 frontmatter：collected_folder（大类）/ category（父类/子类）
      if (kind === "major") {
        rewriteCategoryInNotes(to, (t) => t.replace(/^collected_folder:.*$/m, `collected_folder: "${newName.replace(/"/g, '\\"')}"`));
      } else if (kind === "group") {
        rewriteCategoryInNotes(to, (t) => t.replace(/^category:\s*"([^"/]*)\/(.*)"$/m, (_m, _g, s) => `category: "${newName}/${s}"`));
      } else {
        rewriteCategoryInNotes(to, (t) => t.replace(/^category:\s*"([^"/]*)\/(.*)"$/m, (_m, g) => `category: "${g}/${newName}"`));
      }
      return { ok: true };
    }
    if (op === "move") {
      if (!need(5)) return { ok: false, error: "请选择目标大类 / 父类 / 子类" };
      const src = a[1];
      if (!inside(root, src) || !fs.existsSync(src)) return { ok: false, error: "笔记不存在" };
      const dir = path.join(root, clean(a[2]), clean(a[3]), clean(a[4]));
      fs.mkdirSync(dir, { recursive: true });
      let dest = path.join(dir, path.basename(src));
      if (path.resolve(dest) === path.resolve(src)) return { ok: true, path: dest };
      if (fs.existsSync(dest)) dest = path.join(dir, path.basename(src, ".md") + "-" + Date.now().toString(36).slice(-4) + ".md");
      fs.renameSync(src, dest);
      try {
        const txt = fs.readFileSync(dest, "utf8")
          .replace(/^category:.*$/m, `category: "${clean(a[3])}/${clean(a[4])}"`)
          .replace(/^collected_folder:.*$/m, `collected_folder: "${clean(a[2])}"`);
        fs.writeFileSync(dest, txt, "utf8");
      } catch { /* ignore */ }
      return { ok: true, path: dest };
    }
    return { ok: false, error: `不支持的分类操作：${op || "（空）"}` };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/** 笔记绝对路径 → {major, group, sub}（不在知识库内返回空字段） */
function categoryOfPath(vaultPath, notePath) {
  const root = knowledgeRoot(vaultPath);
  if (!notePath || !inside(root, notePath)) return { major: "", group: "", sub: "" };
  const parts = path.relative(root, notePath).split(path.sep);
  return { major: parts[0] || "", group: parts.length > 2 ? parts[1] : "", sub: parts.length > 3 ? parts[2] : "" };
}

module.exports = { cleanName, knowledgeRoot, listNotes, vaultTree, walkMd, search, graph, parseNote, notesOfMajor, manageCategories, categoryOfPath, inside };
