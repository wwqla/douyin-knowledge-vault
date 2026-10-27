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
