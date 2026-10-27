"""sync.lock with three layers of self-healing (from the original Skill):
1. a lock older than 6 hours is treated as dead and cleared;
2. before a reset, the pid inside the lock is probed with kill(pid, 0);
3. the app exposes a one-click reset that calls `favvault-worker reset`.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

STALE_AFTER_SECONDS = 6 * 3600


class LockBusy(RuntimeError):
    pass


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists, owned by someone else
    return True


def read_lock(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None if not path.exists() else {"pid": -1, "createdAt": 0}


class SyncLock:
    def __init__(self, path: Path):
        self.path = path

    def acquire(self) -> str | None:
        """Take the lock. Returns a note when a stale lock was cleared."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        note = None
        info = read_lock(self.path)
        if info is not None:
            age = time.time() - float(info.get("createdAt", 0))
            alive = pid_alive(int(info.get("pid", -1)))
            if alive and age <= STALE_AFTER_SECONDS:
                raise LockBusy(f"sync already running (pid {info.get('pid')})")
            self.path.unlink(missing_ok=True)
            note = f"STALE-LOCK-CLEARED age={int(age // 60)}min alive={alive}"
        fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"pid": os.getpid(), "createdAt": time.time()}, f)
        return note

    def release(self) -> None:
        info = read_lock(self.path)
        if info and int(info.get("pid", -1)) == os.getpid():
            self.path.unlink(missing_ok=True)

    def __enter__(self):
        self.note = self.acquire()
        return self

    def __exit__(self, *exc):
        self.release()


def reset(path: Path) -> tuple[bool, str]:
    """One-click reset. Refuses when the owning process is still alive."""
    info = read_lock(path)
    if info is None:
        return True, "no lock"
    pid = int(info.get("pid", -1))
    if pid_alive(pid) and pid != os.getpid():
        return False, f"running (pid {pid})"
    path.unlink(missing_ok=True)
    return True, "STUCK-RESET"
