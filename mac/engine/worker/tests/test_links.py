from favvault_worker import download


def test_detect_more_platforms():
    assert download.detect_platform("https://www.bilibili.com/video/BV1xx411c7mD") == "bilibili"
    assert download.detect_platform("https://b23.tv/abc") == "bilibili"
    assert download.detect_platform("https://youtu.be/dQw4w9WgXcQ") == "youtube"
    assert download.detect_platform("https://www.kuaishou.com/short-video/3x") == "kuaishou"
    assert download.detect_platform("https://example.com/v.mp4") == "other"


def test_srt_and_vtt_to_text():
    srt = "1\n00:00:01,000 --> 00:00:02,000\n大家好\n\n2\n00:00:02,000 --> 00:00:03,000\n<i>今天讲</i>\n"
    assert download.subtitle_to_text(srt, "srt") == "大家好\n今天讲"
    vtt = "WEBVTT\nKind: captions\n\n00:00.000 --> 00:01.000\nhello\n\n00:01.000 --> 00:02.000\nhello\nworld\n"
    assert download.subtitle_to_text(vtt, "vtt") == "hello\nworld"


def test_bilibili_json_subtitle():
    raw = '{"body":[{"from":0,"to":1,"content":"第一句"},{"from":1,"to":2,"content":"第二句"}]}'
    assert download.subtitle_to_text(raw, "json") == "第一句\n第二句"


def test_pick_subtitle_prefers_zh_and_skips_danmaku_and_translations():
    info = {"language": "en",
            "subtitles": {"danmaku": [{"ext": "xml", "url": "u0"}]},
            "automatic_captions": {"de-en": [{"ext": "vtt", "url": "u1"}], "en": [{"ext": "json3", "url": "u2"}, {"ext": "vtt", "url": "u3"}]}}
    assert download._pick_subtitles(info) == [("en", {"ext": "vtt", "url": "u3"})]
    info2 = {"subtitles": {"ai-zh": [{"ext": "srt", "url": "z"}], "en-US": [{"ext": "srt", "url": "e"}]}}
    assert [l for l, _ in download._pick_subtitles(info2)] == ["ai-zh", "en-US"]
    assert download._pick_subtitles({"subtitles": {}, "automatic_captions": {}}) == []
    info3 = {"subtitles": {"zh-cn": [{"ext": "vtt", "url": "x.m3u8", "protocol": "m3u8_native"}]}}
    assert download._pick_subtitles(info3) == []


def test_fetch_falls_back_to_browser_cookies(monkeypatch, tmp_path):
    calls = []

    def fake(url, out_dir, browser, cookies_file):
        calls.append(browser)
        if browser != "edge":
            raise download.DownloadError("ERROR: [youtube] x: Sign in to confirm you're not a bot")
        return "ok"

    monkeypatch.setattr(download, "_fetch_once", fake)
    monkeypatch.setenv("FAVVAULT_COOKIE_BROWSERS", "chrome,edge")
    assert download.fetch("https://youtu.be/x", tmp_path, None, tmp_path / "c.txt") == "ok"
    assert calls == [None, "chrome", "edge"]


def test_fetch_douyin_does_not_use_browser(monkeypatch, tmp_path):
    def fake(*a):
        raise download.DownloadError("Sign in to confirm")
    monkeypatch.setattr(download, "_fetch_once", fake)
    monkeypatch.setenv("FAVVAULT_COOKIE_BROWSERS", "chrome")
    import pytest
    with pytest.raises(download.DownloadError):
        download.fetch("https://v.douyin.com/abc/", tmp_path)
