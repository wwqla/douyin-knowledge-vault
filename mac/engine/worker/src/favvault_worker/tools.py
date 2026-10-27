"""Locate ffmpeg/ffprobe. Falls back to the static ffmpeg shipped by imageio-ffmpeg, so users
never need Homebrew."""
from __future__ import annotations

import functools
import shutil


@functools.lru_cache(maxsize=1)
def ffmpeg() -> str | None:
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg  # type: ignore

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001
        return None


def ffprobe() -> str | None:
    return shutil.which("ffprobe")
