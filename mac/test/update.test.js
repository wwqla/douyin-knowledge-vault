"use strict";
// 增量更新 / 下载 / 字体的纯逻辑测试（不依赖 Electron）：node --test test/
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const core = require("../lib/update-core");
const dl = require("../lib/download");
const { createUpdater } = require("../lib/updater");
const { createFonts, FONTS, fontUrls } = require("../lib/fonts");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dkv-upd-"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

function putLayer(dir, version, { body = "layer " + version, electron = "33.2.1", bootstrap, corrupt = false, size } = {}) {
  const buf = Buffer.from(body);
  fs.writeFileSync(path.join(dir, `app-${version}.asar`), corrupt ? Buffer.from(body.slice(0, -1) + "#") : buf); // 同样大小、内容被改
  const m = { version, electron, sha256: sha(buf), size: size == null ? buf.length : size, file: `app-${version}.asar` };
  if (bootstrap != null) m.bootstrap = bootstrap;
  fs.writeFileSync(path.join(dir, `app-${version}.json`), JSON.stringify(m));
  return m;
}
const select = (dir, extra = {}) => core.selectLayer({ fsImpl: fs, updatesDir: dir, bundledVersion: "0.2.0", electron: "33.4.11", ...extra });

// ---------- 版本比较 ----------
test("compareVersions orders semver incl. prerelease", () => {
  assert.equal(core.compareVersions("0.2.1", "0.2.0"), 1);
  assert.equal(core.compareVersions("0.2.0", "0.2.0"), 0);
  assert.equal(core.compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(core.compareVersions("1.0.0", "1.0.0-beta.1"), 1);
  assert.equal(core.compareVersions("v1.2.3", "1.2.3"), 0);
  assert.equal(core.compareVersions("garbage", "0.0.1"), -1);
  assert.equal(core.electronMajor("33.2.1"), 33);
  assert.equal(core.electronMajor(34), 34);
});

test("validateManifest catches bad fields", () => {
  const ok = { version: "0.2.1", electron: "33", sha256: "a".repeat(64), size: 10, asarUrl: "https://x/y" };
  assert.equal(core.validateManifest(ok, { requireUrl: true }), "");
  assert.match(core.validateManifest({ ...ok, version: "x" }), /版本/);
  assert.match(core.validateManifest({ ...ok, sha256: "zz" }), /sha256/);
  assert.match(core.validateManifest({ ...ok, size: 0 }), /size/);
  assert.match(core.validateManifest({ ...ok, asarUrl: "http://x" }, { requireUrl: true }), /下载地址/);
  assert.equal(core.needsFullInstall(ok, { electron: "33.4.0" }), "");
  assert.match(core.needsFullInstall({ ...ok, electron: "34.0.0" }, { electron: "33.4.0" }), /内核/);
  assert.match(core.needsFullInstall({ ...ok, bootstrap: 2 }, { electron: "33.4.0", bootProtocol: 1 }), /启动器/);
});

// ---------- 启动时选层 ----------
test("selectLayer picks newest valid layer", () => {
  const d = tmp();
  putLayer(d, "0.2.1");
  putLayer(d, "0.2.2");
  const r = select(d);
  assert.equal(r.layer.version, "0.2.2");
  assert.equal(r.layer.asarPath, path.join(d, "app-0.2.2.asar"));
});

test("selectLayer: no dir / older / same version → bundled", () => {
  assert.equal(select(path.join(tmp(), "nope")).layer, null);
  const d = tmp();
  putLayer(d, "0.1.9");
  putLayer(d, "0.2.0");
  const r = select(d);
  assert.equal(r.layer, null);
  assert.equal(r.rejected.length, 2);
});

test("selectLayer rejects sha mismatch, wrong size, electron major, and falls back to next", () => {
  const d = tmp();
  putLayer(d, "0.2.1");
  putLayer(d, "0.2.4", { corrupt: true });
  putLayer(d, "0.2.3", { electron: "34.0.0" });
  putLayer(d, "0.2.2", { size: 999 });
  const r = select(d);
  assert.equal(r.layer.version, "0.2.1");
  const why = Object.fromEntries(r.rejected.map((x) => [x.version, x.reason]));
  assert.match(why["0.2.4"], /sha256/);
  assert.match(why["0.2.3"], /内核/);
  assert.match(why["0.2.2"], /大小/);
  assert.ok(r.changed);
  assert.ok(r.state.bad["0.2.4"]);
});

test("selectLayer skips layers needing a newer bootstrap, and corrupt manifests", () => {
  const d = tmp();
  putLayer(d, "0.3.0", { bootstrap: 2 });
  fs.writeFileSync(path.join(d, "app-0.4.0.json"), "{not json");
  assert.equal(select(d).layer, null);
});

test("crash safety: two failed boots → bad, then bundled", () => {
  const d = tmp();
  putLayer(d, "0.2.1");
  let st = core.readState(fs, d);
  for (let i = 0; i < 2; i++) {
    const r = select(d, { state: st });
    assert.equal(r.layer.version, "0.2.1", "attempt " + i);
    core.beginBoot(r.state, "0.2.1");
    core.writeState(fs, d, r.state); // 然后崩溃：没有 markGood
    st = core.readState(fs, d);
  }
  const r3 = select(d, { state: st });
  assert.equal(r3.layer, null);
  assert.match(r3.state.bad["0.2.1"], /连续 2 次/);
});

test("good boot resets attempts; cancelBoot undoes a second-instance launch", () => {
  const d = tmp();
  putLayer(d, "0.2.1");
  const st = core.emptyState();
  core.beginBoot(st, "0.2.1");
  core.cancelBoot(st, "0.2.1");
  assert.equal(st.boots["0.2.1"].attempts, 0);
  core.beginBoot(st, "0.2.1"); core.beginBoot(st, "0.2.1");
  core.markGood(st, "0.2.1");
  core.beginBoot(st, "0.2.1"); core.beginBoot(st, "0.2.1"); // 已证明能启动的版本不再累计
  assert.equal(select(d, { state: st }).layer.version, "0.2.1");
  core.markBad(st, "0.2.1", "boom");
  assert.equal(select(d, { state: st }).layer, null);
});

test("state file round-trip and garbage tolerance", () => {
  const d = tmp();
  assert.deepEqual(core.readState(fs, d), { bad: {}, boots: {} });
  fs.writeFileSync(path.join(d, "state.json"), "]]");
  assert.deepEqual(core.readState(fs, d), { bad: {}, boots: {} });
  core.writeState(fs, d, { bad: { "1.0.0": "x" }, boots: {} });
  assert.equal(core.readState(fs, d).bad["1.0.0"], "x");
});

// ---------- 发布挑选 / 镜像 / 清理 ----------
test("pickMacRelease filters to mac-v* with app-update.json", () => {
  const rel = (tag, assets = ["app-update.json"], extra = {}) => ({ tag_name: tag, html_url: "h/" + tag, assets: assets.map((n) => ({ name: n, browser_download_url: `https://github.com/r/releases/download/${tag}/${n}` })), ...extra });
  const best = core.pickMacRelease([rel("v9.9.9"), rel("mac-v0.2.0"), rel("mac-v0.3.0", ["x.dmg"]), rel("mac-v0.2.10"), rel("mac-v0.4.0", undefined, { draft: true }), rel("mac-latest")]);
  assert.equal(best.version, "0.2.10");
  assert.match(best.manifestUrl, /mac-v0\.2\.10\/app-update\.json$/);
  assert.equal(core.pickMacRelease([]), null);
});

test("mirrorUrls prefixes only github urls and dedupes", () => {
  const u = "https://github.com/a/b/releases/download/t/f";
  assert.deepEqual(core.mirrorUrls(u, ["", "https://ghfast.top/"]), [u, "https://ghfast.top/" + u]);
  assert.deepEqual(core.mirrorUrls(u, ["https://ghfast.top"]), ["https://ghfast.top/" + u]);
  assert.deepEqual(core.mirrorUrls("https://cdn.jsdelivr.net/x", ["https://ghfast.top/", ""]), ["https://cdn.jsdelivr.net/x"]);
  assert.deepEqual(core.mirrorUrls(u, []), [u]);
});

test("filesToPrune keeps active + new versions only", () => {
  const names = ["app-0.2.1.asar", "app-0.2.1.json", "app-0.2.2.asar", "app-0.2.2.json", "app-0.2.3.asar.download", "state.json"];
  assert.deepEqual(core.filesToPrune(names, ["0.2.2", ""]).sort(), ["app-0.2.1.asar", "app-0.2.1.json", "app-0.2.3.asar.download"]);
});

// ---------- 下载器（假 fetch） ----------
function fakeFetch(routes) {
  return async (url, opts = {}) => {
    const r = routes[url];
    if (!r) throw new Error("ENOTFOUND " + url);
    if (r.hang) return new Promise((_res, rej) => opts.signal.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; rej(e); }));
    if (r.status && r.status !== 200) return { ok: false, status: r.status, headers: new Map(), json: async () => ({}) };
    const body = Buffer.isBuffer(r.body) ? r.body : Buffer.from(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
    let sent = false;
    return {
      ok: true, status: 200,
      headers: { get: (k) => (k === "content-length" ? String(body.length) : null) },
      json: async () => JSON.parse(body.toString()),
      body: { getReader: () => ({ read: async () => (sent ? { done: true } : (sent = true, { done: false, value: new Uint8Array(body) })), cancel: async () => {} }) },
    };
  };
}

