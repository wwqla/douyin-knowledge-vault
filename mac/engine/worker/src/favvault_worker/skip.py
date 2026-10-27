"""Per-stage skip rules. A hit marks the item `skipped` for good (never retried)."""
from __future__ import annotations


class Skip(Exception):
    """Raise to mark the current item skipped at the current stage."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


AD_KEYWORDS = ("广告", "推广", "商务合作", "#ad", "限时优惠", "下单链接")
SHORTDRAMA_KEYWORDS = ("短剧", "第1集", "第一集", "全集", "大结局", "#短剧")

MIN_SEGMENTS = 1
MIN_TEXT_CHARS = 20
MIN_COVERAGE = 0.30  # transcript must span at least 30% of the media duration


def classify_content(title: str | None, description: str | None, tags: list[str] | None) -> str | None:
    """Cheap entry filter. Only catches the obvious; later stages catch the rest."""
    text = " ".join([title or "", description or "", " ".join(tags or [])])
    if any(k in text for k in SHORTDRAMA_KEYWORDS):
        return "shortdrama"
    if any(k in text for k in AD_KEYWORDS):
        return "ad"
    return None


def check_transcript(segments: list[dict], media_duration: float | None) -> None:
    usable = [s for s in segments if (s.get("text") or "").strip()]
    if len(usable) < MIN_SEGMENTS or sum(len(s["text"].strip()) for s in usable) < MIN_TEXT_CHARS:
        raise Skip("transcription produced no usable text segments")
    if media_duration and media_duration > 0:
        spoken = sum(max(0.0, float(s.get("end", 0)) - float(s.get("start", 0))) for s in usable)
        if spoken / media_duration < MIN_COVERAGE:
            raise Skip("transcription does not cover enough of the media timeline")
