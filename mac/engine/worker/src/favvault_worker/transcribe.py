"""Local speech-to-text. Audio never leaves the Mac.

Engines:
  apple          -> macOS built-in on-device speech recognition (no model download).
                    Runs through the FavVault app binary: `FavVault --transcribe <wav> --locale zh-CN`,
                    whose path the app passes in FAVVAULT_APPLE_ASR.
  sensevoice     -> SenseVoiceSmall (int8 ONNX, ~230 MB) through sherpa-onnx on the CPU, no PyTorch.
                    Best for Chinese; adds punctuation (use_itn). Long audio is cut into 20-30 s chunks
                    at the quietest point near each boundary.
  mlx            -> mlx-whisper (Apple Silicon), whisper-large-v3-turbo, ~1.6 GB download once
  faster-whisper -> CPU fallback for Intel Macs, model "small"
  auto           -> apple when the helper is available, else sensevoice, else mlx, else faster-whisper

Models live in the standard Hugging Face cache (HF_HUB_CACHE, or HF_HOME/hub, default
~/.cache/huggingface/hub), so other Hugging Face based tools reuse the same files.
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from . import tools
from .events import emit, log

MLX_DEFAULT = "mlx-community/whisper-large-v3-turbo"
SENSEVOICE_REPO = "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"
SENSEVOICE_FILES = ["model.int8.onnx", "tokens.txt"]
SENSEVOICE_LANGUAGE = "auto"  # auto-detects zh / en / ja / ko / yue; Chinese is handled best
SV_CHUNK_MIN = 20.0  # seconds: cut long audio between 20 and 30 s, at the quietest 100 ms
SV_CHUNK_MAX = 30.0
SAMPLE_RATE = 16000
# engine -> model in the Hugging Face cache (files=None means the whole repo)
MODELS = {
    "sensevoice": {"repo": SENSEVOICE_REPO, "files": SENSEVOICE_FILES, "size": 239549735},
    "mlx": {"repo": MLX_DEFAULT, "files": None, "size": 1613979758},
}
FW_DEFAULT = "small"
ZH_PROMPT = "以下是普通话的句子，使用简体中文，带标点。"
HF_MIRROR = "https://hf-mirror.com"
APPLE_CHUNK_SECONDS = 50  # Apple's recognizer is most reliable on short files


class TranscribeError(RuntimeError):
    pass


def apple_helper() -> str | None:
    p = os.environ.get("FAVVAULT_APPLE_ASR")
    return p if p and os.access(p, os.X_OK) else None


def _has(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):  # e.g. a stub module without __spec__
        return module in sys.modules


def pick_engine(engine: str) -> str:
    if engine == "apple":
        if not apple_helper():
            raise TranscribeError("系统语音识别只能在 FavVault 应用里使用（命令行请改用 --asr mlx）")
        return engine
    if engine == "sensevoice":
        if not _has("sherpa_onnx"):
            raise TranscribeError("SenseVoice 组件还没安装：请在设置 › 处理组件里选择 SenseVoice 并安装")
        return engine
    if engine in ("mlx", "faster-whisper"):
        return engine
    if apple_helper():
        return "apple"
    if _has("sherpa_onnx"):
        return "sensevoice"
    if importlib.util.find_spec("mlx_whisper"):
        return "mlx"
    if importlib.util.find_spec("faster_whisper"):
        return "faster-whisper"
    raise TranscribeError("没有可用的转录引擎：请在设置里下载 Whisper 模型或改用 Mac 自带识别")


def transcribe(audio: Path, engine: str = "auto", model: str = "", language: str | None = "zh",
               duration: float | None = None) -> dict:
    """Returns {"engine", "model", "language", "segments": [{"start","end","text"}], "text"}."""
    engine = pick_engine(engine)
    if engine == "apple":
        segments = _apple(audio, duration)
        model, lang = "SFSpeechRecognizer", language
    elif engine == "sensevoice":
        segments, lang = _sensevoice(audio, model)
        model = model or SENSEVOICE_REPO
    elif engine == "mlx":
        import mlx_whisper  # type: ignore

        model = model or MLX_DEFAULT
        model_path = ensure_hf_model(model)
        emit("stage", stage="transcribe")
        result = mlx_whisper.transcribe(
            str(audio), path_or_hf_repo=model_path, language=language,
            initial_prompt=ZH_PROMPT if language == "zh" else None,
            condition_on_previous_text=False,
        )
        segments = [{"start": float(s["start"]), "end": float(s["end"]), "text": s["text"].strip()}
                    for s in result.get("segments", [])]
        lang = result.get("language", language)
    else:
        from faster_whisper import WhisperModel  # type: ignore

        model = model or FW_DEFAULT
        emit("stage", stage="model_download", model=model)
        wm = WhisperModel(model, device="cpu", compute_type="int8")
        emit("stage", stage="transcribe")
        segs, info = wm.transcribe(
            str(audio), language=language, vad_filter=True,
            initial_prompt=ZH_PROMPT if language == "zh" else None,
        )
        segments = [{"start": float(s.start), "end": float(s.end), "text": s.text.strip()} for s in segs]
        lang = info.language
    return {
        "engine": engine,
        "model": model,
        "language": lang,
        "segments": segments,
        "text": "\n".join(s["text"] for s in segments if s["text"]),
    }


# ---------------- SenseVoice (sherpa-onnx) ----------------
def load_pcm(audio: Path):
    """Decode any audio/video file to 16 kHz mono float32 samples with ffmpeg."""
    import numpy as np

    ff = tools.ffmpeg()
    if not ff:
        raise TranscribeError("找不到 ffmpeg：请在设置里重新安装组件")
    out = subprocess.run([ff, "-v", "error", "-nostdin", "-i", str(audio), "-ac", "1", "-ar", str(SAMPLE_RATE),
                          "-f", "s16le", "-"], capture_output=True)
    if out.returncode != 0:
        raise TranscribeError("音频解码失败：" + out.stderr.decode("utf-8", "replace")[-300:])
    return np.frombuffer(out.stdout, dtype=np.int16).astype(np.float32) / 32768.0


def chunk_bounds(samples, sr: int = SAMPLE_RATE, min_s: float = SV_CHUNK_MIN,
                 max_s: float = SV_CHUNK_MAX) -> list[tuple[int, int]]:
    """Split into chunks of min_s..max_s seconds, cutting at the quietest 100 ms frame in that window
    so words are rarely cut in half. Returns [(start, end)] sample indices covering everything."""
    import numpy as np

    n = len(samples)
    frame = max(1, sr // 10)
    bounds: list[tuple[int, int]] = []
    start = 0
    while n - start > int(max_s * sr):
        lo, hi = start + int(min_s * sr), start + int(max_s * sr)
        k = (hi - lo) // frame
        win = np.asarray(samples[lo:lo + k * frame], dtype=np.float32).reshape(k, frame)
        energy = (win * win).mean(axis=1)
        cut = lo + int(np.argmin(energy)) * frame + frame // 2
        bounds.append((start, cut))
        start = cut
    if n - start > 0:
        bounds.append((start, n))
    return bounds


def _clean_lang(tag: str | None) -> str | None:
    t = (tag or "").strip().strip("<|>").strip()
    return t or None


def _sensevoice(audio: Path, model: str = "") -> tuple[list[dict], str | None]:
    import sherpa_onnx  # type: ignore

    model_dir = Path(ensure_hf_model(model or SENSEVOICE_REPO, SENSEVOICE_FILES))
    emit("stage", stage="transcribe")
    rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=str(model_dir / "model.int8.onnx"), tokens=str(model_dir / "tokens.txt"),
        language=SENSEVOICE_LANGUAGE, use_itn=True, num_threads=max(1, min(4, os.cpu_count() or 1)),
    )
    samples = load_pcm(audio)
    bounds = chunk_bounds(samples)
    segments: list[dict] = []
    langs: dict[str, int] = {}
    for i, (a, b) in enumerate(bounds):
        emit("progress", stage="transcribe", done=i, total=len(bounds))
        stream = rec.create_stream()
        stream.accept_waveform(SAMPLE_RATE, samples[a:b])
        rec.decode_stream(stream)
        text = (stream.result.text or "").strip()
        lang = _clean_lang(getattr(stream.result, "lang", None))
        if text:
            segments.append({"start": round(a / SAMPLE_RATE, 2), "end": round(b / SAMPLE_RATE, 2), "text": text})
            if lang:
                langs[lang] = langs.get(lang, 0) + 1
    emit("progress", stage="transcribe", done=len(bounds), total=len(bounds))
    return segments, (max(langs, key=langs.get) if langs else None)


# ---------------- Apple on-device recognition ----------------
def _apple(audio: Path, duration: float | None) -> list[dict]:
    helper = apple_helper()
    assert helper
    ff = tools.ffmpeg()
    if not ff:
        raise TranscribeError("找不到 ffmpeg：请在设置里重新安装组件")
    segments: list[dict] = []
    with tempfile.TemporaryDirectory(prefix="favvault-asr-") as tmp:
        pattern = str(Path(tmp) / "chunk-%04d.wav")
        subprocess.run(
            [ff, "-v", "error", "-y", "-i", str(audio), "-ac", "1", "-ar", "16000",
             "-f", "segment", "-segment_time", str(APPLE_CHUNK_SECONDS), pattern],
            check=True, capture_output=True,
        )
        chunks = sorted(Path(tmp).glob("chunk-*.wav"))
        for i, chunk in enumerate(chunks):
            emit("progress", stage="transcribe", done=i, total=len(chunks))
            offset = i * APPLE_CHUNK_SECONDS
            out = subprocess.run([helper, "--transcribe", str(chunk), "--locale", "zh-CN"],
                                 capture_output=True, text=True, timeout=600)
            data = _parse_helper(out.stdout)
            if out.returncode != 0 or "error" in data:
                code = data.get("code", "")
                if code == "not_authorized":
                    raise TranscribeError("还没授权语音识别：打开 FavVault 设置 › 本地转录 › 授权")
                if code == "no_speech":
                    continue  # silent chunk
                raise TranscribeError(f"系统语音识别失败：{data.get('error') or out.stderr[-300:]}")
            for s in data.get("segments", []):
                segments.append({"start": s["start"] + offset, "end": s["end"] + offset,
                                 "text": s["text"].strip()})
        emit("progress", stage="transcribe", done=len(chunks), total=len(chunks))
    return segments


def _parse_helper(stdout: str) -> dict:
    for line in reversed(stdout.strip().splitlines()):
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    return {"error": "no output from helper"}


# ---------------- Hugging Face cache (shared with other tools) ----------------
def hf_hub_cache() -> Path:
    """Same rules as huggingface_hub: HF_HUB_CACHE > HUGGINGFACE_HUB_CACHE > HF_HOME/hub >
    $XDG_CACHE_HOME/huggingface/hub > ~/.cache/huggingface/hub."""
    env = os.environ
    for key in ("HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE"):
        if env.get(key):
            return Path(env[key]).expanduser()
    if env.get("HF_HOME"):
        return Path(env["HF_HOME"]).expanduser() / "hub"
    xdg = env.get("XDG_CACHE_HOME")
    base = Path(xdg).expanduser() if xdg else Path.home() / ".cache"
    return base / "huggingface" / "hub"


def repo_cache_dir(repo: str, cache: Path | None = None) -> Path:
    return (cache or hf_hub_cache()) / ("models--" + repo.replace("/", "--"))


def cached_snapshot(repo: str, files: list[str] | None = None, cache: Path | None = None) -> Path | None:
    """Path of a cached snapshot of `repo` holding all `files` (resolved, non-empty), else None.
    Prefers the snapshot refs/main points at. With files=None any non-empty snapshot counts."""
    root = repo_cache_dir(repo, cache)
    snaps = root / "snapshots"
    if not snaps.is_dir():
        return None
    order: list[Path] = []
    ref = root / "refs" / "main"
    if ref.is_file():
        order.append(snaps / ref.read_text(encoding="utf-8").strip())
    order += sorted((p for p in snaps.iterdir() if p.is_dir()), key=lambda p: p.stat().st_mtime, reverse=True)
    for snap in order:
        if not snap.is_dir():
            continue
        if files:
            ok = all((snap / f).exists() and (snap / f).stat().st_size > 0 for f in files)
        else:
            ok = any(f.exists() and not f.name.startswith(".") for f in snap.iterdir())
        if ok:
            return snap
    return None


def model_status(engine: str) -> dict:
    spec = MODELS[engine]
    snap = cached_snapshot(spec["repo"], spec["files"])
    size = 0
    if snap:
        wanted = spec["files"] or [str(p.relative_to(snap)) for p in snap.rglob("*") if p.is_file()]
        size = sum((snap / f).stat().st_size for f in wanted if (snap / f).exists())
    return {"engine": engine, "repo": spec["repo"], "downloaded": bool(snap), "path": str(snap) if snap else None,
            "size": size, "expectedSize": spec["size"], "repoDir": str(repo_cache_dir(spec["repo"]))}


# ---------------- Hugging Face model download with progress ----------------
def ensure_hf_model(repo: str, files: list[str] | None = None) -> str:
    """Return a local path for `repo` (only `files` when given), downloading it into the shared
    Hugging Face cache with progress events if needed. An already cached model is used as is.
    Falls back to hf-mirror.com when huggingface.co is unreachable."""
    if Path(repo).expanduser().exists():
        return str(Path(repo).expanduser())
    snap = cached_snapshot(repo, files)
    if snap:
        return str(snap)
    from huggingface_hub import snapshot_download  # type: ignore

    try:
        return snapshot_download(repo, allow_patterns=files, local_files_only=True)
    except Exception:  # noqa: BLE001 - not cached yet
        pass

    emit("stage", stage="model_download", model=repo)
    endpoints = [os.environ.get("HF_ENDPOINT") or "https://huggingface.co"]
    if HF_MIRROR not in endpoints:
        endpoints.append(HF_MIRROR)
    last: Exception | None = None
    for ep in endpoints:
        try:
            log(f"downloading {repo} from {ep}")
            total = _repo_size(repo, ep, files)
            with _ByteProgress(repo, total):
                return snapshot_download(repo, endpoint=ep, allow_patterns=files)
        except Exception as e:  # noqa: BLE001
            last = e
            log(f"model download from {ep} failed: {e}", level="warn")
    raise TranscribeError(f"模型下载失败：{last}")


def _repo_size(repo: str, endpoint: str, files: list[str] | None = None) -> int:
    try:
        from huggingface_hub import HfApi  # type: ignore

        info = HfApi(endpoint=endpoint).model_info(repo, files_metadata=True)
        return sum(int(f.size or 0) for f in info.siblings or [] if not files or f.rfilename in files)
    except Exception:  # noqa: BLE001 - progress is best effort
        return 0


class _ByteProgress:
    """Polls the Hugging Face cache folder for `repo` and emits byte progress once a second.
    (snapshot_download does not expose per-byte callbacks.)"""

    def __init__(self, repo: str, total: int):
        import threading

        self.dir = repo_cache_dir(repo)
        self.total = total
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _size(self) -> int:
        if not self.dir.exists():
            return 0
        return sum(f.stat().st_size for f in self.dir.rglob("*") if f.is_file() and not f.is_symlink())

    def _run(self):
        while not self.stop.wait(1.0):
            if self.total:
                emit("progress", stage="model_download", done=min(self._size(), self.total), total=self.total)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.stop.set()
        self.thread.join(timeout=2)
        if self.total and exc[0] is None:
            emit("progress", stage="model_download", done=self.total, total=self.total)