test("downloadFile falls back across sources and verifies sha256", async () => {
  const d = tmp();
  const data = Buffer.from("hello asar");
  const f = fakeFetch({ "https://a/x": { status: 503 }, "https://b/x": { body: Buffer.from("tampered!!") }, "https://c/x": { body: data } });
  const progress = [];
  const r = await dl.downloadFile(f, fs, ["https://a/x", "https://b/x", "https://c/x"], path.join(d, "out.asar"), { sha256: sha(data), size: data.length, onProgress: (p) => progress.push(p.pct) });
  assert.equal(r.ok, true);
  assert.equal(r.url, "https://c/x");
  assert.equal(fs.readFileSync(path.join(d, "out.asar"), "utf8"), "hello asar");
  assert.equal(progress.at(-1), 100);
  assert.ok(!fs.existsSync(path.join(d, "out.asar.download")));
});

test("downloadFile reports all failures and leaves no partial file", async () => {
  const d = tmp();
  const f = fakeFetch({ "https://a/x": { hang: true }, "https://b/x": { body: "nope" } });
  const r = await dl.downloadFile(f, fs, ["https://a/x", "https://b/x"], path.join(d, "o"), { sha256: "0".repeat(64), opts: { firstByteTimeoutMs: 50 } });
  assert.equal(r.ok, false);
  assert.match(r.error, /连接超时/);
  assert.match(r.error, /sha256/);
  assert.deepEqual(fs.readdirSync(d), []);
});

