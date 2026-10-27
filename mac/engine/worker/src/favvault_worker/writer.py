"""Write a note into the Obsidian vault as plain Markdown.

Path: <vault>/Knowledge/<收藏夹>/<组>/<子类>/<标题>.md
"""
from __future__ import annotations

import re
import unicodedata
from datetime import datetime
from pathlib import Path

ILLEGAL = re.compile(r'[\\/:*?"<>|#^\[\]\x00-\x1f]')
PLATFORM_NAMES = {"douyin": "抖音", "xhs": "小红书"}


def nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s)


def clean_name(name: str, max_len: int = 80) -> str:
    name = nfc(ILLEGAL.sub(" ", name or ""))
    name = re.sub(r"\s+", " ", name).strip(" .")
    if len(name) > max_len:
        name = name[:max_len].rstrip(" .")
    return name or "未命名"


def yaml_str(s: str | None) -> str:
    if s is None:
        return '""'
    return '"' + str(s).replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ") + '"'


def note_path(vault: Path, folder: str | None, group: str, sub: str, title: str, item_id: str) -> Path:
    base = vault / "Knowledge" / clean_name(folder or "未分类收藏") / clean_name(group) / clean_name(sub)
    path = base / f"{clean_name(title)}.md"
    if path.exists() and f"id: {yaml_str(item_id)}" not in path.read_text(encoding="utf-8"):
        path = base / f"{clean_name(title, 70)}-{item_id[-6:]}.md"
    return path


def render(*, platform: str, item_id: str, url: str, author: str | None, published_at: str | None,
           folder: str | None, original_title: str, knowledge: dict, transcript: str,
           asr: str | None = None) -> str:
    k = knowledge
    title = k.get("title") or original_title
    tags = [clean_name(t, 30).replace(" ", "_") for t in k.get("tags", [])]
    fm = [
        "---",
        f"title: {yaml_str(title)}",
        f"source: {platform}",
        f"id: {yaml_str(item_id)}",
        f"url: {yaml_str(url)}",
        f"author: {yaml_str(author)}",
        f"published: {published_at or ''}",
        f"collected_folder: {yaml_str(folder)}",
        f"category: {yaml_str(k['category']['group'] + '/' + k['category']['sub'])}",
        f"content_type: {k.get('contentType', 'other')}",
        "tags:",
        *[f"  - {t}" for t in tags],
        f"processed_at: {datetime.now().astimezone().isoformat(timespec='seconds')}",
        f"asr: {yaml_str(asr)}" if asr else None,
        "---",
    ]
    lines = [l for l in fm if l is not None]
    lines += ["", f"# {title}", ""]
    if k.get("summary"):
        lines += [f"> {k['summary']}", ""]
    lines += [f"来源：[{PLATFORM_NAMES.get(platform, platform)} · {author or '未知作者'}]({url})"
              + (f" · {published_at}" if published_at else ""), ""]
    lines += ["## 关键观点", ""]
    for i, p in enumerate(k["keyPoints"], 1):
        lines.append(f"{i}. **{p['claim']}**")
        if p.get("evidence"):
            lines.append(f"    - 依据：{p['evidence']}")
    lines.append("")
    if k.get("actionItems"):
        lines += ["## 可执行要点", ""] + [f"- [ ] {a}" for a in k["actionItems"]] + [""]
    if k.get("verificationNeeds"):
        lines += ["## 待核实", ""]
        lines += [f"- {v['claim']}" + (f"（{v['why']}）" if v.get("why") else "") for v in k["verificationNeeds"]]
        lines.append("")
    lines += ["## 原文转写", "", "> [!note]- 展开转写稿"]
    lines += [f"> {l}" if l.strip() else ">" for l in transcript.splitlines()]
    lines.append("")
    return nfc("\n".join(lines))


def write_note(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".md.tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)
    return path
