"use strict";
// WCAG 对比度检查（CI 用）：纯函数可在 node 里测试；browserCheck 以字符串注入渲染进程，
// 逐个检查弹窗/设置卡片里可见文字的前景色与实际背景（逐层混合半透明背景，最底层用皮肤平均色近似）。

// 各皮肤背景图（lite 版）的平均颜色，用 PIL 缩成 1×1 得到
const SKIN_AVG = {
  lake: [22, 40, 90], forest: [36, 60, 75], dawn: [187, 184, 179], meadow: [136, 181, 137],
  goldenpeak: [124, 129, 126], caiyun: [231, 227, 246], goldleaf: [48, 54, 49], reedlake: [131, 150, 155],
};

function parseColor(str) {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/.exec(String(str || ""));
  if (!m) return null;
  let a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  if (!Number.isFinite(a)) a = 1;
  return [+m[1], +m[2], +m[3], a];
}

/** 把带透明度的 top 叠在不透明 bottom 上 */
function blend(top, bottom) {
  const a = top[3] === undefined ? 1 : top[3];
  return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)).concat(1);
}

function luminance(c) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}

function contrastRatio(fg, bg) {
  const a = luminance(fg), b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function avgColor(list) {
  const n = list.length;
  return [0, 1, 2, 3].map((i) => list.reduce((s, c) => s + (c[i] === undefined ? 1 : c[i]), 0) / n);
}

/** 大字（≥24px，或 ≥18.66px 且加粗）只需 3:1，其余 4.5:1 */
function requiredRatio(fontSizePx, fontWeight) {
  const w = parseInt(fontWeight, 10) || 400;
  return fontSizePx >= 24 || (fontSizePx >= 18.66 && w >= 700) ? 3 : 4.5;
}

/** 渲染进程里执行：返回 { checked, failures: [{sel, text, ratio, need, fg, bg}] } */
function browserCheck(selectors, skinKey, isLight) {
  const parse = parseColor, mix = blend, ratioOf = contrastRatio, need = requiredRatio, avg = avgColor; // eslint-disable-line no-unused-vars
  const skin = SKIN_AVG_INJECT[skinKey] || [40, 40, 60]; // eslint-disable-line no-undef
  const overlay = isLight ? [255, 255, 255, 0.15] : [7, 11, 20, 0.45];
  const base = mix(overlay, skin.concat(1));
  const bgOf = (el) => {
    const layers = [];
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      let c = parse(cs.backgroundColor);
      if ((!c || c[3] === 0) && /gradient/.test(cs.backgroundImage)) {
        const stops = (cs.backgroundImage.match(/rgba?\([^)]+\)/g) || []).map(parse).filter(Boolean);
        if (stops.length) c = avg(stops);
      }
      if (c && c[3] > 0) { layers.push(c); if (c[3] >= 0.99) break; }
      if (e === document.body) break;
    }
    let bg = base;
    for (let i = layers.length - 1; i >= 0; i--) bg = mix(layers[i], bg);
    return bg;
  };
  const failures = [];
  let checked = 0;
  for (const sel of selectors) {
    for (const root of document.querySelectorAll(sel)) {
      const els = [root, ...root.querySelectorAll("*")];
      for (const el of els) {
        const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
        if (!own) continue;
        if (!el.getClientRects().length) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.1) continue;
        if (el.disabled || el.closest("[disabled]")) continue; // WCAG 不要求禁用控件
        if (cs.webkitTextFillColor && /rgba\(0, 0, 0, 0\)|transparent/.test(cs.webkitTextFillColor)) continue; // 渐变字
        let fg = parse(cs.color);
        if (!fg) continue;
        const bg = bgOf(el);
        if (fg[3] < 1) fg = mix(fg, bg);
        const r = ratioOf(fg, bg);
        const req = need(parseFloat(cs.fontSize), cs.fontWeight);
        checked++;
        if (r < req) {
          failures.push({ sel, el: el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : ""),
            text: el.textContent.trim().slice(0, 30), ratio: Math.round(r * 100) / 100, need: req,
            fg: fg.slice(0, 3).map(Math.round), bg: bg.slice(0, 3).map(Math.round) });
        }
      }
    }
  }
  return { checked, failures };
}

/** 拼出可以 executeJavaScript 的脚本 */
function browserScript(selectors, skinKey, isLight) {
  return `(() => {
    const SKIN_AVG_INJECT = ${JSON.stringify(SKIN_AVG)};
    ${parseColor.toString()}
    ${blend.toString()}
    ${luminance.toString()}
    ${contrastRatio.toString()}
    ${avgColor.toString()}
    ${requiredRatio.toString()}
    return (${browserCheck.toString()})(${JSON.stringify(selectors)}, ${JSON.stringify(skinKey)}, ${JSON.stringify(!!isLight)});
  })()`;
}

module.exports = { SKIN_AVG, parseColor, blend, luminance, contrastRatio, avgColor, requiredRatio, browserCheck, browserScript };
