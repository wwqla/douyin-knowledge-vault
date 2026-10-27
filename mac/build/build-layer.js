#!/usr/bin/env node
"use strict";
// 在任意系统（包括 Linux）上构建应用内增量更新包：release/app-update.asar + release/app-update.json
// 内容与 electron-builder 打进 app.asar 的一致：package.json 的 build.files 里的文件 + 精简后的 package.json。
// 应用没有运行时 npm 依赖（dependencies 为空），所以不含 node_modules / 原生模块，不需要在 Mac 上构建。
//
// 用法（在 mac/ 目录）：
//   npx --yes -p @electron/asar@3.4.1 node build/build-layer.js [--version 0.2.2] [--repo wwqla/douyin-knowledge-vault]
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : d; };

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = opt("version", pkg.version);
const repo = opt("repo", "wwqla/douyin-knowledge-vault");
const tag = "mac-v" + version;
if (pkg.dependencies && Object.keys(pkg.dependencies).length) {
  console.error("package.json 有运行时依赖：需要在 Mac 上用 electron-builder 构建（可能含原生模块）");
  process.exit(1);
}
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
const electronVersion = (lock.packages && lock.packages["node_modules/electron"] && lock.packages["node_modules/electron"].version) || "";
if (!/^\d+\./.test(electronVersion)) { console.error("package-lock.json 里找不到 electron 版本"); process.exit(1); }
const BOOT_PROTOCOL = require(path.join(ROOT, "lib", "update-core.js")).BOOT_PROTOCOL;

// build.files：与 package.json 保持一致
const INCLUDE_DIRS = ["boot", "lib", "renderer", "assets", "engine"];
const INCLUDE_FILES = ["main.js", "preload.js"];
const EXCLUDE = [/^engine\/worker\/tests(\/|$)/, /(^|\/)__pycache__(\/|$)/, /(^|\/)\.pytest_cache(\/|$)/, /\.pyc$/, /(^|\/)\.DS_Store$/,
  /(^|\/)\.venv(\/|$)/, /(^|\/)node_modules(\/|$)/, /^renderer\/fonts(\/|$)/];
const declared = (pkg.build && pkg.build.files) || [];
for (const d of INCLUDE_DIRS) if (!declared.includes(d + "/**/*")) { console.error(`build.files 不再包含 ${d}/**/*，请同步本脚本`); process.exit(1); }

const stage = path.join(ROOT, "release", "layer-stage");
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
const copied = [];
function copy(rel) {
  if (EXCLUDE.some((re) => re.test(rel))) return;
  const src = path.join(ROOT, rel);
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) { for (const n of fs.readdirSync(src).sort()) copy(rel + "/" + n); return; }
  fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true });
  fs.copyFileSync(src, path.join(stage, rel));
  copied.push(rel);
}
for (const d of INCLUDE_DIRS) copy(d);
for (const f of INCLUDE_FILES) copy(f);
// electron-builder 写进 app.asar 的 package.json：去掉 scripts / devDependencies / build
const slim = {};
for (const k of ["name", "version", "description", "main", "private", "license", "author"]) if (pkg[k] !== undefined) slim[k] = pkg[k];
slim.version = version;
fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify(slim, null, 2));

(async () => {
  const asar = require("@electron/asar");
  const out = path.join(ROOT, "release", "app-update.asar");
  fs.rmSync(out, { force: true });
  await asar.createPackage(stage, out);
  const b = fs.readFileSync(out);
  const notes = (fs.existsSync(path.join(ROOT, "update-notes.txt")) ? fs.readFileSync(path.join(ROOT, "update-notes.txt"), "utf8").split("\n")[0].trim() : "") || `抖音知识库 ${version}`;
  const base = `https://github.com/${repo}/releases/download/${tag}`;
  const manifest = {
    version, electron: electronVersion, bootstrap: BOOT_PROTOCOL,
    sha256: crypto.createHash("sha256").update(b).digest("hex"), size: b.length,
    asarUrl: base + "/app-update.asar",
    dmgUrl: `https://github.com/${repo}/releases/download/mac-v${opt("dmg-version", "0.2.1")}/DouyinKnowledgeVault-${opt("dmg-version", "0.2.1")}-mac-arm64.dmg`,
    releaseUrl: `https://github.com/${repo}/releases/tag/${tag}`, notes,
    publishedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(ROOT, "release", "app-update.json"), JSON.stringify(manifest, null, 2));
  console.log(`files: ${copied.length + 1}`);
  console.log(JSON.stringify(manifest, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
