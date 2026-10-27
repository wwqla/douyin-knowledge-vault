"""JSON-lines event protocol between the worker and the Swift app (stdout)."""
from __future__ import annotations

import json
import sys
import time
from typing import Any


def emit(event: str, **fields: Any) -> None:
    payload = {"event": event, "ts": round(time.time(), 3), **fields}
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(message: str, level: str = "info", **fields: Any) -> None:
    emit("log", level=level, message=message, **fields)
