import json
import os
import time
from pathlib import Path

import httpx
import pytest

from favvault_worker import download, extract, lock, pipeline, writer
from favvault_worker.config import Settings
from favvault_worker.skip import Skip, check_transcript, classify_content
from favvault_worker.state import Item, StateDB

KNOWLEDGE = {
    "contentType": "knowledge",
    "title": "指数基金定投的三个误区",
    "summary": "定投不是越跌越买那么简单。",
    "category": {"group": "投资理财", "sub": "指数基金"},
    "tags": ["定投", "#指数基金"],
    "keyPoints": [{"claim": "定投要看估值", "evidence": "PE 分位低于 30% 时收益更高"}],
    "actionItems": ["设定止盈线"],
    "verificationNeeds": [],
}


# ---------- lock ----------
def test_lock_acquire_release(tmp_path):
    p = tmp_path / "sync.lock"
    with lock.SyncLock(p) as lk:
        assert p.exists() and lk.note is None
        with pytest.raises(lock.LockBusy):
            lock.SyncLock(p).acquire()
    assert not p.exists()


def test_stale_lock_cleared(tmp_path):
    p = tmp_path / "sync.lock"
    p.write_text(json.dumps({"pid": os.getpid(), "createdAt": time.time() - 7 * 3600}))
    note = lock.SyncLock(p).acquire()
    assert note and note.startswith("STALE-LOCK-CLEARED")


def test_dead_pid_lock_cleared_and_reset(tmp_path):
    p = tmp_path / "sync.lock"
    p.write_text(json.dumps({"pid": 999999, "createdAt": time.time()}))
    assert lock.reset(p) == (True, "STUCK-RESET")
    assert not p.exists()


def test_reset_refuses_live_pid(tmp_path):
    p = tmp_path / "sync.lock"
    p.write_text(json.dumps({"pid": os.getppid(), "createdAt": time.time()}))
    ok, msg = lock.reset(p)
    assert not ok and msg.startswith("running")


# ---------- skip rules ----------
def test_classify():
    assert classify_content("霸总短剧 第1集", None, None) == "shortdrama"
    assert classify_content("好物推广", None, None) == "ad"
    assert classify_content("如何读财报", None, None) is None


def test_transcript_rules():
    with pytest.raises(Skip, match="no usable"):
        check_transcript([], 60)
    with pytest.raises(Skip, match="cover enough"):
        check_transcript([{"start": 0, "end": 5, "text": "这是一段足够长的测试文本内容用于检查覆盖率"}], 100)
    check_transcript([{"start": 0, "end": 50, "text": "这是一段足够长的测试文本内容用于检查覆盖率"}], 100)


# ---------- extract ----------
def test_parse_and_validate_fenced():
    raw = "好的\n```json\n" + json.dumps(KNOWLEDGE, ensure_ascii=False) + "\n```"
    k = extract.validate(extract.parse_json(raw))
    assert k["tags"] == ["定投", "指数基金"]


@pytest.mark.parametrize("bad,msg", [
    ({**KNOWLEDGE, "contentType": "ad"}, "contentType"),
    ({**KNOWLEDGE, "keyPoints": []}, "keyPoints is empty"),
    ({**KNOWLEDGE, "verificationNeeds": [{"claim": ""}]}, r"verificationNeeds\[0\].claim is empty"),
])
def test_validate_skips(bad, msg):
    with pytest.raises(Skip, match=msg):
        extract.validate(bad)


def _llm_transport(payload: dict, seen: list):
    def handler(request: httpx.Request):
        seen.append(json.loads(request.content))
        assert request.headers["authorization"] == "Bearer sk-test"
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(payload, ensure_ascii=False)}}]})
    return httpx.MockTransport(handler)


def test_extract_http():
    seen = []
    client = httpx.Client(transport=_llm_transport(KNOWLEDGE, seen))
    k = extract.extract(base_url="https://x/v1", api_key="sk-test", model="m", title="t", author=None,
                        description=None, transcript="转写", client=client)
    assert k["category"]["sub"] == "指数基金"
    assert seen[0]["model"] == "m"


# ---------- writer ----------
def test_writer_paths_and_render(tmp_path):
    p = writer.note_path(tmp_path, "理财/收藏", "投资理财", "指数基金", 'a:b*c?"d', "7123")
    assert p.parent == tmp_path / "Knowledge" / "理财 收藏" / "投资理财" / "指数基金"
    assert p.name == "a b c d.md"
    md = writer.render(platform="douyin", item_id="7123", url="https://www.douyin.com/video/7123", author="作者",
                       published_at="2026-10-01", folder="理财", original_title="原标题",
                       knowledge=extract.validate(KNOWLEDGE), transcript="第一句\n第二句")
    assert md.startswith("---\ntitle: \"指数基金定投的三个误区\"")
    assert "1. **定投要看估值**" in md and "> 第二句" in md and "- [ ] 设定止盈线" in md