// ---------- 更新器端到端（假 GitHub） ----------
function fakeGithub({ version = "0.2.1", electron = "33.2.1", asar = Buffer.from("NEW LAYER") } = {}) {
  const tag = "mac-v" + version;
  const base = `https://github.com/wwqla/douyin-knowledge-vault/releases/download/${tag}`;
  const manifest = { version, electron, bootstrap: 1, sha256: sha(asar), size: asar.length, asarUrl: `${base}/app-update.asar`, dmgUrl: `${base}/x.dmg`, notes: "改进" };
  return {
    manifest, asar,
    routes: {
      "https://api.github.com/repos/wwqla/douyin-knowledge-vault/releases?per_page=30": { body: [{ tag_name: tag, html_url: "https://github.com/r/" + tag, assets: [{ name: "app-update.json", browser_download_url: `${base}/app-update.json` }] }, { tag_name: "v3.0.0", assets: [] }] },
      [`${base}/app-update.json`]: { body: manifest },
      [`${base}/app-update.asar`]: { body: asar },
    },
  };
}

test("updater: check → download → bootstrap selects the new layer", async () => {
  const d = tmp();
  const gh = fakeGithub();
  const boot = { version: "0.2.0", bundledVersion: "0.2.0", source: "bundled", electron: "33.2.1", protocol: 1, updatesDir: d };
  const u = createUpdater({ fetchImpl: fakeFetch(gh.routes), fsImpl: fs, boot, getMirrors: () => [""] });
  const c = await u.check();
  assert.equal(c.ok, true, c.error);
  assert.equal(c.available, true);
  assert.equal(c.needsFull, false);
  const r = await u.download(c.manifest);
  assert.equal(r.ok, true, r.error);
  const sel = core.selectLayer({ fsImpl: fs, updatesDir: d, bundledVersion: "0.2.0", electron: "33.9.0" });
  assert.equal(sel.layer.version, "0.2.1");
  assert.equal(fs.readFileSync(sel.layer.asarPath, "utf8"), "NEW LAYER");
});

