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

  function renderEngine() {
    const e = engine || {};
    const badge = $m("engine-badge");
    const ready = e.installed && e.whisperReady;
    if (badge) {
      badge.textContent = ready ? "已就绪 ✓" : (e.installed ? "还差语音识别模型" : "未安装");
      badge.style.color = ready ? "#7ee787" : "#fbbf24";
    }
    const ib = $m("btn-engine-install");
    const mb = $m("btn-model-download");
    if (!installBusy) {
      if (e.installed) {
        setText("engine-state", "已安装 ✓");
        setBar("engine-bar", 100);
        setText("engine-msg", `下载工具 ${e.ytdlp ? "✓" : "✗"} · ffmpeg ${e.ffmpeg ? "✓" : "✗"} · 本地 Whisper ${e.mlx || !e.needsModel ? "✓" : "✗"}`);
        if (ib) { ib.textContent = "重新安装 / 修复"; ib.classList.remove("primary"); ib.disabled = false; }
      } else {
        setText("engine-state", e.broken ? "需要修复" : "未安装");
        setBar("engine-bar", 0);
        setText("engine-msg", e.error || "点「一键安装」自动下载并安装（约 300~800 MB，需联网）。");
        if (ib) { ib.textContent = "一键安装"; ib.classList.add("primary"); ib.disabled = false; }
      }
    }
    if (!modelBusy) {
      if (!e.needsModel) {
        setText("model-state", "无需单独下载");
        setBar("model-bar", 100);
        setText("model-msg", "Intel Mac 使用 faster-whisper，首次转写时自动下载小模型。");
        if (mb) mb.disabled = true;
      } else if (e.whisperReady) {
        setText("model-state", "已下载 ✓");
        setBar("model-bar", 100);
        if (mb) { mb.textContent = "重新检查"; mb.disabled = false; mb.classList.remove("primary"); }
      } else {
        setText("model-state", e.installed ? "未下载" : "先完成 ①");
        setBar("model-bar", 0);
        if (mb) { mb.textContent = "下载语音识别模型"; mb.disabled = !e.installed; mb.classList.toggle("primary", !!e.installed); }
      }
    }
    // 首次引导浮层
    const ov = $m("engine-overlay");
    if (ov && !ov.hidden && ready) ov.hidden = true;
  }

  async function refreshEngine(cached) {
    try { engine = await window.api.engineStatus({ cached: !!cached }); } catch (err) { engine = { installed: false, error: String(err) }; }
    if (engine && engine.installing) installBusy = true;
    if (engine && engine.modelDownloading) modelBusy = true;
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
      if (engine && engine.installed && !engine.whisperReady && engine.needsModel) doModel();
    } else {
      await refreshEngine(true);
      setText("engine-state", "安装失败");
      setText("engine-msg", "安装失败：" + ((r && r.error) || "未知错误") + "（检查网络后点「一键安装」重试）");
      toast("处理组件安装失败", true);
    }
    syncOverlay();
  }

  async function doModel() {
    if (modelBusy) return;
    if (engine && engine.whisperReady) { await refreshEngine(false); return; }
    modelBusy = true;
    const mb = $m("btn-model-download");
    if (mb) mb.disabled = true;
    setText("model-state", "下载中…");
    syncOverlay();
    const r = await window.api.engineDownloadModel();
    modelBusy = false;
    if (r && r.ok) {
      toast("语音识别模型已就绪");
      await refreshEngine(true);
    } else {
      renderEngine();
      setText("model-state", "下载失败");
      setText("model-msg", "下载失败：" + ((r && r.error) || "未知错误") + "（可稍后重试，已下载部分会续传）");
      toast("模型下载失败", true);
    }
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
      modelBusy = p.pct < 100;
      setBar("model-bar", p.pct);
      setText("model-state", p.pct >= 100 ? "已下载 ✓" : `下载中 ${p.pct}%`);
      if (p.msg) setText("model-msg", p.msg);
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
        <p class="date-ask-text">处理抖音收藏需要先安装<b>下载工具、Python 运行环境和本地语音识别（Whisper）</b>。点下面的按钮会自动完成，<b>不用打开终端，也不用装 Homebrew</b>。安装约 3~10 分钟，之后还要下载一次语音识别模型（约 1.6 GB）。</p>
        <div class="engine-ov-step"><span id="ov-step-label">① 处理组件</span><div class="bar-track"><div class="bar-fill" id="ov-bar"></div></div><div class="engine-msg" id="ov-msg"></div></div>
        <div class="date-ask-actions">
          <button class="btn primary" id="ov-go">一键安装</button>
          <button class="btn" id="ov-later">稍后再说</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    $m("ov-go").addEventListener("click", () => {
      if (engine && engine.installed && engine.needsModel && !engine.whisperReady) doModel();
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
    } else if (e.installed && e.needsModel && !e.whisperReady) {
      setText("ov-step-label", "② 下载语音识别模型");
      setBar("ov-bar", 0);
      setText("ov-msg", $m("model-msg") ? $m("model-msg").textContent : "");
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
    if (!(e.installed && e.whisperReady) && !overlayShownOnce) {
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
  $m("btn-model-download") && $m("btn-model-download").addEventListener("click", doModel);

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

  // ---------- 我的技能：Mac 版暂未提供蒸馏 ----------
  // eslint-disable-next-line no-global-assign
  loadSkillsPage = async function () {
    const grid = $m("skills-grid");
    const note = $m("skills-note");
    if (note) note.textContent = "Mac 版暂未提供知识蒸馏（仓颉引擎仅随 Windows 版提供）";
    if (grid) {
      grid.innerHTML = `<div class="panel" style="grid-column:1/-1">
        <div class="panel-title">Mac 版暂未提供</div>
        <p class="hint" style="margin-top:0">蒸馏技能包需要仓颉七阶段引擎，目前只随 Windows 版内置，Mac 版后续再加。<br/>
        想基于知识库提问，可以去「AI 问答」直接选择一个知识库分类。</p>
        <button class="btn" id="skills-go-chat">去 AI 问答</button></div>`;
      const b = $m("skills-go-chat");
      if (b) b.addEventListener("click", () => switchPage("distill"));
    }
  };

  // ---------- 启动 ----------
  const wait = () => (typeof settings !== "undefined" && settings ? Promise.resolve() : new Promise((r) => setTimeout(() => wait().then(r), 200)));
  wait().then(() => {
    bootEngine();
    window.api.authStatus(settings).then((res) => {
      const stEl = $m("login-status");
      if (!stEl) return;
      if (res && res.ok) { stEl.textContent = "已登录 ✓"; stEl.className = "login-status ok"; }
      else { stEl.textContent = "未登录"; stEl.className = "login-status"; }
    }).catch(() => {});
  });
})();
