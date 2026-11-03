"use strict";
// 语音识别引擎与模型：引擎选择、Hugging Face 缓存位置（与其他软件共用）、模型下载状态。
// 纯 Node，不依赖 Electron，便于单元测试。
const fs = require("fs");
const os = require("os");
const path = require("path");

const ENGINES = {
  sensevoice: {
    key: "sensevoice",
    label: "SenseVoice",
    title: "SenseVoice Small（推荐中文）",
    repo: "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
    files: ["model.int8.onnx", "tokens.txt"],
    size: 239549735, // model.int8.onnx + tokens.txt（Hugging Face API）
    module: "sensevoice", // doctor 字段：sherpa-onnx 是否已安装
  },
  whisper: {
    key: "whisper",
    label: "Whisper",
    title: "Whisper large-v3-turbo",
    repo: "mlx-community/whisper-large-v3-turbo",
    files: ["config.json", "weights.safetensors"],
    size: 1613979758,
    module: "mlx",
  },
};
const ENGINE_KEYS = Object.keys(ENGINES);
const DEFAULT_ENGINE_NEW = "sensevoice"; // 新安装默认
const DEFAULT_ENGINE_EXISTING = "whisper"; // 老用户（已有 settings.json 但没有 asrEngine）保持原来的 Whisper

/** raw = settings.json 解析结果；文件不存在时传 null */
function resolveAsrEngine(raw) {
  if (raw && ENGINE_KEYS.includes(raw.asrEngine)) return raw.asrEngine;
  return raw ? DEFAULT_ENGINE_EXISTING : DEFAULT_ENGINE_NEW;
}

function normEngine(e) { return ENGINE_KEYS.includes(e) ? e : DEFAULT_ENGINE_NEW; }

/** worker 的 --asr 名称 */
function workerEngine(asrEngine, isArm) {
  if (normEngine(asrEngine) === "sensevoice") return "sensevoice";
  return isArm ? "mlx" : "faster-whisper";
}

/** 安装器要装的 pyproject extra（逗号分隔）。已装过的引擎一并保留，修复时不丢。 */
function installExtras(asrEngine, isArm, doc) {
  const set = new Set();
  const add = (eng) => set.add(eng === "sensevoice" ? "sensevoice" : (isArm ? "mlx" : "cpu"));
  add(normEngine(asrEngine));
  if (doc && doc.sensevoice) add("sensevoice");
  if (doc && doc.mlx) add("whisper");
  return [...set].join(",");
}

const expandHome = (p, home) => String(p).replace(/^~(?=\/|$)/, home);

/** 与 huggingface_hub 相同的规则：HF_HUB_CACHE > HUGGINGFACE_HUB_CACHE > HF_HOME/hub > $XDG_CACHE_HOME/huggingface/hub > ~/.cache/huggingface/hub */
function hfHubCache(env, home) {
  env = env || {};
  home = home || os.homedir();
  for (const k of ["HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE"]) if (env[k]) return path.resolve(expandHome(env[k], home));
  if (env.HF_HOME) return path.join(path.resolve(expandHome(env.HF_HOME, home)), "hub");
  const base = env.XDG_CACHE_HOME ? path.resolve(expandHome(env.XDG_CACHE_HOME, home)) : path.join(home, ".cache");
  return path.join(base, "huggingface", "hub");
}

/** 合并环境：自定义模型文件夹 > 进程环境 > 登录 shell 里设置的 HF_HOME/HF_HUB_CACHE（从访达打开的应用读不到 .zshrc） */
function modelEnv(settings, processEnv, shellEnv) {
  const out = {};
  const pe = processEnv || {};
  const se = shellEnv || {};
  for (const k of ["HF_HOME", "HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE", "XDG_CACHE_HOME"]) {
    if (pe[k]) out[k] = pe[k];
    else if (se[k]) out[k] = se[k];
  }
  const custom = settings && typeof settings.modelsDir === "string" ? settings.modelsDir.trim() : "";
  if (custom) out.HF_HUB_CACHE = custom;
  return out;
}

/** 解析 `zsh -ilc` 打印的标记行，取出 HF 相关变量 */
const SHELL_PROBE = 'printf "\\n__DKV_HF__%s|%s|%s|%s__\\n" "$HF_HOME" "$HF_HUB_CACHE" "$HUGGINGFACE_HUB_CACHE" "$XDG_CACHE_HOME"';
function parseShellProbe(stdout) {
  const m = /__DKV_HF__([^\n]*?)__/.exec(String(stdout || ""));
  if (!m) return {};
  const [a, b, c, d] = m[1].split("|");
  const out = {};
  if (a) out.HF_HOME = a;
  if (b) out.HF_HUB_CACHE = b;
  if (c) out.HUGGINGFACE_HUB_CACHE = c;
  if (d) out.XDG_CACHE_HOME = d;
  return out;
}

