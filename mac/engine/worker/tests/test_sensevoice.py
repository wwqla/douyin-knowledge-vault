"""SenseVoice engine: engine selection, chunking, Hugging Face cache resolution (sherpa-onnx mocked)."""
import importlib.util
import json
import subprocess
import sys
import types
from pathlib import Path

import numpy as np
import pytest

from favvault_worker import cli, tools, transcribe

SR = transcribe.SAMPLE_RATE


# ---------- Hugging Face cache path resolution ----------
@pytest.fixture
def clean_hf_env(monkeypatch, tmp_path):
    for k in ("HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE", "HF_HOME", "XDG_CACHE_HOME"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    return tmp_path


def test_hf_cache_default(clean_hf_env):
    assert transcribe.hf_hub_cache() == clean_hf_env / "home" / ".cache" / "huggingface" / "hub"


def test_hf_cache_respects_env(clean_hf_env, monkeypatch):
    monkeypatch.setenv("XDG_CACHE_HOME", "/x/cache")
    assert transcribe.hf_hub_cache() == Path("/x/cache/huggingface/hub")
    monkeypatch.setenv("HF_HOME", "/data/hf")
    assert transcribe.hf_hub_cache() == Path("/data/hf/hub")
    monkeypatch.setenv("HF_HUB_CACHE", "/models")
    assert transcribe.hf_hub_cache() == Path("/models")


def test_hf_cache_matches_huggingface_hub(clean_hf_env, monkeypatch):
    if not importlib.util.find_spec("huggingface_hub"):
        pytest.skip("huggingface_hub not installed")
    monkeypatch.setenv("HF_HOME", str(clean_hf_env / "hfhome"))
    code = "from huggingface_hub import constants; print(constants.HF_HUB_CACHE)"
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True).stdout.strip()
    assert Path(out) == transcribe.hf_hub_cache()


def _fake_cache(cache: Path, repo: str, files: dict[str, bytes], sha: str = "abc123") -> Path:
    """Lay out a model the way huggingface_hub does: blobs + snapshots symlinks + refs/main."""
    root = cache / ("models--" + repo.replace("/", "--"))
    snap = root / "snapshots" / sha
    (root / "blobs").mkdir(parents=True, exist_ok=True)
    snap.mkdir(parents=True, exist_ok=True)
    (root / "refs").mkdir(exist_ok=True)
    (root / "refs" / "main").write_text(sha)
    for name, data in files.items():
        bname = f"{sha}-{name}"
        (root / "blobs" / bname).write_bytes(data)
        link = snap / name
        if link.is_symlink() or link.exists():
            link.unlink()
        link.symlink_to(Path("../../blobs") / bname)
    return snap


def test_cached_snapshot_and_status(clean_hf_env, monkeypatch):
    cache = clean_hf_env / "cache"
    monkeypatch.setenv("HF_HUB_CACHE", str(cache))
    assert transcribe.cached_snapshot(transcribe.SENSEVOICE_REPO, transcribe.SENSEVOICE_FILES) is None
    st = transcribe.model_status("sensevoice")
    assert st["downloaded"] is False and st["path"] is None and st["expectedSize"] > 200_000_000
    # only tokens.txt present -> not complete
    _fake_cache(cache, transcribe.SENSEVOICE_REPO, {"tokens.txt": b"a 0\n"})
    assert transcribe.cached_snapshot(transcribe.SENSEVOICE_REPO, transcribe.SENSEVOICE_FILES) is None
    snap = _fake_cache(cache, transcribe.SENSEVOICE_REPO, {"tokens.txt": b"a 0\n", "model.int8.onnx": b"x" * 10})
    assert transcribe.cached_snapshot(transcribe.SENSEVOICE_REPO, transcribe.SENSEVOICE_FILES) == snap
    st = transcribe.model_status("sensevoice")
    assert st["downloaded"] and st["path"] == str(snap) and st["size"] == 14
    assert st["repoDir"].startswith(str(cache))


def test_ensure_model_uses_cache_without_network(clean_hf_env, monkeypatch):
    cache = clean_hf_env / "cache"
    monkeypatch.setenv("HF_HUB_CACHE", str(cache))
    snap = _fake_cache(cache, transcribe.SENSEVOICE_REPO, {"tokens.txt": b"a", "model.int8.onnx": b"b"})
    # huggingface_hub must not even be imported when the model is already there
    monkeypatch.setitem(sys.modules, "huggingface_hub", None)
    events = []
    monkeypatch.setattr(transcribe, "emit", lambda e, **kw: events.append(e))
    assert transcribe.ensure_hf_model(transcribe.SENSEVOICE_REPO, transcribe.SENSEVOICE_FILES) == str(snap)
    assert "model_download" not in str(events)


