import json
import subprocess
import sys
from pathlib import Path

import pytest

from favvault_worker import tools, transcribe


@pytest.fixture
def fake_helper(tmp_path, monkeypatch):
    helper = tmp_path / "FavVault"
    helper.write_text(
        "#!" + sys.executable + "\n"
        "import json, sys\n"
        "print(json.dumps({'segments': [{'start': 1.0, 'end': 4.0, 'text': '大家好今天讲定投'}]}))\n"
    )
    helper.chmod(0o755)
    monkeypatch.setenv("FAVVAULT_APPLE_ASR", str(helper))
    return helper


def test_apple_engine_chunks_and_offsets(tmp_path, fake_helper, monkeypatch):
    audio = tmp_path / "a.wav"
    subprocess.run([tools.ffmpeg(), "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=70",
                    str(audio)], check=True)
    events = []
    monkeypatch.setattr(transcribe, "emit", lambda e, **kw: events.append((e, kw)))
    r = transcribe.transcribe(audio, "auto")
    assert r["engine"] == "apple"
    assert [s["start"] for s in r["segments"]] == [1.0, 51.0]  # two 50 s chunks, offset applied
    assert ("progress", {"stage": "transcribe", "done": 2, "total": 2}) in events


def test_apple_not_authorized(tmp_path, monkeypatch):
    helper = tmp_path / "FavVault"
    helper.write_text("#!" + sys.executable + "\nimport json,sys\nprint(json.dumps({'error':'x','code':'not_authorized'}))\nsys.exit(4)\n")
    helper.chmod(0o755)
    monkeypatch.setenv("FAVVAULT_APPLE_ASR", str(helper))
    audio = tmp_path / "a.wav"
    subprocess.run([tools.ffmpeg(), "-v", "error", "-f", "lavfi", "-i", "sine=duration=3", str(audio)], check=True)
    with pytest.raises(transcribe.TranscribeError, match="授权"):
        transcribe.transcribe(audio, "apple")


def test_pick_engine_without_helper(monkeypatch):
    monkeypatch.delenv("FAVVAULT_APPLE_ASR", raising=False)
    with pytest.raises(transcribe.TranscribeError):
        transcribe.pick_engine("apple")
