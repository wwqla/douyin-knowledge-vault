"""LLM distillation through any OpenAI-compatible Chat Completions API (DeepSeek, Kimi, Qwen, OpenAI...).

The user supplies their own key; nothing is bundled.
"""
from __future__ import annotations

import json
import re

import httpx

from .skip import Skip

SYSTEM_PROMPT = """你是知识整理助手。用户会给你一条短视频的标题、作者、简介和语音转写稿。
请提炼成结构化知识笔记，只输出一个 JSON 对象，不要输出任何其它文字。字段：
{
  "contentType": "knowledge|opinion|tutorial|news|story|ad|shortdrama|music|other",
  "title": "简洁的笔记标题（不超过 30 字，可改写原标题的标题党）",
  "summary": "一句话总结（不超过 60 字）",
  "category": {"group": "二级分类，如 投资理财", "sub": "三级分类，如 指数基金"},
  "tags": ["3-6 个中文标签，不带 #"],
  "keyPoints": [{"claim": "核心观点，一句话", "evidence": "视频里给出的依据、例子或数据"}],
  "actionItems": ["可以照着做的具体步骤，没有则空数组"],
  "verificationNeeds": [{"claim": "需要核实的说法", "why": "为什么存疑"}]
}
规则：
- 广告带货、短剧片段、纯音乐/无信息量内容，contentType 填 ad / shortdrama / music，其余字段可留空。
- keyPoints 至少 1 条、最多 8 条，claim 不能为空；忠于原文，不要编造视频没说的内容。
- 转写稿可能有同音错字，按上下文纠正。
- 使用简体中文。"""

SKIP_TYPES = {"ad", "shortdrama", "music"}


class ExtractError(RuntimeError):
    pass


def build_user_prompt(title: str, author: str | None, description: str | None, transcript: str,
                      max_chars: int = 24000) -> str:
    if len(transcript) > max_chars:
        transcript = transcript[:max_chars] + "\n（转写稿过长，已截断）"
    return (f"标题：{title}\n作者：{author or '未知'}\n简介：{(description or '').strip()[:500]}\n\n"
            f"转写稿：\n{transcript}")


def parse_json(text: str) -> dict:
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.S)
    if fence:
        text = fence.group(1)
    else:
        start, end = text.find("{"), text.rfind("}")
        if start != -1 and end > start:
            text = text[start:end + 1]
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise ExtractError(f"LLM did not return valid JSON: {e}") from e
    if not isinstance(data, dict):
        raise ExtractError("LLM JSON is not an object")
    return data


def validate(data: dict) -> dict:
    """Normalise fields; raise Skip for content types or empty knowledge we never want to retry."""
    ctype = str(data.get("contentType") or "other").strip().lower()
    if ctype in SKIP_TYPES:
        raise Skip(f'contentType: "{ctype}"')
    points = data.get("keyPoints") or []
    if not isinstance(points, list) or not points:
        raise Skip("knowledge field keyPoints is empty")
    clean_points = []
    for i, p in enumerate(points):
        if isinstance(p, str):
            p = {"claim": p, "evidence": ""}
        claim = str((p or {}).get("claim") or "").strip()
        if not claim:
            raise Skip(f"knowledge field keyPoints[{i}].claim is empty")
        clean_points.append({"claim": claim, "evidence": str(p.get("evidence") or "").strip()})
    needs = []
    for i, v in enumerate(data.get("verificationNeeds") or []):
        if isinstance(v, str):
            v = {"claim": v, "why": ""}
        claim = str((v or {}).get("claim") or "").strip()
        if not claim:
            raise Skip(f"knowledge field verificationNeeds[{i}].claim is empty")
        needs.append({"claim": claim, "why": str(v.get("why") or "").strip()})
    cat = data.get("category") or {}
    return {
        "contentType": ctype,
        "title": str(data.get("title") or "").strip(),
        "summary": str(data.get("summary") or "").strip(),
        "category": {
            "group": str(cat.get("group") or "未分组").strip() or "未分组",
            "sub": str(cat.get("sub") or "未细分").strip() or "未细分",
        },
        "tags": [str(t).strip().lstrip("#") for t in (data.get("tags") or []) if str(t).strip()][:8],
        "keyPoints": clean_points[:8],
        "actionItems": [str(a).strip() for a in (data.get("actionItems") or []) if str(a).strip()],
        "verificationNeeds": needs,
    }


def extract(*, base_url: str, api_key: str | None, model: str, title: str, author: str | None,
            description: str | None, transcript: str, timeout: float = 120.0,
            client: httpx.Client | None = None) -> dict:
    if not api_key:
        raise ExtractError("LLM API key is not set (设置里填写 API Key)")
    url = base_url.rstrip("/") + "/chat/completions"
    body = {
        "model": model,
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": build_user_prompt(title, author, description, transcript)},
        ],
    }
    zhipu = "bigmodel.cn" in base_url or "zhipuai" in base_url
    if zhipu and model.lower().startswith(("glm-4.5", "glm-4.6", "glm-4.7", "glm-5")):
        body["thinking"] = {"type": "disabled"}  # 提炼不需要深度思考，关掉更快
    headers = {"Authorization": f"Bearer {api_key}"}
    own = client is None
    client = client or httpx.Client(timeout=timeout)
    try:
        r = client.post(url, json=body, headers=headers)
        if r.status_code == 400 and "response_format" in r.text:
            body.pop("response_format")  # some compatible providers reject it
            r = client.post(url, json=body, headers=headers)
        if r.status_code == 400 and zhipu and '"1211"' in r.text and body["model"] != "glm-4.7-flash":
            body["model"] = "glm-4.7-flash"  # 智谱模型编码不存在：换当前免费模型重试
            body["thinking"] = {"type": "disabled"}
            r = client.post(url, json=body, headers=headers)
        if r.status_code >= 400:
            raise ExtractError(f"LLM HTTP {r.status_code}: {r.text[:300]}")
        content = r.json()["choices"][0]["message"]["content"]
    except httpx.HTTPError as e:
        raise ExtractError(f"LLM request failed: {e}") from e
    finally:
        if own:
            client.close()
    return validate(parse_json(content))