def test_ensure_model_downloads_only_needed_files(clean_hf_env, monkeypatch):
    cache = clean_hf_env / "cache"
    monkeypatch.setenv("HF_HUB_CACHE", str(cache))
    calls = []

    def fake_snapshot_download(repo, **kw):
        calls.append(kw)
        if kw.get("local_files_only"):
            raise FileNotFoundError("not cached")
        return str(_fake_cache(cache, repo, {"tokens.txt": b"a", "model.int8.onnx": b"b"}))

    class FakeApi:
        def __init__(self, endpoint=None):
            pass

        def model_info(self, repo, files_metadata=True):
            sib = [types.SimpleNamespace(rfilename=n, size=s) for n, s in
                   (("model.int8.onnx", 100), ("model.onnx", 900), ("tokens.txt", 5))]
            return types.SimpleNamespace(siblings=sib)

    fake = types.ModuleType("huggingface_hub")
    fake.snapshot_download = fake_snapshot_download
    fake.HfApi = FakeApi
    monkeypatch.setitem(sys.modules, "huggingface_hub", fake)
    monkeypatch.setattr(transcribe, "emit", lambda e, **kw: None)
    monkeypatch.setattr(transcribe, "log", lambda *a, **kw: None)
    path = transcribe.ensure_hf_model(transcribe.SENSEVOICE_REPO, transcribe.SENSEVOICE_FILES)
    assert Path(path, "model.int8.onnx").exists()
    assert calls[-1]["allow_patterns"] == transcribe.SENSEVOICE_FILES  # never the 900 MB fp32 model
    assert transcribe._repo_size(transcribe.SENSEVOICE_REPO, "x", transcribe.SENSEVOICE_FILES) == 105


# ---------- engine selection ----------
def test_pick_engine_sensevoice(monkeypatch):
    monkeypatch.delenv("FAVVAULT_APPLE_ASR", raising=False)
    real = importlib.util.find_spec
    monkeypatch.setattr(transcribe.importlib.util, "find_spec",
                        lambda name, *a: object() if name == "sherpa_onnx" else (None if name in ("mlx_whisper", "faster_whisper") else real(name, *a)))
    assert transcribe.pick_engine("sensevoice") == "sensevoice"
    assert transcribe.pick_engine("auto") == "sensevoice"
    assert transcribe.pick_engine("mlx") == "mlx"  # explicit choice is kept


def test_pick_engine_sensevoice_missing(monkeypatch):
    monkeypatch.delenv("FAVVAULT_APPLE_ASR", raising=False)
    real = importlib.util.find_spec
    monkeypatch.setattr(transcribe.importlib.util, "find_spec",
                        lambda name, *a: None if name in ("sherpa_onnx",) else real(name, *a))
    with pytest.raises(transcribe.TranscribeError, match="SenseVoice"):
        transcribe.pick_engine("sensevoice")


def test_settings_engine_from_env(monkeypatch, tmp_path):
    from favvault_worker.config import load_settings

    monkeypatch.setenv("FAVVAULT_HOME", str(tmp_path))
    monkeypatch.setenv("FAVVAULT_ASR_ENGINE", "sensevoice")
    assert load_settings().asr_engine == "sensevoice"


# ---------- chunking ----------
def test_chunk_short_audio_single_chunk():
    s = np.zeros(SR * 12, dtype=np.float32)
    assert transcribe.chunk_bounds(s) == [(0, SR * 12)]
    assert transcribe.chunk_bounds(np.zeros(0, dtype=np.float32)) == []


def test_chunk_cuts_at_quiet_point_and_covers_everything():
    rng = np.random.default_rng(0)
    s = (rng.standard_normal(SR * 95) * 0.3).astype(np.float32)
    s[int(SR * 24.0):int(SR * 24.5)] = 0.0  # a pause at 24 s
    b = transcribe.chunk_bounds(s)
    assert b[0][0] == 0 and b[-1][1] == len(s)
    assert all(b[i][1] == b[i + 1][0] for i in range(len(b) - 1))  # contiguous, nothing lost
    assert 24.0 <= b[0][1] / SR <= 24.5  # first cut lands in the pause
    for a, e in b[:-1]:
        assert 20 <= (e - a) / SR <= 30
    assert (b[-1][1] - b[-1][0]) / SR <= 30


