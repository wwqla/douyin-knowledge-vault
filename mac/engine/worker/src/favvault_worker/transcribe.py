"""Local speech-to-text. Audio never leaves the Mac.

Engines:
  apple          -> macOS built-in on-device speech recognition (no model download).
                    Runs through the FavVault app binary: `FavVault --transcribe <wav> --locale zh-CN`,
                    whose path the app passes in FAVVAULT_APPLE_ASR.
  mlx            -> mlx-whisper (Apple Silicon), whisper-large-v3-turbo, ~1.6 GB download once
  faster-whisper -> CPU fallback for Intel Macs, model "small"
  auto           -> apple when the helper is available, else mlx, else faster-whisper
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import tempfile
from pathlib import Path

from . import tools
from .events import emit, log

MLX_DEFAULT = "mlx-community/whisper-large-v3-turbo"
FW_DEFAULT = "small"
ZH_PROMPT = "以下是普通话的句子，使用简体中文，带标点。"
HF_MIRROR = "https://hf-mirror.com"
APPLE_CHUNK_SECONDS = 50  # Apple's recognizer is most reliable on short files


class TranscribeError(RuntimeError):
    pass


def apple_helper() -> str | None:
    p = os.environ.get("FAVVAULT_APPLE_ASR")
    return p if p and os.access(p, os.X_OK) else None


def pick_engine(engine: str) -> str:
    if engine == "apple":
        if not apple_helper():
            raise TranscribeError("系统语音识别只能在 FavVault 应用里使用（命令行请改用 --asr mlx）")
        return engine
    if engine in ("mlx", "faster-whisper"):
        return engine
    if apple_helper():
        return "apple"
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


# ---------------- Hugging Face model download with progress ----------------
def ensure_hf_model(repo: str) -> str:
    """Return a local path for `repo`, downloading it with progress events if needed.
    Falls back to hf-mirror.com when huggingface.co is unreachable."""
    if Path(repo).expanduser().exists():
        return str(Path(repo).expanduser())
    from huggingface_hub import snapshot_download  # type: ignore

    try:
        return snapshot_download(repo, local_files_only=True)
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
            total = _repo_size(repo, ep)
            with _ByteProgress(repo, total):
                return snapshot_download(repo, endpoint=ep)
        except Exception as e:  # noqa: BLE001
            last = e
            log(f"model download from {ep} failed: {e}", level="warn")
    raise TranscribeError(f"模型下载失败：{last}")


def _repo_size(repo: str, endpoint: str) -> int:
    try:
        from huggingface_hub import HfApi  # type: ignore

        info = HfApi(endpoint=endpoint).model_info(repo, files_metadata=True)
        return sum(int(f.size or 0) for f in info.siblings or [])
    except Exception:  # noqa: BLE001 - progress is best effort
        return 0


class _ByteProgress:
    """Polls the Hugging Face cache folder for `repo` and emits byte progress once a second.
    (snapshot_download does not expose per-byte callbacks.)"""

    def __init__(self, repo: str, total: int):
        import threading

        from huggingface_hub.constants import HF_HUB_CACHE  # type: ignore

        self.dir = Path(HF_HUB_CACHE) / ("models--" + repo.replace("/", "--"))
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
