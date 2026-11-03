"use strict";
// 语音识别引擎设置：引擎选择、默认值迁移、HF 缓存路径、模型状态
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const asr = require("../lib/asr");

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "dkv-asr-"));

test("new installs default to SenseVoice, existing users keep Whisper", () => {
  assert.equal(asr.resolveAsrEngine(null), "sensevoice");
  assert.equal(asr.resolveAsrEngine({ vaultPath: "/x", whisperModel: "mlx-community/whisper-large-v3-turbo" }), "whisper");
  assert.equal(asr.resolveAsrEngine({ asrEngine: "sensevoice" }), "sensevoice");
  assert.equal(asr.resolveAsrEngine({ asrEngine: "whisper" }), "whisper");
  assert.equal(asr.resolveAsrEngine({ asrEngine: "bogus" }), "whisper");
});

test("worker engine names and installer extras", () => {
  assert.equal(asr.workerEngine("sensevoice", true), "sensevoice");
  assert.equal(asr.workerEngine("sensevoice", false), "sensevoice");
  assert.equal(asr.workerEngine("whisper", true), "mlx");
  assert.equal(asr.workerEngine("whisper", false), "faster-whisper");
  assert.equal(asr.installExtras("sensevoice", true, null), "sensevoice");
  assert.equal(asr.installExtras("whisper", true, null), "mlx");
  assert.equal(asr.installExtras("whisper", false, null), "cpu");
  // 修复/切换时保留已装的另一个引擎
  assert.equal(asr.installExtras("sensevoice", true, { mlx: true }), "sensevoice,mlx");
  assert.equal(asr.installExtras("whisper", true, { sensevoice: true, mlx: true }), "mlx,sensevoice");
});

test("hfHubCache follows huggingface_hub precedence", () => {
  const home = "/Users/u";
  assert.equal(asr.hfHubCache({}, home), "/Users/u/.cache/huggingface/hub");
  assert.equal(asr.hfHubCache({ XDG_CACHE_HOME: "/c" }, home), "/c/huggingface/hub");
  assert.equal(asr.hfHubCache({ HF_HOME: "~/hf", XDG_CACHE_HOME: "/c" }, home), "/Users/u/hf/hub");
  assert.equal(asr.hfHubCache({ HF_HOME: "/h", HUGGINGFACE_HUB_CACHE: "/legacy" }, home), "/legacy");
  assert.equal(asr.hfHubCache({ HF_HOME: "/h", HF_HUB_CACHE: "/m" }, home), "/m");
});

test("modelEnv: custom folder > process env > login shell env", () => {
  assert.deepEqual(asr.modelEnv({ modelsDir: "" }, {}, {}), {});
  assert.deepEqual(asr.modelEnv({}, {}, { HF_HOME: "/shell" }), { HF_HOME: "/shell" });
  assert.deepEqual(asr.modelEnv({}, { HF_HOME: "/proc" }, { HF_HOME: "/shell" }), { HF_HOME: "/proc" });
  assert.deepEqual(asr.modelEnv({ modelsDir: " /Volumes/SSD/models " }, { HF_HOME: "/proc" }, {}), { HF_HOME: "/proc", HF_HUB_CACHE: "/Volumes/SSD/models" });
  assert.equal(asr.hfHubCache(asr.modelEnv({ modelsDir: "/m" }, {}, {}), "/Users/u"), "/m");
});

test("parseShellProbe reads the marker line and ignores shell noise", () => {
  const out = "Last login...\nwelcome!\n__DKV_HF__/Users/u/hf||| __\n__DKV_HF__/Users/u/hf|/mnt/hub||__\n";
  assert.deepEqual(asr.parseShellProbe("noise\n__DKV_HF__/Users/u/hf|/mnt/hub||__\n"), { HF_HOME: "/Users/u/hf", HF_HUB_CACHE: "/mnt/hub" });
  assert.deepEqual(asr.parseShellProbe("__DKV_HF__|||__"), {});
  assert.deepEqual(asr.parseShellProbe(""), {});
  assert.ok(out); // 只取第一个标记
});

function fakeModel(cache, repo, files, sha = "deadbeef") {
  const root = asr.repoCacheDir(cache, repo);
  fs.mkdirSync(path.join(root, "blobs"), { recursive: true });
  fs.mkdirSync(path.join(root, "snapshots", sha), { recursive: true });
  fs.mkdirSync(path.join(root, "refs"), { recursive: true });
  fs.writeFileSync(path.join(root, "refs", "main"), sha);
  for (const [name, data] of Object.entries(files)) {
    const blob = path.join(root, "blobs", sha + name);
    fs.writeFileSync(blob, data);
    const link = path.join(root, "snapshots", sha, name);
    try { fs.unlinkSync(link); } catch { /* new */ }
    fs.symlinkSync(path.join("..", "..", "blobs", sha + name), link);
  }
  return path.join(root, "snapshots", sha);
}

