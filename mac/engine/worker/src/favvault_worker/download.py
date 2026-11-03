"""Download one video's audio with yt-dlp and read its metadata.

Douyin often requires fresh login cookies ("Fresh cookies (not necessarily logged in) are needed").
Pass cookies either from a browser profile (`cookies_from_browser="safari"`) or a Netscape cookies file
(the Swift app exports one after QR login).
"""
from __future__ import annotations

import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from . import tools
from .events import emit, log
from .skip import Skip

DOUYIN_RE = re.compile(r"(?:douyin\.com|iesdouyin\.com)")
XHS_RE = re.compile(r"(?:xiaohongshu\.com|xhslink\.com)")
URL_IN_TEXT = re.compile(r"https?://[^\s，。！？、\u3000]+")


def extract_url(text: str) -> str:
    """Douyin/XHS 'share' text wraps the link in Chinese prose; pull the URL out."""
    m = URL_IN_TEXT.search(text.strip())
    if not m:
        raise ValueError("no URL found in input")
    return m.group(0).rstrip(").,;'\"")


PLATFORM_PATTERNS = [
    ("bilibili", re.compile(r"(?:bilibili\.com|b23\.tv)")),
    ("youtube", re.compile(r"(?:youtube\.com|youtu\.be)")),
    ("kuaishou", re.compile(r"(?:kuaishou\.com|chenzhongtech\.com)")),
    ("xigua", re.compile(r"(?:ixigua\.com)")),
    ("weibo", re.compile(r"(?:weibo\.com|weibo\.cn)")),
    ("tiktok", re.compile(r"(?:tiktok\.com)")),
    ("vimeo", re.compile(r"(?:vimeo\.com)")),
    ("twitter", re.compile(r"(?:twitter\.com|x\.com)")),
]


def detect_platform(url: str) -> str:
    if DOUYIN_RE.search(url):
        return "douyin"
    if XHS_RE.search(url):
        return "xhs"
    for name, rx in PLATFORM_PATTERNS:
        if rx.search(url):
            return name
    return "other"


SUB_TIME = re.compile(r"^\s*(?:\d+\s*$|\d{1,2}:\d{2}[:.,\d]*\s*-->)")
SUB_TAG = re.compile(r"<[^>]+>|\{\\[^}]*\}")


def subtitle_to_text(raw: str, ext: str = "") -> str:
    """srt / vtt / B站 json 字幕 → 纯文本（去时间轴、标签，合并滚动字幕的重复行）"""
    raw = raw.lstrip("\ufeff")
    if raw.lstrip().startswith("#EXTM3U"):
        return ""
    lines: list[str] = []
    if ext == "json" or raw.lstrip().startswith("{"):
        import json

        try:
            data = json.loads(raw)
            body = data.get("body") or [ev for ev in data.get("events", []) if ev.get("segs")]
            for b in body:
                t = b.get("content") if "content" in b else "".join(x.get("utf8", "") for x in b.get("segs", []))
                lines.append(str(t or "").strip())
        except Exception:  # noqa: BLE001
            return ""
    else:
        for ln in raw.splitlines():
            if not ln.strip() or ln.startswith(("WEBVTT", "Kind:", "Language:", "NOTE", "STYLE")) or SUB_TIME.match(ln):
                continue
            lines.append(SUB_TAG.sub("", ln).strip())
    out: list[str] = []
    for t in lines:
        if t and (not out or t != out[-1]):
            out.append(t)
    return "\n".join(out)


def _pick_subtitles(info: dict) -> list[tuple[str, dict]]:
    """优先作者上传的中文/英文/原语言字幕，其次 YouTube 原语言自动字幕。"""
    lang0 = (info.get("language") or "").lower()

    def rank(lang: str) -> int:
        l = lang.lower()
        if l.startswith("zh") or l in ("ai-zh",):
            return 0
        if lang0 and l.split("-")[0] == lang0.split("-")[0]:
            return 1
        if l.startswith("en"):
            return 2
        return 9

    def best(tracks: dict, auto: bool) -> list[tuple[str, dict]]:
        cands = []
        for lang, fmts in (tracks or {}).items():
            if lang in ("danmaku", "live_chat") or not fmts:
                continue
            if auto and "-" in lang and not lang.startswith("zh") and lang.lower() != lang0:
                continue  # 自动翻译出来的字幕不要
            r = rank(lang)
            if auto and r == 2 and lang0 and not lang0.startswith("en"):
                continue
            if r < 9:
                cands.append((r, lang, fmts))
        cands.sort(key=lambda c: c[0])
        order = {"srt": 0, "vtt": 1, "json": 2, "json3": 3}
        out = []
        for _, lang, fmts in cands:
            ok = sorted([f for f in fmts if f.get("url") and f.get("ext") in order
                         and not str(f.get("protocol", "")).startswith("m3u8") and ".m3u8" not in f["url"]],
                        key=lambda f: order[f["ext"]])
            if ok:
                out.append((lang, ok[0]))
        return out

    return (best(info.get("subtitles"), False) + best(info.get("automatic_captions"), True))[:3]


@dataclass
class MediaInfo:
    platform: str
    item_id: str
    url: str
    title: str
    author: str | None
    description: str | None
    published_at: str | None  # YYYY-MM-DD
    duration: float | None
    tags: list[str] = field(default_factory=list)
    audio_path: Path | None = None
    transcript: str | None = None  # 视频自带字幕时直接用字幕，跳过语音识别
    subtitle_lang: str | None = None