test("updater: electron major change → needs full DMG, no download", async () => {
  const d = tmp();
  const gh = fakeGithub({ electron: "34.0.0" });
  const boot = { version: "0.2.0", bundledVersion: "0.2.0", source: "bundled", electron: "33.2.1", protocol: 1, updatesDir: d };
  const u = createUpdater({ fetchImpl: fakeFetch(gh.routes), fsImpl: fs, boot });
  const c = await u.check();
  assert.equal(c.available, true);
  assert.equal(c.needsFull, true);
  assert.match(c.dmgUrl, /x\.dmg$/);
  const r = await u.download(c.manifest);
  assert.equal(r.ok, false);
});

test("updater: falls back to the mac-latest channel when the API fails; up-to-date is not available", async () => {
  const d = tmp();
  const gh = fakeGithub();
  const routes = { "https://github.com/wwqla/douyin-knowledge-vault/releases/download/mac-latest/app-update.json": { body: gh.manifest } };
  const boot = { version: "0.2.1", bundledVersion: "0.2.0", source: "update", electron: "33.2.1", protocol: 1, updatesDir: d };
  const c = await createUpdater({ fetchImpl: fakeFetch(routes), fsImpl: fs, boot, getMirrors: () => [""] }).check();
  assert.equal(c.ok, true, c.error);
  assert.equal(c.available, false);
});

// ---------- 字体 ----------
test("fonts: list, sources and on-demand download", async () => {
  assert.equal(Object.keys(FONTS).length, 7);
  const urls = fontUrls(FONTS.kuaile, ["", "https://ghfast.top/"]);
  assert.equal(urls.length, 3);
  assert.match(urls[0], /releases\/download\/mac-fonts-v1\/ZCOOLKuaiLe-Regular\.ttf$/);
  assert.match(urls[2], /^https:\/\/cdn\.jsdelivr\.net\/gh\/wwqla\/douyin-knowledge-vault@[0-9a-f]{40}\/renderer\/fonts\/vip\/ZCOOLKuaiLe-Regular\.ttf$/);
  // 仓库根目录里的字体文件必须和清单里的 sha256/size 一致（jsDelivr 回退源依赖它）
  const repoFonts = path.join(__dirname, "..", "..", "renderer", "fonts", "vip");
  for (const f of Object.values(FONTS)) {
    const p = path.join(repoFonts, f.file);
    if (!fs.existsSync(p)) continue;
    const b = fs.readFileSync(p);
    assert.equal(b.length, f.size, f.file);
    assert.equal(sha(b), f.sha256, f.file);
  }
  const d = tmp();
  const fake = Buffer.from("FONTDATA");
  const saved = { ...FONTS.kuaile };
  Object.assign(FONTS.kuaile, { size: fake.length, sha256: sha(fake) });
  try {
    const routes = { [fontUrls(FONTS.kuaile, [""])[1]]: { body: fake } }; // 只有 jsDelivr 可用
    const fonts = createFonts({ fetchImpl: fakeFetch(routes), fsImpl: fs, dir: d, getMirrors: () => [""] });
    assert.equal(fonts.list().find((x) => x.key === "kuaile").ready, false);
    assert.equal(fonts.read("kuaile"), null);
    const r = await fonts.ensure("kuaile");
    assert.equal(r.ok, true, r.error);
    assert.equal(fonts.list().find((x) => x.key === "kuaile").ready, true);
    assert.equal(fonts.read("kuaile").data.toString(), "FONTDATA");
    assert.equal((await fonts.ensure("nope")).ok, false);
  } finally { Object.assign(FONTS.kuaile, saved); }
});
