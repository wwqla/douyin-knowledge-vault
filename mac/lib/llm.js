"use strict";
// OpenAI 兼容接口（DeepSeek / Kimi / 通义 / OpenAI …）直连：知识卡片、周报小结、AI 问答

function friendlyAIError(status, bodyText) {
  const t = String(bodyText || "").toLowerCase();
  if (status === 402 || /insufficient\s*_?\s*balance|insufficient\s*_?\s*quota|余额不足|no balance|payment required/.test(t)) {
    return "API Key 余额不足，请充值后重试";
  }
  if (status === 401) return "API Key 无效或已过期（401），去官网核对一下";
  if (status === 404) return "接口地址不对（404），检查 Base URL 结尾是不是 /v1";
  if (status === 429) return "AI 接口限流（429），稍后再试";
  return `AI 接口调用失败 ${status}：${String(bodyText || "").slice(0, 200)}`;
}

function llmConfig(settings) {
  const base = String((settings && settings.llmBaseUrl) || "").trim().replace(/\/+$/, "");
  const key = String((settings && settings.llmApiKey) || "").trim();
  const model = String((settings && settings.llmModel) || "deepseek-chat").trim() || "deepseek-chat";
  return { base, key, model };
}

/** 调用 chat/completions。返回 {ok, content, usage} 或 {ok:false, error} */
async function chat(settings, messages, { json = false, temperature = 0.4, timeoutMs = 180000, fetchImpl } = {}) {
  const { base, key, model } = llmConfig(settings);
  if (!base) return { ok: false, error: "还没填 AI 接口 Base URL（设置 → AI 接口配置）" };
  if (!key) return { ok: false, error: "还没填 API Key（设置 → AI 接口配置）" };
  const doFetch = fetchImpl || fetch;
  const body = { model, messages, temperature };
  if (json) body.response_format = { type: "json_object" };
  const send = async (b) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(b),
        signal: controller.signal,
      });
    } finally { clearTimeout(timer); }
  };
  try {
    let resp = await send(body);
    if (!resp.ok && resp.status === 400 && json) {
      const txt = await resp.text();
      if (/response_format/i.test(txt)) { delete body.response_format; resp = await send(body); }
      else return { ok: false, error: friendlyAIError(400, txt) };
    }
    if (!resp.ok) return { ok: false, error: friendlyAIError(resp.status, await resp.text()) };
    const data = await resp.json();
    const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
    if (!content) return { ok: false, error: "AI 返回为空" };
    return { ok: true, content, usage: data.usage || null, raw: data };
  } catch (err) {
    if (err && err.name === "AbortError") return { ok: false, error: "AI 接口超时，请稍后重试" };
    return { ok: false, error: "网络不通：" + String((err && err.message) || err) };
  }
}

function parseJsonLoose(text) {
  let t = String(text || "").trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence) t = fence[1];
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s !== -1 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

const CARD_SYSTEM = `你是知识整理助手。用户给你同一大分类下多条短视频笔记的标题、摘要和关键观点。
请整理成一张“知识卡片”，只输出一个 JSON 对象，不要输出其它文字。字段：
{
  "summary": "100 字以内的整体摘要",
  "consensus_points": [{"title": "观点标题", "statement": "观点陈述", "confirmed_by": 2, "source_videos": ["笔记标题A", "笔记标题B"]}],
  "knowledge_points": [{"title": "知识点", "detail": "具体内容", "source_video": "来源笔记标题"}],
  "mindmap": {"root": "大分类名", "children": [{"name": "分支", "children": [{"name": "要点"}]}]},
  "network": {"nodes": [{"id": "i1", "label": "观点", "type": "idea"}, {"id": "v1", "label": "笔记标题", "type": "video"}], "links": [{"source": "i1", "target": "v1", "relation": "印证"}]},
  "table": {"rows": [{"topic": "主题", "verdict": "速查结论"}]}
}
规则：
- consensus_points 只收录至少 2 条不同笔记都支持的观点，confirmed_by 是支持它的笔记数，按 confirmed_by 从高到低，最多 12 条。
- knowledge_points 收录只出现在单条笔记里但有价值的知识，最多 20 条。
- network 的 links.relation 只能是 "印证" 或 "补充"；节点 id 必须互相对应。
- mindmap 3-7 个分支；table 5-15 行。
- 忠于原文，不要编造笔记里没有的内容；使用简体中文。`;