class DownloadError(RuntimeError):
    pass


def _ydl_opts(out_dir: Path, cookies_from_browser: str | None, cookies_file: Path | None) -> dict:
    opts: dict = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "format": "bestaudio/best",
        "outtmpl": str(out_dir / "%(extractor_key)s-%(id)s.%(ext)s"),
        "retries": 2,
        "socket_timeout": 30,
        "noplaylist": True,
    }
    if tools.ffmpeg():
        opts["ffmpeg_location"] = tools.ffmpeg()
    if cookies_file:
        opts["cookiefile"] = str(cookies_file)
    elif cookies_from_browser:
        opts["cookiesfrombrowser"] = (cookies_from_browser,)
    # YouTube 需要 JS 运行时：应用把自带的 Node（Electron）路径放在 FAVVAULT_NODE
    node = os.environ.get("FAVVAULT_NODE")
    runtimes: dict = {"deno": {}}
    if node and Path(node).exists():
        runtimes["node"] = {"path": node}
    opts["js_runtimes"] = runtimes
    opts["remote_components"] = ["ejs:github"]
    return opts


def _info_to_media(info: dict, url: str, path: Path | None) -> MediaInfo:
    upload = info.get("upload_date")  # YYYYMMDD
    published = f"{upload[:4]}-{upload[4:6]}-{upload[6:]}" if upload and len(upload) == 8 else None
    dur = float(info["duration"]) if info.get("duration") else (probe_duration(path) if path else None)
    return MediaInfo(
        platform=detect_platform(info.get("webpage_url") or url),
        item_id=str(info.get("id")),
        url=info.get("webpage_url") or url,
        title=(info.get("title") or info.get("description") or str(info.get("id"))).strip(),
        author=info.get("uploader") or info.get("creator") or info.get("channel"),
        description=info.get("description"),
        published_at=published,
        duration=dur,
        tags=list(info.get("tags") or []),
        audio_path=path,
    )


def fetch(url: str, out_dir: Path, cookies_from_browser: str | None = None,
          cookies_file: Path | None = None) -> MediaInfo:
    try:
        import yt_dlp  # type: ignore
    except ImportError as e:  # pragma: no cover
        raise DownloadError("yt-dlp is not installed") from e

    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        with yt_dlp.YoutubeDL(_ydl_opts(out_dir, cookies_from_browser, cookies_file)) as ydl:
            info = ydl.extract_info(url, download=False)
            if detect_platform(url) not in ("douyin", "xhs"):
                for lang, fmt in _pick_subtitles(info):
                    try:
                        raw = ydl.urlopen(fmt["url"]).read().decode("utf-8", "replace")
                        text = subtitle_to_text(raw, fmt.get("ext", ""))
                    except Exception as e:  # noqa: BLE001 - 字幕拿不到就退回下载音频
                        log(f"subtitle fetch failed ({lang}): {e}", level="info")
                        text = ""
                    if len(text) >= 30:
                        emit("subtitle", lang=lang, chars=len(text))
                        mi = _info_to_media(info, url, None)
                        mi.transcript, mi.subtitle_lang = text, lang
                        return mi
            info = ydl.process_ie_result(info, download=True)
            path = Path(ydl.prepare_filename(info))
    except Exception as e:  # yt_dlp.utils.DownloadError and friends
        raise DownloadError(str(e)) from e

    if not path.exists():
        candidates = sorted(out_dir.glob(f"*{info.get('id')}*"))
        if not candidates:
            raise DownloadError("download finished but file not found")
        path = candidates[0]

    if not has_audio_stream(path):
        path.unlink(missing_ok=True)
        raise Skip("media must contain complete audio stream")

    return _info_to_media(info, url, path)


def from_local(path: Path, url: str, meta: dict) -> MediaInfo:
    """A file the app already downloaded through its logged-in Douyin session (no yt-dlp)."""
    if not has_audio_stream(path):
        path.unlink(missing_ok=True)
        raise Skip("media must contain complete audio stream")
    item_id = str(meta.get("aweme_id") or path.stem.rsplit("-", 1)[-1])
    desc = str(meta.get("description") or "").strip()
    published = None
    try:
        ct = int(meta.get("create_time") or 0)
        if ct > 0:
            from datetime import datetime
            published = datetime.fromtimestamp(ct).strftime("%Y-%m-%d")
    except (TypeError, ValueError, OSError):
        published = None
    try:
        duration = float(meta.get("duration_seconds") or 0) or probe_duration(path)
    except (TypeError, ValueError):
        duration = probe_duration(path)
    return MediaInfo(
        platform="douyin",
        item_id=item_id,
        url=url,
        title=(desc.splitlines()[0].strip() if desc else "") or item_id,
        author=(meta.get("author") or None),
        description=desc or None,
        published_at=published,
        duration=duration,
        tags=[str(t) for t in (meta.get("tags") or []) if t],
        audio_path=path,
    )


def has_audio_stream(path: Path) -> bool:
    if not tools.ffprobe():
        return True  # cannot verify; let transcription decide
    out = subprocess.run(
        [tools.ffprobe(), "-v", "error", "-select_streams", "a", "-show_entries", "stream=index",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    )
    return bool(out.stdout.strip())


def probe_duration(path: Path) -> float | None:
    if not tools.ffprobe():
        return None
    out = subprocess.run(
        [tools.ffprobe(), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    )
    try:
        return float(out.stdout.strip())
    except ValueError:
        return None
