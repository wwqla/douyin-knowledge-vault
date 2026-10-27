/* 抖音知识库 · Mac 版界面补充：处理组件安装 / 模型下载 / 知识库文件夹选择 / 蒸馏页说明
   在 app.js 之后加载；app.js 里的函数声明是全局的，这里可以直接覆盖。 */
(function () {
  const $m = (id) => document.getElementById(id);
  let engine = null;
  let installBusy = false;
  let modelBusy = false;
  let overlayShownOnce = false;

  function setBar(id, pct) {
    const el = $m(id);
    if (!el) return;
    el.style.width = Math.max(0, Math.min(100, pct)) + "%";
    el.classList.toggle("bar-done", pct >= 100);
  }
  function setText(id, t) { const el = $m(id); if (el) el.textContent = t; }

  let engineExpanded = false;
  document.addEventListener("click", (ev) => {
    if (ev.target && ev.target.id === "btn-engine-toggle") { engineExpanded = !engineExpanded; renderEngine(); }
  });
  function renderEngine() {
    const e = engine || {};
    const badge = $m("engine-badge");
    const ready = e.installed && e.asrReady;
    if (badge) {
      badge.textContent = ready ? "已就绪 ✓" : (e.installed ? "还差语音识别模型" : "未安装");
      badge.style.color = "";
      badge.classList.toggle("badge-ok", !!ready);
      badge.classList.toggle("badge-warn", !ready);
    }
    const ib = $m("btn-engine-install");
    if (!installBusy) {
      if (e.installed) {
        setText("engine-state", "已安装 ✓");
        setBar("engine-bar", 100);
        setText("engine-msg", `下载工具 ${e.ytdlp ? "✓" : "✗"} · ffmpeg ${e.ffmpeg ? "✓" : "✗"} · SenseVoice ${e.sensevoice ? "✓" : "—"} · Whisper ${e.mlx ? "✓" : "—"}`);
        if (ib) { ib.textContent = "重新安装 / 修复"; ib.classList.remove("primary"); ib.disabled = false; }
      } else {
        setText("engine-state", e.broken ? "需要修复" : "未安装");
        setBar("engine-bar", 0);
        setText("engine-msg", e.error || "点「一键安装」自动下载并安装（约 300~800 MB，需联网）。");
        if (ib) { ib.textContent = "一键安装"; ib.classList.add("primary"); ib.disabled = false; }
      }
    }
    renderModels();
    // 都就绪后折叠成一行（安装/下载中或用户点了「管理」时保持展开）
    const busy = installBusy || !!modelBusyEngine;
    const panel = $m("engine-panel");
    const tg = $m("btn-engine-toggle");
    if (panel && tg) {
      tg.hidden = !ready || busy;
      const collapse = ready && !busy && !engineExpanded;
      panel.classList.toggle("collapsed", collapse);
      tg.textContent = collapse ? "管理" : "收起";
      setText("engine-summary", collapse ? `· ${ENGINE_NAMES[e.asrEngine || "sensevoice"] || ""} 语音识别` : "");
    }
    // 首次引导浮层
    const ov = $m("engine-overlay");
    if (ov && !ov.hidden && ready) ov.hidden = true;
  }

  const fmtSize = (b) => (!b ? "0 MB" : b >= 1073741824 ? (b / 1073741824).toFixed(1) + " GB" : Math.round(b / 1048576) + " MB");
  const ENGINE_NAMES = { sensevoice: "SenseVoice", whisper: "Whisper" };
  let modelBusyEngine = null;

  function renderModels() {
    const e = engine || {};
    const cur = e.asrEngine || "sensevoice";
    const sel = $m("asr-select");
    if (sel) { sel.value = cur; sel.disabled = !!modelBusy; }
    setText("model-state", e.asrReady ? `${ENGINE_NAMES[cur]} 已就绪 ✓` : (e.installed ? `${ENGINE_NAMES[cur]} 未就绪` : "先完成 ①"));
    const models = e.models || {};
    for (const k of ["sensevoice", "whisper"]) {
      const m = models[k] || {};
      const row = $m("model-row-" + k);
      if (row) { row.classList.toggle("current", k === cur); row.hidden = k !== cur && !(m.downloaded); }
      const btn = $m("btn-model-" + k);
      if (modelBusy && modelBusyEngine === k) continue; // 进度由事件更新
      const intelWhisper = k === "whisper" && e.isArm === false;
      const exp = m.expectedSize || (e.engines && e.engines[k] && e.engines[k].size) || 0;
      if (intelWhisper) {
        setText("model-state-" + k, "首次转写时自动下载");
        setBar("model-bar-" + k, 0);
        setText("model-msg-" + k, "Intel Mac 使用 faster-whisper 小模型");
        if (btn) { btn.hidden = true; }
        continue;
      }
      if (btn) btn.hidden = false;
      if (m.downloaded) {
        setText("model-state-" + k, "已下载 ✓ · " + fmtSize(m.size));
        setBar("model-bar-" + k, 100);
        setText("model-msg-" + k, m.path || "");
        if (btn) { btn.textContent = "在访达中显示"; btn.disabled = false; btn.classList.remove("primary"); btn.dataset.act = "reveal"; }
      } else {
        setText("model-state-" + k, "未下载 · 约 " + fmtSize(exp));
        setBar("model-bar-" + k, 0);
        setText("model-msg-" + k, k === cur ? "当前引擎需要这个模型（自动尝试国内镜像，断点续传）" : "");
        if (btn) {
          btn.textContent = "下载";
          btn.disabled = !e.installed || !!modelBusy;
          btn.classList.toggle("primary", k === cur && !!e.installed);
          btn.dataset.act = "download";
        }
      }
    }
    setText("models-dir", e.modelsDir || "—");
    setText("models-dir-kind", e.modelsDirCustom ? "自定义文件夹" : "标准 Hugging Face 缓存");
    const rb = $m("btn-models-reset");
    if (rb) rb.hidden = !e.modelsDirCustom;
  }

  async function refreshEngine(cached) {
    try { engine = await window.api.engineStatus({ cached: !!cached }); } catch (err) { engine = { installed: false, error: String(err) }; }
    if (engine && engine.installing) installBusy = true;
    if (engine && engine.modelDownloading) { modelBusy = true; modelBusyEngine = engine.modelDownloading; }
    renderEngine();
    return engine;
  }

  async function doInstall() {
    if (installBusy) return;
    installBusy = true;
    const ib = $m("btn-engine-install");
    if (ib) ib.disabled = true;
    setText("engine-state", "安装中…");
    setText("engine-msg", "准备中…");
    syncOverlay();
    const r = await window.api.engineInstall();
    installBusy = false;
    if (r && r.ok) {
      toast("处理组件安装完成");
      await refreshEngine(true);
      if (engine && engine.installed && !engine.asrReady && engine.needsModel) doModel();
    } else {
      await refreshEngine(true);
      setText("engine-state", "安装失败");
      setText("engine-msg", "安装失败：" + ((r && r.error) || "未知错误") + "（检查网络后点「一键安装」重试）");
      toast("处理组件安装失败", true);
    }
    syncOverlay();
  }

  async function doModel(which) {
    if (modelBusy) return;
    const k = typeof which === "string" ? which : ((engine && engine.asrEngine) || "sensevoice");
    if (engine && engine.models && engine.models[k] && engine.models[k].downloaded && engine.asrReady) { await refreshEngine(false); return; }
    modelBusy = true;
    modelBusyEngine = k;
    renderModels();
    setText("model-state-" + k, "下载中…");
    syncOverlay();
    const r = await window.api.engineDownloadModel(k);
    modelBusy = false;
    modelBusyEngine = null;
    if (r && r.ok) {
      toast(`${ENGINE_NAMES[k]} 模型已就绪`);
      await refreshEngine(false);
    } else {
      await refreshEngine(true);
      setText("model-state-" + k, "下载失败");
      setText("model-msg-" + k, "下载失败：" + ((r && r.error) || "未知错误") + "（可稍后重试，已下载部分会续传）");
      toast("模型下载失败", true);
    }
    syncOverlay();
  }

  async function setAsr(k) {
    if (modelBusy) return;
    const r = await window.api.engineSetAsr(k);
    if (r && r.ok) { engine = r; renderEngine(); toast(`已切换到 ${ENGINE_NAMES[k]}`); }
    if (engine && engine.installed && !engine.asrReady) {
      setText("model-msg", `切换后需要下载 ${ENGINE_NAMES[k]} 模型${engine[k === "sensevoice" ? "sensevoice" : "mlx"] ? "" : "（会先自动安装对应组件）"}，点对应的「下载」。`);
    } else setText("model-msg", "");
    syncOverlay();
  }

  window.api.onEngineProgress((p) => {
    if (!p) return;
    if (p.kind === "install") {
      installBusy = p.pct < 100;
      setBar("engine-bar", p.pct);
      setText("engine-state", p.pct >= 100 ? "已安装 ✓" : `安装中 ${p.pct}%`);
      if (p.msg) setText("engine-msg", p.msg);
    } else if (p.kind === "model") {
      const k = p.engine || modelBusyEngine || "sensevoice";
      modelBusy = p.pct < 100;
      modelBusyEngine = modelBusy ? k : null;
      setBar("model-bar-" + k, p.pct);
      setText("model-state-" + k, p.pct >= 100 ? "已下载 ✓" : `下载中 ${p.pct}%`);
      if (p.msg) { setText("model-msg-" + k, p.msg); setText("model-msg", p.msg); }
    }
    syncOverlay(p);
  });

  // ---------- 首次使用浮层：一键安装处理组件 ----------
  function buildOverlay() {
    if ($m("engine-overlay")) return;
    const ov = document.createElement("div");
    ov.id = "engine-overlay";
    ov.hidden = true;
    ov.innerHTML = `
      <div class="date-ask-card">
        <div class="date-ask-title">🧩 安装处理组件</div>
        <p class="date-ask-text">处理抖音收藏需要先安装<b>下载工具、Python 运行环境和本地语音识别（默认 SenseVoice，中文更快更准）</b>。点下面的按钮会自动完成，<b>不用打开终端，也不用装 Homebrew</b>。安装约 3~10 分钟，之后还要下载一次语音识别模型（SenseVoice 约 230 MB；可在设置里改用 Whisper）。</p>
        <div class="engine-ov-step"><span id="ov-step-label">① 处理组件</span><div class="bar-track"><div class="bar-fill" id="ov-bar"></div></div><div class="engine-msg" id="ov-msg"></div></div>
        <div class="date-ask-actions">
          <button class="btn primary" id="ov-go">一键安装</button>
          <button class="btn" id="ov-later">稍后再说</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    $m("ov-go").addEventListener("click", () => {
      if (engine && engine.installed && engine.needsModel && !engine.asrReady) doModel();
      else doInstall();
    });
    $m("ov-later").addEventListener("click", () => { ov.hidden = true; });
  }

  function syncOverlay(p) {
    const ov = $m("engine-overlay");
    if (!ov) return;
    const e = engine || {};
    const go = $m("ov-go");
    if (installBusy || (p && p.kind === "install" && p.pct < 100)) {
      setText("ov-step-label", "① 安装处理组件");
      if (p && p.kind === "install") { setBar("ov-bar", p.pct); setText("ov-msg", p.msg || ""); }
      if (go) { go.disabled = true; go.textContent = "安装中…"; }
    } else if (modelBusy || (p && p.kind === "model" && p.pct < 100)) {
      setText("ov-step-label", "② 下载语音识别模型");
      if (p && p.kind === "model") { setBar("ov-bar", p.pct); setText("ov-msg", p.msg || ""); }
      if (go) { go.disabled = true; go.textContent = "下载中…"; }
    } else if (e.installed && e.needsModel && !e.asrReady) {
      setText("ov-step-label", "② 下载语音识别模型");
      setBar("ov-bar", 0);
      const cur = e.asrEngine || "sensevoice";
      const exp = e.models && e.models[cur] ? e.models[cur].expectedSize : 0;
      setText("ov-msg", `${ENGINE_NAMES[cur]} 模型约 ${fmtSize(exp)}，下载到标准 Hugging Face 缓存，只需一次。`);
      if (go) { go.disabled = false; go.textContent = "下载语音识别模型"; }
    } else if (!e.installed) {
      setText("ov-step-label", "① 安装处理组件");
      setText("ov-msg", $m("engine-msg") ? $m("engine-msg").textContent : "");
      if (go) { go.disabled = false; go.textContent = e.broken ? "重新安装" : "一键安装"; }
    } else {
      ov.hidden = true;
    }
  }

  async function bootEngine() {
    buildOverlay();
    const e = await refreshEngine(false);
    if (!(e.installed && e.asrReady) && !overlayShownOnce) {
      const ov = $m("engine-overlay");
      // 欢迎弹窗还开着时，等它关掉再提示
      const fr = $m("first-run-overlay");
      const show = () => { ov.hidden = false; syncOverlay(); overlayShownOnce = true; };
      if (fr && !fr.hidden) {
        const obs = new MutationObserver(() => { if (fr.hidden) { obs.disconnect(); show(); } });
        obs.observe(fr, { attributes: true, attributeFilter: ["hidden"] });
      } else show();
    }
  }

  $m("btn-engine-install") && $m("btn-engine-install").addEventListener("click", doInstall);
  for (const k of ["sensevoice", "whisper"]) {
    const b = $m("btn-model-" + k);
    if (b) b.addEventListener("click", () => { if (b.dataset.act === "reveal") window.api.engineRevealModels(k); else doModel(k); });
  }
  $m("asr-select") && $m("asr-select").addEventListener("change", (ev) => setAsr(ev.target.value));
  $m("btn-models-reveal") && $m("btn-models-reveal").addEventListener("click", async () => {
    const r = await window.api.engineRevealModels();
    if (r && !r.ok) toast("打不开文件夹：" + (r.error || ""), true);
  });
  $m("btn-models-choose") && $m("btn-models-choose").addEventListener("click", async () => {
    const r = await window.api.engineChooseModelsDir();
    if (r && r.ok) { engine = r; renderEngine(); toast("模型文件夹已更改"); }
  });
  $m("btn-models-reset") && $m("btn-models-reset").addEventListener("click", async () => {
    const r = await window.api.engineResetModelsDir();
    if (r && r.ok) { engine = r; renderEngine(); toast("已恢复为标准 Hugging Face 缓存"); }
  });

  // ---------- 性能模式 ----------
  async function setupPerf() {
    const t = $m("perf-toggle");
    if (!t) return;
    let s = {};
    try { s = await window.api.getSettings(); } catch { /* ignore */ }
    const apply = (on) => {
      document.body.classList.toggle("perf", on);
      setText("perf-badge", on ? "已开启" : "已关闭");
      if (typeof applySkin === "function") applySkin(window.__dokSkin || s.skin || "lake");
    };
    t.checked = s.perfMode !== false;
    apply(t.checked);
    t.addEventListener("change", async () => {
      s = await window.api.saveSettings({ perfMode: t.checked });
      apply(t.checked);
      toast(t.checked ? "已开启性能模式" : "已关闭性能模式（液态玻璃）");
    });
  }
  setupPerf();

  // ---------- 知识库文件夹选择 ----------
  const pick = $m("btn-pick-vault");
  if (pick) {
    pick.addEventListener("click", async () => {
      const r = await window.api.pickVault();
      if (r && r.ok && r.path) {
        $m("set-vault").value = r.path;
        settings = await window.api.saveSettings({ vaultPath: r.path });
        toast("知识库文件夹已设置");
      }
    });
  }

  // ---------- 处理失败时如果是缺组件，直接提示去安装 ----------
  window.api.onLog((chunk) => {
    if (/还没安装处理组件|还没下载语音识别模型|处理组件不可用/.test(String(chunk))) {
      refreshEngine(true).then(() => {
        const ov = $m("engine-overlay");
        if (ov) { ov.hidden = false; syncOverlay(); }
      });
    }
  });

  // ---------- 扫码登录成功后自动刷新状态 ----------
  window.api.onDouyinLogin(() => {
    const stEl = $m("login-status");
    if (stEl) { stEl.textContent = "已登录 ✓"; stEl.className = "login-status ok"; }
    const out = $m("login-out");
    if (out) out.textContent += "扫码登录成功 ✓\n";
    toast("抖音登录成功");
  });

  // ---------- 关于与更新（应用内增量更新） ----------
  const fmtMB = (n) => (Number(n) / 1024 / 1024).toFixed(1) + " MB";
  let upd = { info: null, check: null, downloading: false, downloaded: "" };
  function showBtn(id, on) { const b = $m(id); if (b) b.hidden = !on; }
  function renderUpdate() {
    const i = upd.info || {};
    setText("update-version", i.version ? "v" + i.version : "—");
    setText("update-source", i.source === "update" ? `增量（安装包 v${i.bundledVersion}）` : "内置");
    setText("update-electron", i.electron ? "Electron " + i.electron : "—");
    const c = upd.check;
    const badge = $m("update-badge");
    showBtn("btn-update-download", false); showBtn("btn-update-restart", false); showBtn("btn-update-full", false);
    if (upd.downloaded) {
      setText("update-state", "已下载 v" + upd.downloaded);
      setBar("update-bar", 100);
      setText("update-msg", "新版本已下载并校验通过，点「重启生效」即可使用（数据、处理组件和语音模型都不受影响）。");
      showBtn("btn-update-restart", true);
      if (badge) { badge.textContent = "有更新待重启"; badge.style.color = "#fbbf24"; }
      return;
    }
    if (upd.downloading) { setText("update-state", "下载中…"); return; }
    if (!c) { setText("update-state", "—"); if (badge) badge.textContent = ""; return; }
    if (!c.ok) { setText("update-state", "检查失败"); setText("update-msg", c.error || ""); setBar("update-bar", 0); return; }
    if (!c.available) {
      setText("update-state", "已是最新 ✓"); setBar("update-bar", 100);
      setText("update-msg", `最新版本 v${c.latest}。`);
      if (badge) { badge.textContent = "已是最新"; badge.style.color = "#7ee787"; }
      return;
    }
    if (badge) { badge.textContent = "发现新版本 v" + c.latest; badge.style.color = "#fbbf24"; }
    setBar("update-bar", 0);
    if (c.needsFull) {
      setText("update-state", "需要下载完整安装包");
      setText("update-msg", `v${c.latest}：${c.fullReason || "内核有变化"}，这次没法只下载增量，需要下载完整安装包（.dmg）覆盖安装。${c.notes ? "\n更新内容：" + c.notes : ""}`);
      showBtn("btn-update-full", true);
      return;
    }
    setText("update-state", `新版本 v${c.latest}（${fmtMB(c.size)}）`);
    setText("update-msg", (c.badBefore ? "注意：这个版本上次启动失败已自动退回，可重新下载再试。\n" : "") + (c.notes ? "更新内容：" + c.notes : "只需下载几 MB，下载完重启生效。"));
    showBtn("btn-update-download", true);
  }
  async function refreshUpdateInfo() {
    try {
      const i = await window.api.updateInfo();
      upd.info = i;
      if (i.downloaded) upd.downloaded = i.downloaded;
      if (i.lastCheck) upd.check = i.lastCheck;
      if (i.downloading) upd.downloading = true;
    } catch { /* ignore */ }
    renderUpdate();
  }
  async function doUpdateCheck() {
    const b = $m("btn-update-check");
    if (b) b.disabled = true;
    setText("update-state", "检查中…"); setText("update-msg", "");
    try { upd.check = await window.api.updateCheck(); } catch (e) { upd.check = { ok: false, error: String(e) }; }
    if (b) b.disabled = false;
    renderUpdate();
  }
  async function doUpdateDownload() {
    if (upd.downloading) return;
    upd.downloading = true;
    showBtn("btn-update-download", false);
    setText("update-state", "下载中…"); setText("update-msg", "连接中…"); setBar("update-bar", 0);
    const r = await window.api.updateDownload();
    upd.downloading = false;
    if (r && r.ok) { upd.downloaded = r.version; toast("新版本已下载，重启生效"); }
    else { setText("update-msg", (r && r.error) || "下载失败"); }
    renderUpdate();
    if (r && !r.ok) setText("update-msg", r.error || "下载失败");
  }
  window.api.onUpdateProgress((p) => {
    upd.downloading = p.pct < 100;
    setText("update-state", p.pct >= 100 ? "校验完成" : `下载中 ${p.pct}%`);
    setBar("update-bar", p.pct);
    setText("update-msg", `${fmtMB(p.received)} / ${p.total ? fmtMB(p.total) : "?"}${p.source ? " · 来源 " + p.source : ""}`);
  });
  window.api.onUpdateStatus((s) => {
    if (s.phase === "checked") { upd.check = s.result; renderUpdate(); }
    else if (s.phase === "downloaded") { upd.downloading = false; upd.downloaded = s.result.version; renderUpdate(); toast(`新版本 v${s.result.version} 已下载，到「设置 › 关于与更新」点「重启生效」`); }
    else if (s.phase === "error") { upd.downloading = false; renderUpdate(); setText("update-msg", (s.result && s.result.error) || "下载失败"); }
  });
  $m("btn-update-check") && $m("btn-update-check").addEventListener("click", doUpdateCheck);
  $m("btn-update-download") && $m("btn-update-download").addEventListener("click", doUpdateDownload);
  $m("btn-update-restart") && $m("btn-update-restart").addEventListener("click", () => window.api.updateRestart());
  $m("btn-update-full") && $m("btn-update-full").addEventListener("click", () => {
    const c = upd.check || {};
    window.api.openReleaseUrl(c.dmgUrl || c.releaseUrl || "https://github.com/wwqla/douyin-knowledge-vault/releases");
  });

  // ---------- 界面字体（按需下载） ----------
  let fontList = [];
  const loadedFaces = new Set();
  let fontBusy = "";
  async function injectFont(key) {
    if (loadedFaces.has(key)) return true;
    const r = await window.api.fontsRead(key);
    if (!r || !r.data) return false;
    try {
      const face = new FontFace(r.family, r.data, { weight: r.weight || "normal", display: "swap" });
      await face.load();
      document.fonts.add(face);
      loadedFaces.add(key);
      return true;
    } catch (e) { return false; }
  }
  function currentFontKey() { const v = (settings && settings.vip) || {}; return v.font && v.font !== "default" ? v.font : "default"; }
  function renderFonts() {
    const grid = $m("font-grid");
    if (!grid) return;
    const cur = currentFontKey();
    const opts = [{ key: "default", name: "默认字体", ready: true, sys: true }, ...fontList];
    grid.innerHTML = opts.map((f) => `<button class="font-opt${f.key === cur ? " active" : ""}${fontBusy === f.key ? " busy" : ""}" data-font="${f.key}">${f.name}<small>${f.sys ? "系统苹方，无需下载" : (f.ready ? "已下载" : "需下载 " + fmtMB(f.size))}</small></button>`).join("");
    grid.querySelectorAll(".font-opt").forEach((b) => b.addEventListener("click", () => pickFont(b.dataset.font)));
    const ready = fontList.filter((f) => f.ready).length;
    setText("font-state", ready ? `已下载 ${ready}/${fontList.length}` : "");
  }
  async function refreshFonts() { try { fontList = await window.api.fontsList(); } catch { fontList = []; } renderFonts(); }
  // 覆盖 app.js 的同名函数：选中的字体未下载/未注入时先用系统字体，准备好再切换
  // eslint-disable-next-line no-global-assign
  applyVipFont = function () {
    const key = currentFontKey();
    const f = fontList.find((x) => x.key === key);
    if (key === "default" || !f) { document.body.style.fontFamily = ""; renderFonts(); return; }
    if (loadedFaces.has(key)) { document.body.style.fontFamily = f.css; renderFonts(); return; }
    document.body.style.fontFamily = "";
    if (f.ready) injectFont(key).then((ok) => { if (ok && currentFontKey() === key) document.body.style.fontFamily = f.css; });
    renderFonts();
  };
  async function pickFont(key) {
    if (fontBusy) { toast("正在下载字体，请稍候"); return; }
    const hint = $m("font-hint");
    if (key !== "default") {
      const f = fontList.find((x) => x.key === key);
      if (!f) return;
      if (!f.ready) {
        fontBusy = key; renderFonts();
        const track = $m("font-bar-track"); if (track) track.hidden = false;
        setBar("font-bar", 0);
        if (hint) hint.textContent = `正在下载「${f.name}」…`;
        const r = await window.api.fontsEnsure(key);
        fontBusy = ""; if (track) track.hidden = true;
        if (!r || !r.ok) { if (hint) hint.textContent = (r && r.error) || "下载失败，先继续使用系统字体"; await refreshFonts(); return; }
        await refreshFonts();
      }
      if (!(await injectFont(key))) { if (hint) hint.textContent = "字体文件加载失败，先继续使用系统字体"; return; }
    }
    settings = await window.api.saveSettings({ vip: { ...(settings.vip || {}), font: key } });
    applyVipFont();
    const name = key === "default" ? "默认字体" : fontList.find((x) => x.key === key).name;
    if (hint) hint.textContent = key === "default" ? "已恢复默认字体" : `已切换为「${name}」，重启后依然生效`;
    toast("界面字体：" + name);
  }
  window.api.onFontsProgress((p) => {
    setBar("font-bar", p.pct);
    const f = fontList.find((x) => x.key === p.key);
    const hint = $m("font-hint");
    if (hint) hint.textContent = `正在下载「${f ? f.name : p.key}」 ${p.pct}%（${fmtMB(p.received)} / ${p.total ? fmtMB(p.total) : "?"}${p.source ? " · " + p.source : ""}）`;
  });

  // ---------- 启动 ----------
  const wait = () => (typeof settings !== "undefined" && settings ? Promise.resolve() : new Promise((r) => setTimeout(() => wait().then(r), 200)));
  wait().then(() => {
    bootEngine();
    refreshUpdateInfo();
    refreshFonts().then(() => applyVipFont());
    window.api.authStatus(settings).then((res) => {
      const stEl = $m("login-status");
      if (!stEl) return;
      if (res && res.ok) { stEl.textContent = "已登录 ✓"; stEl.className = "login-status ok"; }
      else { stEl.textContent = "未登录"; stEl.className = "login-status"; }
    }).catch(() => {});
  });
})();
