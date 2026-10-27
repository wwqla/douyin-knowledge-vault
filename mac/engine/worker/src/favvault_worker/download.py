"""Download one video's audio with yt-dlp and read its metadata.

Douyin often requires fresh login cookies ("Fresh cookies (not necessarily logged in) are needed").
Pass cookies either from a browser profile (`cookies_from_browser="safari"`) or a Netscape cookies file
(the Swift app exports one after QR login).
"""
from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from . import tools
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


def detect_platform(url: str) -> str:
    if DOUYIN_RE.search(url):
        return "douyin"
    if XHS_RE.search(url):
        return "xhs"
    return "other"


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
    return opts


def fetch(url: str, out_dir: Path, cookies_from_browser: str | None = None,
          cookies_file: Path | None = None) -> MediaInfo:
    try:
        import yt_dlp  # type: ignore
    except ImportError as e:  # pragma: no cover
        raise DownloadError("yt-dlp is not installed") from e

    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        with yt_dlp.YoutubeDL(_ydl_opts(out_dir, cookies_from_browser, cookies_file)) as ydl:
            info = ydl.extract_info(url, download=True)
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

    upload = info.get("upload_date")  # YYYYMMDD
    published = f"{upload[:4]}-{upload[4:6]}-{upload[6:]}" if upload and len(upload) == 8 else None
    return MediaInfo(
        platform=detect_platform(info.get("webpage_url") or url),
        item_id=str(info.get("id")),
        url=info.get("webpage_url") or url,
        title=(info.get("title") or info.get("description") or str(info.get("id"))).strip(),
        author=info.get("uploader") or info.get("creator") or info.get("channel"),
        description=info.get("description"),
        published_at=published,
        duration=float(info["duration"]) if info.get("duration") else probe_duration(path),
        tags=list(info.get("tags") or []),
        audio_path=path,
    )


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