# ---------- transcription with a mocked sherpa-onnx ----------
class _FakeStream:
    def __init__(self):
        self.n = 0
        self.result = types.SimpleNamespace(text="", lang="")

    def accept_waveform(self, sr, samples):
        assert sr == SR
        self.n = len(samples)


class _FakeRecognizer:
    created = {}

    @classmethod
    def from_sense_voice(cls, **kw):
        cls.created = kw
        return cls()

    def create_stream(self):
        return _FakeStream()

    def decode_stream(self, st):
        secs = st.n / SR
        st.result.text = "" if secs < 1 else f"这是一段{int(round(secs))}秒的话。"
        st.result.lang = "<|zh|>"


def test_sensevoice_transcribe_long_audio(tmp_path, monkeypatch, clean_hf_env):
    cache = clean_hf_env / "cache"
    monkeypatch.setenv("HF_HUB_CACHE", str(cache))
    snap = _fake_cache(cache, transcribe.SENSEVOICE_REPO, {"tokens.txt": b"a", "model.int8.onnx": b"b"})
    monkeypatch.setitem(sys.modules, "sherpa_onnx", types.SimpleNamespace(OfflineRecognizer=_FakeRecognizer))
    monkeypatch.delenv("FAVVAULT_APPLE_ASR", raising=False)
    audio = tmp_path / "a.wav"
    subprocess.run([tools.ffmpeg(), "-v", "error", "-f", "lavfi", "-i", "sine=frequency=300:duration=70",
                    str(audio)], check=True)
    events = []
    monkeypatch.setattr(transcribe, "emit", lambda e, **kw: events.append((e, kw)))
    r = transcribe.transcribe(audio, "sensevoice")
    kw = _FakeRecognizer.created
    assert kw["model"] == str(snap / "model.int8.onnx") and kw["tokens"] == str(snap / "tokens.txt")
    assert kw["use_itn"] is True and kw["language"] in ("auto", "zh")
    assert r["engine"] == "sensevoice" and r["model"] == transcribe.SENSEVOICE_REPO and r["language"] == "zh"
    n = len(r["segments"])
    assert n == 3  # 70 s -> three chunks of 20-30 s
    assert r["segments"][0]["start"] == 0 and abs(r["segments"][-1]["end"] - 70) < 0.1
    assert r["text"].count("秒的话") == 3
    prog = [kw for e, kw in events if e == "progress"]
    assert prog[0] == {"stage": "transcribe", "done": 0, "total": 3}
    assert prog[-1] == {"stage": "transcribe", "done": 3, "total": 3}


def test_cli_models_and_transcribe(tmp_path, monkeypatch, capsys, clean_hf_env):
    cache = clean_hf_env / "cache"
    monkeypatch.setenv("HF_HUB_CACHE", str(cache))
    monkeypatch.setenv("FAVVAULT_HOME", str(tmp_path / "fv"))
    _fake_cache(cache, transcribe.SENSEVOICE_REPO, {"tokens.txt": b"a", "model.int8.onnx": b"b"})
    assert cli.main(["models"]) == 0
    ev = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert ev["event"] == "models" and ev["cacheDir"] == str(cache)
    by = {m["engine"]: m for m in ev["models"]}
    assert by["sensevoice"]["downloaded"] is True and by["mlx"]["downloaded"] is False

    monkeypatch.setitem(sys.modules, "sherpa_onnx", types.SimpleNamespace(OfflineRecognizer=_FakeRecognizer))
    monkeypatch.setattr(transcribe.importlib.util, "find_spec", lambda name, *a: object())
    audio = tmp_path / "b.wav"
    subprocess.run([tools.ffmpeg(), "-v", "error", "-f", "lavfi", "-i", "sine=duration=5", str(audio)], check=True)
    assert cli.main(["transcribe", str(audio), "--asr", "sensevoice"]) == 0
    out = [json.loads(x) for x in capsys.readouterr().out.strip().splitlines()]
    tr = [e for e in out if e["event"] == "transcript"][0]
    assert tr["engine"] == "sensevoice" and "5秒" in tr["text"]
