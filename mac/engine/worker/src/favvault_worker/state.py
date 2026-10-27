"""Pipeline state in SQLite. The knowledge itself lives only in the vault's .md files.

Status flow:  discovered -> downloaded -> transcribed -> extracted -> written
Terminal-ish: failed (retry within 3 days) | skipped (never retry) | media_frozen
"""
from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path

STAGES = ("discovered", "downloaded", "transcribed", "extracted", "written")
RETRY_WINDOW_SECONDS = 3 * 24 * 3600

SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
  platform      TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  url           TEXT NOT NULL,
  title         TEXT,
  author        TEXT,
  published_at  TEXT,
  folder        TEXT,
  status        TEXT NOT NULL DEFAULT 'discovered',
  stage         TEXT,
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  first_failed_at REAL,
  data          TEXT NOT NULL DEFAULT '{}',
  note_path     TEXT,
  created_at    REAL NOT NULL,
  updated_at    REAL NOT NULL,
  PRIMARY KEY (platform, item_id)
);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
"""


@dataclass
class Item:
    platform: str
    item_id: str
    url: str
    title: str | None = None
    author: str | None = None
    published_at: str | None = None
    folder: str | None = None
    status: str = "discovered"
    stage: str | None = None
    error: str | None = None
    attempts: int = 0
    first_failed_at: float | None = None
    data: dict | None = None
    note_path: str | None = None


class StateDB:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(path))
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)

    def close(self) -> None:
        self.conn.close()

    def upsert_discovered(self, item: Item) -> Item:
        now = time.time()
        self.conn.execute(
            """INSERT INTO items(platform,item_id,url,title,author,published_at,folder,created_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?)
               ON CONFLICT(platform,item_id) DO UPDATE SET
                 url=excluded.url,
                 title=COALESCE(excluded.title, items.title),
                 author=COALESCE(excluded.author, items.author),
                 published_at=COALESCE(excluded.published_at, items.published_at),
                 folder=COALESCE(excluded.folder, items.folder),
                 updated_at=excluded.updated_at""",
            (item.platform, item.item_id, item.url, item.title, item.author,
             item.published_at, item.folder, now, now),
        )
        self.conn.commit()
        return self.get(item.platform, item.item_id)  # type: ignore[return-value]

    def get(self, platform: str, item_id: str) -> Item | None:
        row = self.conn.execute(
            "SELECT * FROM items WHERE platform=? AND item_id=?", (platform, item_id)
        ).fetchone()
        return _row_to_item(row) if row else None

    def update(self, item: Item, **fields) -> Item:
        for k, v in fields.items():
            setattr(item, k, v)
        self.conn.execute(
            """UPDATE items SET url=?,title=?,author=?,published_at=?,folder=?,status=?,stage=?,error=?,
               attempts=?,first_failed_at=?,data=?,note_path=?,updated_at=? WHERE platform=? AND item_id=?""",
            (item.url, item.title, item.author, item.published_at, item.folder, item.status, item.stage,
             item.error, item.attempts, item.first_failed_at, json.dumps(item.data or {}, ensure_ascii=False),
             item.note_path, time.time(), item.platform, item.item_id),
        )
        self.conn.commit()
        return item

    def mark_failed(self, item: Item, stage: str, error: str) -> Item:
        return self.update(item, status="failed", stage=stage, error=error[:2000],
                           attempts=item.attempts + 1,
                           first_failed_at=item.first_failed_at or time.time())

    def mark_skipped(self, item: Item, stage: str, reason: str) -> Item:
        return self.update(item, status="skipped", stage=stage, error=reason)

    def retryable(self, now: float | None = None) -> list[Item]:
        """Failed items still inside the 3-day retry window."""
        now = now or time.time()
        rows = self.conn.execute(
            "SELECT * FROM items WHERE status='failed' AND first_failed_at >= ?",
            (now - RETRY_WINDOW_SECONDS,),
        ).fetchall()
        return [_row_to_item(r) for r in rows]

    def given_up(self, now: float | None = None) -> list[Item]:
        """Failed longer than 3 days: shown to the user to decide (止损看板)."""
        now = now or time.time()
        rows = self.conn.execute(
            "SELECT * FROM items WHERE status='failed' AND first_failed_at < ?",
            (now - RETRY_WINDOW_SECONDS,),
        ).fetchall()
        return [_row_to_item(r) for r in rows]

    def counts(self) -> dict[str, int]:
        rows = self.conn.execute("SELECT status, COUNT(*) c FROM items GROUP BY status").fetchall()
        return {r["status"]: r["c"] for r in rows}


def _row_to_item(row: sqlite3.Row) -> Item:
    d = dict(row)
    d.pop("created_at", None)
    d.pop("updated_at", None)
    d["data"] = json.loads(d.get("data") or "{}")
    return Item(**d)
