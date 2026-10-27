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


ASR_CHOICES = ["auto", "apple", "sensevoice", "mlx", "faster-whisper"]


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

    engine = args.engine or "mlx"
    spec = transcribe.MODELS[engine]
    repo = args.model or spec["repo"]
    files = spec["files"]
    try:
        path = transcribe.ensure_hf_model(repo, files)
    except Exception as e:  # noqa: BLE001
        emit("error", code="model_download", message=str(e))
        return 1
    emit("model_ready", engine=engine, path=path, cacheDir=str(transcribe.hf_hub_cache()))
    return 0


def cmd_models(args) -> int:
    """Where models live and which are downloaded (no network)."""
    from . import transcribe

    emit("models", cacheDir=str(transcribe.hf_hub_cache()),
         models=[transcribe.model_status(e) for e in transcribe.MODELS])
    return 0


def cmd_transcribe(args) -> int:
    """Transcribe one local audio/video file and print the text (debugging / CI check)."""
    from pathlib import Path

    from . import transcribe

    s = apply_overrides(load_settings(), args)
    try:
        r = transcribe.transcribe(Path(args.file), s.asr_engine, s.asr_model)
    except Exception as e:  # noqa: BLE001
        emit("error", code="transcribe", message=f"{type(e).__name__}: {e}")
        return 1
    emit("transcript", engine=r["engine"], model=r["model"], language=r["language"],
         text=r["text"], segments=r["segments"])
    return 0


def cmd_doctor(args) -> int:
    import importlib.util

    from . import tools, transcribe

    has_mlx = bool(importlib.util.find_spec("mlx_whisper"))
    has_sv = bool(importlib.util.find_spec("sherpa_onnx"))
    whisper_ready = has_mlx and transcribe.model_status("mlx")["downloaded"]
    if has_mlx and not whisper_ready:  # also accept what huggingface_hub itself can resolve
        try:
            from huggingface_hub import snapshot_download  # type: ignore

            snapshot_download(transcribe.MLX_DEFAULT, local_files_only=True)
            whisper_ready = True
        except Exception:  # noqa: BLE001
            pass
    emit("doctor", ffmpeg=tools.ffmpeg(), ytdlp=bool(importlib.util.find_spec("yt_dlp")),
         mlx=has_mlx, whisperReady=whisper_ready,
         sensevoice=has_sv, senseVoiceReady=has_sv and transcribe.model_status("sensevoice")["downloaded"],
         hfCache=str(transcribe.hf_hub_cache()))
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
    pp.add_argument("--asr", choices=ASR_CHOICES)
    pp.add_argument("--retry-delay", type=float, default=RETRY_DELAY_SECONDS,
                    help="seconds before the single retry; negative disables")
    pp.set_defaults(func=cmd_process)

    sub.add_parser("status", help="counts per status and lock state").set_defaults(func=cmd_status)
    sub.add_parser("reset", help="clear a stuck sync.lock (refuses if still running)").set_defaults(func=cmd_reset)

    dm = sub.add_parser("download-model", help="download a speech model into the Hugging Face cache, with progress")
    dm.add_argument("--engine", choices=["mlx", "sensevoice"], default="mlx")
    dm.add_argument("--model", default="", help="override the Hugging Face repo")
    dm.set_defaults(func=cmd_download_model)
    sub.add_parser("models", help="model cache location and download status").set_defaults(func=cmd_models)
    tp = sub.add_parser("transcribe", help="transcribe a local audio/video file")
    tp.add_argument("file")
    tp.add_argument("--asr", choices=ASR_CHOICES)
    tp.set_defaults(func=cmd_transcribe)
    sub.add_parser("doctor", help="report installed components").set_defaults(func=cmd_doctor)

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
