"""favvault-worker command line. The Swift app calls these with an argument array and reads
JSON lines from stdout. Exit codes: 0 ok, 1 item failed, 2 usage/config error, 3 lock busy.
"""
from __future__ import annotations

import argparse
import sys

from . import __version__, lock
from .config import load_settings
from .events import emit, log
from .pipeline import RETRY_DELAY_SECONDS, process_url
from .state import StateDB


def apply_overrides(s, args):
    """Command-line flags win over settings.json / environment."""
    from pathlib import Path

    if getattr(args, "vault", None):
        s.vault_path = Path(args.vault).expanduser()
    if getattr(args, "cookies", None):
        s.cookies_file = Path(args.cookies).expanduser()
        s.cookies_from_browser = None  # an explicit cookies file beats a browser profile
    elif getattr(args, "cookies_from_browser", None):
        s.cookies_from_browser = args.cookies_from_browser
    if getattr(args, "asr", None):
        s.asr_engine = args.asr
    return s


def cmd_process(args) -> int:
    s = apply_overrides(load_settings(), args)
    if s.cookies_file and not s.cookies_file.exists():
        emit("error", code="bad_input", message=f"cookies file not found: {s.cookies_file}")
        return 2
    try:
        with lock.SyncLock(s.lock_path) as lk:
            if lk.note:
                log(lk.note, level="warn")
            db = StateDB(s.db_path)
            try:
                item = process_url(s, db, args.url, folder=args.folder,
                                   retry_delay=args.retry_delay)
            finally:
                db.close()
    except lock.LockBusy as e:
        emit("error", code="lock_busy", message=str(e))
        return 3
    except Exception as e:  # never die silently: the app shows this message
        if isinstance(e, ValueError):
            emit("error", code="bad_input", message=str(e))
            return 2
        emit("error", code="crash", message=f"{type(e).__name__}: {e}")
        return 1
    return 0 if item.status in ("written", "skipped") else 1


def cmd_status(args) -> int:
    s = load_settings()
    db = StateDB(s.db_path)
    info = lock.read_lock(s.lock_path)
    emit("status", counts=db.counts(), lock=info,
         lockAlive=bool(info and lock.pid_alive(int(info.get("pid", -1)))),
         vault=str(s.vault_path) if s.vault_path else None,
         llmConfigured=bool(s.llm_api_key))
    db.close()
    return 0


def cmd_reset(args) -> int:
    s = load_settings()
    ok, msg = lock.reset(s.lock_path)
    emit("reset", ok=ok, message=msg)
    return 0 if ok else 3


def cmd_download_model(args) -> int:
    from . import transcribe

    try:
        path = transcribe.ensure_hf_model(args.model or transcribe.MLX_DEFAULT)
    except Exception as e:  # noqa: BLE001
        emit("error", code="model_download", message=str(e))
        return 1
    emit("model_ready", path=path)
    return 0


def cmd_doctor(args) -> int:
    import importlib.util

    from . import tools
    from .transcribe import MLX_DEFAULT

    whisper_ready = False
    if importlib.util.find_spec("mlx_whisper"):
        try:
            from huggingface_hub import snapshot_download  # type: ignore

            snapshot_download(MLX_DEFAULT, local_files_only=True)
            whisper_ready = True
        except Exception:  # noqa: BLE001
            pass
    emit("doctor", ffmpeg=tools.ffmpeg(), ytdlp=bool(importlib.util.find_spec("yt_dlp")),
         mlx=bool(importlib.util.find_spec("mlx_whisper")), whisperReady=whisper_ready)
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="favvault-worker")
    p.add_argument("--version", action="version", version=__version__)
    sub = p.add_subparsers(dest="cmd", required=True)

    pp = sub.add_parser("process", help="process one Douyin/XHS link (share text is fine)")
    pp.add_argument("url")
    pp.add_argument("--folder", help="收藏夹名，作为顶层分类")
    pp.add_argument("--vault", help="override the vault path")
    pp.add_argument("--cookies-from-browser", help="safari | chrome | edge | firefox")
    pp.add_argument("--cookies", help="Netscape cookies.txt (e.g. exported after QR login)")
    pp.add_argument("--asr", choices=["auto", "apple", "mlx", "faster-whisper"])
    pp.add_argument("--retry-delay", type=float, default=RETRY_DELAY_SECONDS,
                    help="seconds before the single retry; negative disables")
    pp.set_defaults(func=cmd_process)

    sub.add_parser("status", help="counts per status and lock state").set_defaults(func=cmd_status)
    sub.add_parser("reset", help="clear a stuck sync.lock (refuses if still running)").set_defaults(func=cmd_reset)

    dm = sub.add_parser("download-model", help="download the Whisper model with progress events")
    dm.add_argument("--model", default="")
    dm.set_defaults(func=cmd_download_model)
    sub.add_parser("doctor", help="report installed components").set_defaults(func=cmd_doctor)

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
