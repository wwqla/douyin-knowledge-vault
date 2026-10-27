"use strict";
// 知识库异步索引：结果与同步版本一致，内容缓存只重读变化的文件
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vault = require("../lib/vault");
const { createVaultIndex } = require("../lib/vault-index");

function makeVault() {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), "dkv-vi-"));
  const k = path.join(v, "Knowledge");
  const w = (rel, txt) => { const f = path.join(k, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); };
  w("理财/基金/定投/定投误区.md", "---\ntitle: 定投误区\ncategory: 理财\n---\n> 越跌越买不一定对\n\n## 关键观点\n1. **别追涨**\n见 [[指数基金]]");
  w("理财/基金/指数/指数基金.md", "# 指数基金\n低成本 [[定投误区|误区]] 定投");
  w("理财/股票/价值/护城河.md", "# 护城河\n巴菲特");
  w("健康/睡眠/作息/早睡.md", "# 早睡\n定投时间到睡眠");
  fs.mkdirSync(path.join(k, "空分类", "空组", "空子类"), { recursive: true });
  fs.writeFileSync(path.join(k, ".hidden.md"), "x");
  return v;
}

test("async tree/search/graph/notesOfMajor match the sync implementation", async () => {
  const v = makeVault();
  const idx = createVaultIndex();
  assert.deepEqual(await idx.tree(v), vault.vaultTree(v));
  const a = await idx.search(v, "定投");
  const b = vault.search(v, "定投");
  const key = (r) => r.results.map((x) => `${x.path}|${x.count}|${x.snippet}`).sort();
  assert.deepEqual(key(a), key(b));
  const g1 = await idx.graph(v), g2 = vault.graph(v);
  const sortG = (g) => ({ nodes: g.nodes.map((n) => n.id).sort(), edges: g.edges.map((e) => e.source + ">" + e.target).sort() });
  assert.deepEqual(sortG(g1), sortG(g2));
  const n1 = (await idx.notesOfMajor(v, "理财")).map(({ mtimeMs, ...r }) => r).sort((x, y) => x.file.localeCompare(y.file));
  const n2 = vault.notesOfMajor(v, "理财").map(({ mtimeMs, ...r }) => r).sort((x, y) => x.file.localeCompare(y.file));
  assert.deepEqual(n1, n2);
  assert.equal((await idx.files(v)).length, 4);
});

test("snapshot is cached until invalidate(); only changed files are re-read", async () => {
  const v = makeVault();
  const idx = createVaultIndex();
  const s1 = await idx.snapshot(v);
  assert.equal(await idx.snapshot(v), s1, "second call served from cache");
  const [p1, p2] = await Promise.all([idx.search(v, "巴菲特"), idx.search(v, "巴菲特")]);
  assert.equal(p1.results.length, 1);
  assert.deepEqual(p1, p2);
  const f = path.join(v, "Knowledge", "健康/睡眠/作息/早睡.md");
  fs.writeFileSync(f, "# 早睡\n巴菲特也早睡（更新后的内容）");
  assert.equal((await idx.search(v, "巴菲特")).results.length, 1, "stale until invalidated");
  idx.invalidate();
  assert.equal((await idx.search(v, "巴菲特")).results.length, 2);
  fs.rmSync(f);
  idx.invalidate();
  assert.equal((await idx.files(v)).length, 3);
  assert.equal(idx._cache.size, 3, "deleted files leave the content cache");
});

test("missing vault yields empty results", async () => {
  const idx = createVaultIndex();
  assert.deepEqual(await idx.tree(""), { categories: [], files: {} });
  assert.deepEqual(await idx.search("/no/such", "x"), { results: [] });
  assert.deepEqual(await idx.graph(""), { nodes: [], edges: [] });
});