function repoCacheDir(cacheDir, repo) {
  return path.join(cacheDir, "models--" + repo.replace(/\//g, "--"));
}

function fileSize(p) { try { const s = fs.statSync(p); return s.isFile() ? s.size : 0; } catch { return 0; } }

/** 某个模型在缓存里是否完整：优先 refs/main 指向的快照，其次任何包含全部文件的快照 */
function modelStatus(cacheDir, spec) {
  const root = repoCacheDir(cacheDir, spec.repo);
  const snaps = path.join(root, "snapshots");
  const res = { engine: spec.key, repo: spec.repo, downloaded: false, path: null, size: 0, expectedSize: spec.size, repoDir: root };
  let names = [];
  try { names = fs.readdirSync(snaps); } catch { return res; }
  let order = [];
  try { order.push(fs.readFileSync(path.join(root, "refs", "main"), "utf8").trim()); } catch { /* 没有 refs */ }
  order = order.concat(names.filter((n) => !order.includes(n)));
  for (const n of order) {
    const dir = path.join(snaps, n);
    const sizes = spec.files.map((f) => fileSize(path.join(dir, f)));
    if (sizes.every((x) => x > 0)) {
      return { ...res, downloaded: true, path: dir, size: sizes.reduce((a, b) => a + b, 0) };
    }
  }
  return res;
}

function allModelStatus(cacheDir) {
  const out = {};
  for (const k of ENGINE_KEYS) out[k] = modelStatus(cacheDir, ENGINES[k]);
  return out;
}

function fmtSize(bytes) {
  if (!bytes) return "0 MB";
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + " GB";
  return Math.round(bytes / 1024 ** 2) + " MB";
}


// ---------------- 本地 Whisper 模型（缓存里别的软件下好的，如 models--openai--whisper-base） ----------------
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

/** 'mlx' | 'hf'（transformers，首次使用时自动转换）| 'hf-bin' | 'ct2' | '' */
function whisperFormat(dir) {
  const cfg = readJson(path.join(dir, "config.json"));
  if (!cfg) return "";
  const has = (f) => fileSize(path.join(dir, f)) > 0;
  if ("n_mels" in cfg && (has("weights.safetensors") || has("weights.npz"))) return "mlx";
  if (cfg.model_type === "whisper" || "num_mel_bins" in cfg) {
    if (has("model.safetensors")) return "hf";
    if (has("pytorch_model.bin")) return "hf-bin";
  }
  if (has("model.bin")) return "ct2";
  return "";
}

function dirSize(dir) {
  let n = 0;
  try { for (const f of fs.readdirSync(dir)) n += fileSize(path.join(dir, f)); } catch { /* ignore */ }
  return n;
}

/** 缓存里所有能给 M 芯片用的 Whisper 模型（不含默认的 large-v3-turbo，它有自己的一行） */
function scanLocalWhisper(cacheDir) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(cacheDir); } catch { return out; }
  for (const n of names) {
    if (!/^models--.+whisper/i.test(n)) continue;
    const repo = n.slice("models--".length).replace(/--/g, "/");
    if (repo === ENGINES.whisper.repo) continue;
    const snaps = path.join(cacheDir, n, "snapshots");
    let order = [];
    try { order.push(fs.readFileSync(path.join(cacheDir, n, "refs", "main"), "utf8").trim()); } catch { /* 没有 refs */ }
    try { order = order.concat(fs.readdirSync(snaps).filter((x) => !order.includes(x))); } catch { continue; }
    for (const sn of order) {
      const dir = path.join(snaps, sn);
      const format = whisperFormat(dir);
      if (!format) continue;
      out.push({ repo, path: dir, format, usable: format === "mlx" || format === "hf", size: dirSize(dir) });
      break;
    }
  }
  return out.sort((a, b) => a.size - b.size);
}

/** 设置里的 whisperModel 是否指向一个本地可用模型（仓库名或文件夹） */
function localWhisperChoice(whisperModel, local) {
  const m = String(whisperModel || "").trim();
  if (!m || m === ENGINES.whisper.repo) return null;
  const hit = (local || []).find((x) => x.repo === m || x.path === m);
  if (hit) return hit;
  if (m.startsWith("/") || m.startsWith("~")) {
    const dir = expandHome(m, os.homedir());
    const format = whisperFormat(dir);
    if (format) return { repo: path.basename(dir), path: dir, format, usable: format === "mlx" || format === "hf", size: dirSize(dir) };
  }
  return null;
}

/** 当前引擎是否可以直接转写：组件已装 + 模型已下载（Intel 的 Whisper 用 faster-whisper，首次转写时自动下载） */
function engineReady(asrEngine, doc, models, isArm, localChoice) {
  if (!doc || !doc.installed) return false;
  const e = normEngine(asrEngine);
  if (e === "sensevoice") return !!(doc.sensevoice && models && models.sensevoice && models.sensevoice.downloaded);
  if (!isArm) return true;
  if (localChoice) return !!(doc.mlx && localChoice.usable);
  return !!(doc.mlx && ((models && models.whisper && models.whisper.downloaded) || doc.whisperReady));
}

module.exports = {
  ENGINES, ENGINE_KEYS, DEFAULT_ENGINE_NEW, DEFAULT_ENGINE_EXISTING,
  resolveAsrEngine, normEngine, workerEngine, installExtras,
  hfHubCache, modelEnv, SHELL_PROBE, parseShellProbe,
  repoCacheDir, modelStatus, allModelStatus, fmtSize, engineReady,
  whisperFormat, scanLocalWhisper, localWhisperChoice,
};