test("modelStatus detects complete models in the shared HF cache", () => {
  const cache = tmpdir();
  let st = asr.allModelStatus(cache);
  assert.equal(st.sensevoice.downloaded, false);
  assert.equal(st.whisper.downloaded, false);
  assert.equal(st.sensevoice.expectedSize, 239549735);
  assert.ok(st.sensevoice.repoDir.endsWith("models--csukuangfj--sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"));
  fakeModel(cache, asr.ENGINES.sensevoice.repo, { "tokens.txt": "a 0\n" });
  assert.equal(asr.modelStatus(cache, asr.ENGINES.sensevoice).downloaded, false, "partial download is not ready");
  const snap = fakeModel(cache, asr.ENGINES.sensevoice.repo, { "tokens.txt": "a 0\n", "model.int8.onnx": "xxxxxx" });
  st = asr.modelStatus(cache, asr.ENGINES.sensevoice);
  assert.equal(st.downloaded, true);
  assert.equal(st.path, snap);
  assert.equal(st.size, 10);
});

test("engineReady per engine", () => {
  const models = { sensevoice: { downloaded: true }, whisper: { downloaded: false } };
  assert.equal(asr.engineReady("sensevoice", { installed: true, sensevoice: true }, models, true), true);
  assert.equal(asr.engineReady("sensevoice", { installed: true, sensevoice: false }, models, true), false);
  assert.equal(asr.engineReady("whisper", { installed: true, mlx: true }, models, true), false);
  assert.equal(asr.engineReady("whisper", { installed: true, mlx: true, whisperReady: true }, models, true), true);
  assert.equal(asr.engineReady("whisper", { installed: true }, models, false), true); // Intel faster-whisper
  assert.equal(asr.engineReady("sensevoice", { installed: false }, models, true), false);
  assert.equal(asr.fmtSize(239549735), "228 MB");
  assert.equal(asr.fmtSize(1613979758), "1.5 GB");
});

// ---------- 本地 Whisper 模型 ----------
{
  const t = require("node:test");
  const assert = require("node:assert");
  const fs2 = require("fs"), os2 = require("os"), path2 = require("path");
  const A = require("../lib/asr");
  const mk = (root, repo, files, cfg) => {
    const snap = path2.join(root, "models--" + repo.replace(/\//g, "--"), "snapshots", "abc");
    fs2.mkdirSync(snap, { recursive: true });
    fs2.writeFileSync(path2.join(snap, "config.json"), JSON.stringify(cfg));
    for (const f of files) fs2.writeFileSync(path2.join(snap, f), "x".repeat(10));
    return snap;
  };
  t.test("scanLocalWhisper finds transformers / mlx / ct2 models and flags usability", () => {
    const root = fs2.mkdtempSync(path2.join(os2.tmpdir(), "hfc-"));
    const hf = mk(root, "openai/whisper-base", ["model.safetensors"], { model_type: "whisper", num_mel_bins: 80 });
    mk(root, "mlx-community/whisper-small-mlx", ["weights.npz"], { n_mels: 80 });
    mk(root, "Systran/faster-whisper-base", ["model.bin"], { alignment_heads: [] });
    mk(root, "openai/whisper-tiny", ["pytorch_model.bin"], { model_type: "whisper", num_mel_bins: 80 });
    mk(root, "mlx-community/whisper-large-v3-turbo", ["weights.safetensors"], { n_mels: 128 });
    mk(root, "other/bert", ["model.safetensors"], { model_type: "bert" });
    const list = A.scanLocalWhisper(root);
    const by = Object.fromEntries(list.map((m) => [m.repo, m]));
    assert.equal(by["openai/whisper-base"].format, "hf");
    assert.equal(by["openai/whisper-base"].usable, true);
    assert.equal(by["mlx-community/whisper-small-mlx"].format, "mlx");
    assert.equal(by["Systran/faster-whisper-base"].usable, false);
    assert.equal(by["openai/whisper-tiny"].format, "hf-bin");
    assert.ok(!by["mlx-community/whisper-large-v3-turbo"], "default model has its own row");
    assert.ok(!by["other/bert"]);
    assert.equal(A.localWhisperChoice("openai/whisper-base", list).path, hf);
    assert.equal(A.localWhisperChoice(hf, list).repo, "openai/whisper-base");
    assert.equal(A.localWhisperChoice("mlx-community/whisper-large-v3-turbo", list), null);
    assert.equal(A.localWhisperChoice("", list), null);
  });
  t.test("engineReady accepts a usable local Whisper without the default download", () => {
    const doc = { installed: true, mlx: true };
    const models = { whisper: { downloaded: false } };
    assert.equal(A.engineReady("whisper", doc, models, true, null), false);
    assert.equal(A.engineReady("whisper", doc, models, true, { usable: true }), true);
    assert.equal(A.engineReady("whisper", doc, models, true, { usable: false }), false);
    assert.equal(A.engineReady("whisper", { installed: true, mlx: false }, models, true, { usable: true }), false);
  });
}
