"use strict";
// 定时任务：~/Library/LaunchAgents/<label>.plist（替代 Windows 任务计划程序 schtasks）

const LABEL = "com.douyin.knowledge.sync";

function xmlEsc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}

/**
 * weekday: 0 = 每天；1(周一)~7(周日)。launchd 的 Weekday 0/7 都是周日，这里 7 → 0。
 */
function buildPlist({ label = LABEL, program, args = [], hour, minute, weekday = 0, logPath }) {
  const interval = [`    <key>Hour</key><integer>${Number(hour)}</integer>`, `    <key>Minute</key><integer>${Number(minute)}</integer>`];
  if (Number(weekday) >= 1 && Number(weekday) <= 7) interval.push(`    <key>Weekday</key><integer>${Number(weekday) % 7}</integer>`);
  const argv = [program, ...args].map((a) => `    <string>${xmlEsc(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEsc(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argv}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
${interval.join("\n")}
  </dict>
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Background</string>
${logPath ? `  <key>StandardOutPath</key><string>${xmlEsc(logPath)}</string>\n  <key>StandardErrorPath</key><string>${xmlEsc(logPath)}</string>\n` : ""}</dict>
</plist>
`;
}

/** 从 plist 文本解析出 {hour, minute, weekday} */
function parsePlistSchedule(text) {
  const num = (k) => {
    const m = new RegExp(`<key>${k}</key>\\s*<integer>(\\d+)</integer>`).exec(String(text || ""));
    return m ? Number(m[1]) : null;
  };
  const hour = num("Hour");
  const minute = num("Minute");
  if (hour === null || minute === null) return null;
  const wd = num("Weekday");
  return { hour, minute, weekday: wd === null ? 0 : (wd === 0 ? 7 : wd) };
}

/** 计算下次运行时间（本地时区）。weekday 0=每天，1~7=周一~周日 */
function nextRun({ hour, minute, weekday = 0 }, now = new Date()) {
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setHours(hour, minute);
  for (let i = 0; i < 8; i++) {
    const cand = new Date(d);
    cand.setDate(d.getDate() + i);
    const dow = cand.getDay() === 0 ? 7 : cand.getDay();
    if (cand > now && (!weekday || dow === Number(weekday))) return cand;
  }
  return null;
}

function fmtLocal(d) {
  if (!d) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

module.exports = { LABEL, buildPlist, parsePlistSchedule, nextRun, fmtLocal };