function buildCardPrompt(major, notes, maxChars = 30000) {
  const lines = [];
  let used = 0;
  for (const n of notes) {
    const block = `### ${n.title || n.name}\n分类：${[n.group, n.sub].filter(Boolean).join(" / ")}\n摘要：${n.summary || "（无）"}\n观点：${(n.points || []).slice(0, 6).map((p, i) => `${i + 1}. ${p}`).join(" ")}\n`;
    if (used + block.length > maxChars) break;
    lines.push(block);
    used += block.length;
  }
  return `大分类：${major}\n共 ${notes.length} 条笔记（以下列出 ${lines.length} 条）：\n\n${lines.join("\n")}`;
}

function normalizeCard(card, major, count) {
  const arr = (x) => (Array.isArray(x) ? x : []);
  return {
    major,
    count,
    generatedAt: new Date().toISOString(),
    summary: String(card.summary || ""),
    consensus_points: arr(card.consensus_points).map((p) => ({
      title: String(p.title || ""), statement: String(p.statement || ""),
      confirmed_by: Number(p.confirmed_by || arr(p.source_videos).length || 2), source_videos: arr(p.source_videos).map(String),
    })).filter((p) => p.title || p.statement),
    knowledge_points: arr(card.knowledge_points).map((k) => ({
      title: String(k.title || ""), detail: String(k.detail || ""), source_video: String(k.source_video || ""),
    })).filter((k) => k.title || k.detail),
    mindmap: card.mindmap && typeof card.mindmap === "object"
      ? { root: String(card.mindmap.root || major), children: arr(card.mindmap.children) }
      : { root: major, children: [] },
    network: card.network && typeof card.network === "object"
      ? { nodes: arr(card.network.nodes), links: arr(card.network.links) }
      : { nodes: [], links: [] },
    table: { rows: arr(card.table && card.table.rows).map((r) => ({ topic: String(r.topic || ""), verdict: String(r.verdict || "") })) },
  };
}

/** 用某大类的笔记作为 AI 问答上下文 */
function buildKbContext(major, notes, maxChars = 40000) {
  let out = `知识库大类「${major}」共 ${notes.length} 篇笔记：\n\n`;
  for (const n of notes) {
    const block = `## ${n.title || n.name}（${[n.group, n.sub].filter(Boolean).join(" / ")}）\n${n.summary ? "摘要：" + n.summary + "\n" : ""}${(n.points || []).map((p) => "- " + p).join("\n")}\n\n`;
    if (out.length + block.length > maxChars) { out += "（笔记较多，以上为部分内容）\n"; break; }
    out += block;
  }
  return out;
}

// 接口地址换成别家、模型却还是默认 deepseek-chat 时，自动换成该平台的默认模型（否则会报「模型不存在」）
const PROVIDER_MODELS = [
  [/bigmodel\.cn|zhipuai/i, "glm-4.7-flash"],
  [/dashscope\.aliyuncs\.com/i, "qwen-plus"],
  [/moonshot\.(cn|ai)/i, "moonshot-v1-8k"],
  [/siliconflow\.cn/i, "deepseek-ai/DeepSeek-V3"],
  [/api\.openai\.com/i, "gpt-4o-mini"],
];
function defaultModelFor(base) {
  const hit = PROVIDER_MODELS.find(([re]) => re.test(String(base || "")));
  return hit ? hit[1] : "";
}
function fixModel(base, model) {
  const m = String(model || "").trim();
  // 智谱已下线/改名的旧模型编码（glm-4-flash、glm-4.5-flash）也换成当前免费的 glm-4.7-flash
  const stale = /bigmodel\.cn|zhipuai/i.test(String(base || "")) && /^glm-4(\.5)?-flash$/i.test(m);
  if (m && m !== "deepseek-chat" && !stale) return m;
  return defaultModelFor(base) || m || "deepseek-chat";
}
module.exports = { fixModel, defaultModelFor, chat, friendlyAIError, llmConfig, parseJsonLoose, CARD_SYSTEM, buildCardPrompt, normalizeCard, buildKbContext };
