"""Run one item through the pipeline, resuming from whatever stage it already reached.

discovered -> downloaded -> transcribed -> extracted -> written
A Skip at any stage marks the item skipped (never retried). Any other error marks it failed;
the caller retries once after 30 s, and later scheduled runs retry it for up to 3 days.
"""
from __future__ import annotations

import hashlib
import time
from pathlib import Path

from . import download, extract, transcribe, writer
from .config import Settings
from .events import emit, log
from .skip import Skip, check_transcript, classify_content
from .state import Item, StateDB

RETRY_DELAY_SECONDS = 30


def _url_key(url: str) -> str:
    return "url-" + hashlib.sha1(url.encode()).hexdigest()[:16]


def process_url(settings: Settings, db: StateDB, raw: str, folder: str | None = None,
                retry_delay: float = RETRY_DELAY_SECONDS) -> Item:
    url = download.extract_url(raw)
    platform = download.detect_platform(url)
    item = db.get(platform, _url_key(url)) or db.upsert_discovered(
        Item(platform=platform, item_id=_url_key(url), url=url, folder=folder))
    if folder and item.folder != folder:
        item = db.update(item, folder=folder)

    item = run_item(settings, db, item)
    if item.status == "failed" and retry_delay >= 0:
        log(f"failed at {item.stage}: {item.error}; retrying once in {int(retry_delay)}s", level="warn")
        emit("retry", delay=retry_delay)
        time.sleep(retry_delay)
        item = run_item(settings, db, item)
    return item


def run_item(settings: Settings, db: StateDB, item: Item) -> Item:
    if item.status in ("written", "skipped"):
        emit("item_done", status=item.status, note=item.note_path, error=item.error)
        return item
    if settings.vault_path is None:
        return db.mark_failed(item, "discovered", "vault path is not set (设置里选择 Obsidian 库)")

    data = dict(item.data or {})
    stage = _resume_stage(item, data)
    try:
        # 1. download
        if stage == "discovered":
            emit("stage", stage="download", url=item.url)
            media_file = getattr(settings, "media_file", None)
            if media_file and Path(media_file).exists():
                info = download.from_local(Path(media_file), item.url, getattr(settings, "media_meta", None) or {})
            else:
                info = download.fetch(item.url, settings.media_dir, settings.cookies_from_browser,
                                      settings.cookies_file)
            data.update({
                "realId": info.item_id, "description": info.description, "tags": info.tags,
                "duration": info.duration, "audio": str(info.audio_path),
            })
            item = db.update(item, title=info.title, author=info.author, published_at=info.published_at,
                             url=info.url, data=data, status="downloaded", stage="downloaded", error=None)
            ctype = classify_content(info.title, info.description, info.tags)
            if ctype:
                _cleanup(settings, data)
                raise Skip(f'contentType: "{ctype}"')
            stage = "downloaded"

        # 2. transcribe
        if stage == "downloaded":
            emit("stage", stage="transcribe", title=item.title)
            audio = Path(data["audio"])
            if not audio.exists():
                item = db.update(item, status="discovered", stage="discovered")
                raise RuntimeError("downloaded media missing; will re-download")
            tr = transcribe.transcribe(audio, settings.asr_engine, settings.asr_model,
                                     duration=data.get("duration"))
            try:
                check_transcript(tr["segments"], data.get("duration"))
            except Skip:
                db.update(item, status="media_frozen", stage="media_frozen")
                _cleanup(settings, data)
                raise
            data.update({"transcript": tr["text"], "asr": f"{tr['engine']}:{tr['model']}"})
            item = db.update(item, data=data, status="transcribed", stage="transcribed", error=None)
            _cleanup(settings, data)
            stage = "transcribed"

        # 3. extract
        if stage == "transcribed":
            emit("stage", stage="extract", title=item.title)
            k = extract.extract(
                base_url=settings.llm_base_url, api_key=settings.llm_api_key, model=settings.llm_model,
                title=item.title or "", author=item.author, description=data.get("description"),
                transcript=data["transcript"],
            )
            data["knowledge"] = k
            item = db.update(item, data=data, status="extracted", stage="extracted", error=None)
            stage = "extracted"

        # 4. write
        if stage == "extracted":
            emit("stage", stage="write", title=item.title)
            k = data["knowledge"]
            real_id = data.get("realId") or item.item_id
            path = writer.note_path(settings.vault_path, item.folder, k["category"]["group"],
                                    k["category"]["sub"], k.get("title") or item.title or real_id, real_id)
            content = writer.render(
                platform=item.platform, item_id=real_id, url=item.url, author=item.author,
                published_at=item.published_at, folder=item.folder, original_title=item.title or real_id,
                knowledge=k, transcript=data["transcript"], asr=data.get("asr"),
            )
            writer.write_note(path, content)
            item = db.update(item, status="written", stage="written", note_path=str(path), error=None)

    except Skip as s:
        item = db.mark_skipped(item, item.stage or stage, s.reason)
        log(f"skipped: {s.reason}", level="info")
    except Exception as e:  # noqa: BLE001 - every other error is a retryable failure
        item = db.mark_failed(item, item.stage or stage, f"{type(e).__name__}: {e}")
        log(f"failed: {item.error}", level="error")

    emit("item_done", status=item.status, stage=item.stage, note=item.note_path, error=item.error,
         title=item.title)
    return item


def _resume_stage(item: Item, data: dict) -> str:
    """Where to pick up. Failed items resume from the last stage whose output we still hold."""
    if data.get("knowledge"):
        return "extracted"
    if data.get("transcript"):
        return "transcribed"
    if data.get("audio") and Path(data["audio"]).exists():
        return "downloaded"
    return "discovered"


def _cleanup(settings: Settings, data: dict) -> None:
    if settings.keep_media:
        return
    audio = data.get("audio")
    if audio:
        Path(audio).unlink(missing_ok=True)