def test_extract_url_from_share_text():
    text = "3.07 复制打开抖音，看看【某某的作品】定投其实很简单 https://v.douyin.com/iABCdef/ L@w.Sy 09/12"
    assert download.extract_url(text) == "https://v.douyin.com/iABCdef/"
    assert download.detect_platform("https://v.douyin.com/iABCdef/") == "douyin"
    assert download.detect_platform("http://xhslink.com/a/xyz") == "xhs"


# ---------- pipeline end-to-end (download + ASR + LLM stubbed) ----------
@pytest.fixture
def env(tmp_path, monkeypatch):
    s = Settings(vault_path=tmp_path / "vault", llm_api_key="sk-test", home=tmp_path / "home")
    db = StateDB(s.db_path)
    audio = tmp_path / "a.m4a"

    def fake_fetch(url, out_dir, *a, **k):
        audio.write_bytes(b"x")
        return download.MediaInfo(platform="douyin", item_id="7123", url="https://www.douyin.com/video/7123",
                                  title="定投其实很简单", author="某某", description="", published_at="2026-10-01",
                                  duration=60.0, tags=[], audio_path=audio)

    segments = [{"start": 0, "end": 55, "text": "今天讲讲指数基金定投的三个误区，第一个误区是越跌越买"}]
    monkeypatch.setattr(download, "fetch", fake_fetch)
    monkeypatch.setattr(pipeline.transcribe, "transcribe",
                        lambda *a, **k: {"engine": "stub", "model": "x", "segments": segments,
                                         "text": segments[0]["text"]})
    monkeypatch.setattr(pipeline.extract, "extract", lambda **kw: extract.validate(KNOWLEDGE))
    yield s, db, audio, segments
    db.close()


def test_pipeline_happy_path(env):
    s, db, audio, _ = env
    item = pipeline.process_url(s, db, "看看 https://v.douyin.com/iABCdef/ 复制", folder="理财", retry_delay=-1)
    assert item.status == "written"
    note = Path(item.note_path)
    assert note.exists() and note.parent.name == "指数基金"
    assert not audio.exists()  # temp media cleaned
    # idempotent
    assert pipeline.process_url(s, db, "https://v.douyin.com/iABCdef/", retry_delay=-1).status == "written"


def test_pipeline_silent_video_skipped(env, monkeypatch):
    s, db, *_ = env
    monkeypatch.setattr(pipeline.transcribe, "transcribe",
                        lambda *a, **k: {"engine": "stub", "model": "x", "segments": [], "text": ""})
    item = pipeline.process_url(s, db, "https://v.douyin.com/silent/", retry_delay=-1)
    assert item.status == "skipped" and "no usable" in item.error


def test_pipeline_llm_failure_resumes_without_redownload(env, monkeypatch):
    s, db, *_ = env
    calls = {"n": 0}

    def flaky(**kw):
        calls["n"] += 1
        if calls["n"] == 1:
            raise extract.ExtractError("LLM HTTP 503")
        return extract.validate(KNOWLEDGE)

    fetches = {"n": 0}
    orig = download.fetch
    def counting_fetch(*a, **k):
        fetches["n"] += 1
        return orig(*a, **k)
    monkeypatch.setattr(download, "fetch", counting_fetch)
    monkeypatch.setattr(pipeline.extract, "extract", flaky)
    item = pipeline.process_url(s, db, "https://v.douyin.com/flaky/", retry_delay=0)
    assert item.status == "written" and calls["n"] == 2 and fetches["n"] == 1
    assert db.retryable() == []


# ---------- cli: --cookies ----------
def test_cli_cookies_file_overrides_browser(tmp_path):
    import argparse

    from favvault_worker.cli import apply_overrides

    s = Settings(home=tmp_path, cookies_from_browser="safari")
    ck = tmp_path / "cookies.txt"
    args = argparse.Namespace(vault=str(tmp_path / "v"), cookies=str(ck), cookies_from_browser=None, asr="mlx")
    apply_overrides(s, args)
    assert s.cookies_file == ck and s.cookies_from_browser is None
    assert s.vault_path == tmp_path / "v" and s.asr_engine == "mlx"


def test_cli_process_missing_cookies_file(tmp_path, monkeypatch, capsys):
    from favvault_worker.cli import main

    monkeypatch.setenv("FAVVAULT_HOME", str(tmp_path))
    rc = main(["process", "https://www.douyin.com/video/1", "--cookies", str(tmp_path / "nope.txt")])
    assert rc == 2
    ev = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert ev["event"] == "error" and "cookies file not found" in ev["message"]
