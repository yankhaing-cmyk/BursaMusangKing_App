/* BursaMusangKing — PWA front end */
(() => {
  const CFG = window.BMK_CONFIG || {};
  const API = (CFG.WORKER_URL || "").replace(/\/+$/, "");
  const $ = (id) => document.getElementById(id);
  const C = window.BMKChart;

  const LABELS = {
    trending: "Trending",
    early_uptrend: "Early uptrend",
    reversal: "Reversal",
    gaining_momentum: "Gaining momentum",
  };

  let latest = null, weekly = null;
  const historyCache = {};
  let filter = null, current = null, view = "list";
  let pollTimer = null, resizeTimer = null;

  // ------------------------------------------------------------------ theme
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  function applyTheme(mode) {
    document.documentElement.setAttribute("data-theme", mode);
    $("theme").textContent = mode === "dark" ? "☀" : "◐";
    document.querySelector('meta[name="theme-color"]')
      .setAttribute("content", mode === "dark" ? "#1c1c1a" : "#ffffff");
    redraw();
  }
  let theme = localStorage.getItem("bmk-theme") || (media.matches ? "dark" : "light");
  applyTheme(theme);
  $("theme").onclick = () => {
    theme = theme === "dark" ? "light" : "dark";
    localStorage.setItem("bmk-theme", theme);
    applyTheme(theme);
  };
  media.addEventListener("change", (e) => {
    if (localStorage.getItem("bmk-theme")) return;
    theme = e.matches ? "dark" : "light";
    applyTheme(theme);
  });

  // Canvas has no CSS reflow, so anything that changes size or colour needs an
  // explicit repaint: theme flips, rotation, window resize.
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(redraw, 150);
  });

  function redraw() {
    if (view === "list" && latest) drawSparks();
    if (view === "detail" && current) drawDetail();
    if (view === "weekly" && weekly) C.line($("w-chart"), weekly.equity_curve || []);
  }

  // ----------------------------------------------------------------- banner
  function banner(msg, kind) {
    const el = $("banner");
    if (!msg) { el.className = "banner"; el.textContent = ""; return; }
    el.className = "banner show" + (kind === "err" ? " err" : "");
    el.textContent = msg;
  }

  // ------------------------------------------------------------------ fetch
  const DEMO = !API || API.includes("example.workers.dev");

  async function get(path) {
    if (DEMO) {
      const key = path.startsWith("/history") ? "history" : path.slice(1).split("?")[0];
      if (key === "status") {
        const l = await (await fetch("demo/latest.json")).json();
        return { latest: l.generated_at, weekly: null };
      }
      const r = await fetch(`demo/${key}.json`, { cache: "no-store" });
      if (!r.ok) throw new Error(`demo/${key}.json → ${r.status}`);
      const data = await r.json();
      const sym = new URLSearchParams(path.split("?")[1] || "").get("symbol");
      if (sym) {
        const series = (data.series || {})[sym];
        if (!series) throw new Error("unknown symbol");
        return { symbol: sym, bars: data.bars, series };
      }
      return data;
    }
    const r = await fetch(API + path, { cache: "no-store" });
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return r.json();
  }

  async function loadAll() {
    try {
      latest = await get("/latest");
      renderChips();
      renderList();
      $("updated").textContent = "Updated " + fmtTime(latest.generated_at);
    } catch (e) {
      banner("Couldn't load scan results. " + e.message, "err");
      $("count").textContent = "";
    }
    try {
      weekly = await get("/weekly");
      renderWeekly();
    } catch { /* weekly stays empty until the first review runs */ }
  }

  function fmtTime(iso) {
    if (!iso) return "–";
    return new Date(iso).toLocaleString(undefined, {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    });
  }

  // ------------------------------------------------------------------- list
  function visible() {
    if (!latest) return [];
    const all = latest.stocks || [];
    return filter ? all.filter((s) => s.strategy === filter) : all;
  }

  function renderChips() {
    const counts = {};
    (latest.stocks || []).forEach((s) => {
      counts[s.strategy] = (counts[s.strategy] || 0) + 1;
    });
    const strats = latest.strategies || Object.keys(counts);
    if (filter === null) filter = strats.find((s) => counts[s]) || strats[0];

    $("chips").innerHTML = strats.map((s) => `
      <button class="chip${s === filter ? " on" : ""}" data-s="${s}">
        ${LABELS[s] || s}<span class="n">${counts[s] || 0}</span>
      </button>`).join("");

    $("chips").querySelectorAll(".chip").forEach((c) => {
      c.onclick = () => { filter = c.dataset.s; renderChips(); renderList(); };
    });
  }

  function esc(s) {
    return String(s || "").replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function renderList() {
    const rows = visible();
    const cur = latest.currency || "";
    $("count").textContent =
      `${rows.length} match${rows.length === 1 ? "" : "es"} · ` +
      `${latest.stocks_screened} screened`;

    if (!rows.length) {
      $("list").innerHTML =
        `<p class="empty">No ${LABELS[filter] || filter} matches in this scan.</p>`;
      return;
    }

    $("list").innerHTML = rows.map((s, i) => {
      const dir = s.change_pct >= 0 ? "up" : "down";
      const sign = s.change_pct > 0 ? "+" : "";
      return `
      <div class="row" data-i="${i}">
        <div class="spark"><canvas id="sp${i}"></canvas></div>
        <div class="row-mid">
          <p class="name">${esc(s.symbol)}${s.is_new ? '<span class="badge">NEW</span>' : ""}</p>
          ${s.name ? `<p class="co">${esc(s.name)}</p>` : ""}
          <p class="sub">RSI ${s.rsi} · ADX ${s.adx} · Vol ${s.vol_ratio}x</p>
        </div>
        <div class="row-end">
          <p class="chg ${dir}">${sign}${s.change_pct}%</p>
          <p class="px">${cur} ${s.close}</p>
        </div>
      </div>`;
    }).join("");

    drawSparks();
    $("list").querySelectorAll(".row").forEach((r) => {
      r.onclick = () => openDetail(rows[+r.dataset.i]);
    });
  }

  function drawSparks() {
    visible().forEach((s, i) => {
      const el = $("sp" + i);
      if (el) C.sparkline(el, s.spark);
    });
  }

  // ----------------------------------------------------------------- detail
  async function openDetail(s) {
    current = s;
    show("detail");
    const cur = latest.currency || "";
    const cat = (LABELS[s.strategy] || s.strategy).toUpperCase();

    $("d-title").innerHTML =
      `${esc(s.symbol)}<span class="sep">|</span>` +
      `<span class="cat">${esc(cat)}</span><span class="sep">|</span>` +
      `<span class="stat">${cur}${s.close}</span>` +
      `<span class="stat">RSI ${s.rsi}</span>` +
      `<span class="stat">ADX ${s.adx}</span>` +
      `<span class="stat">Vol ${s.vol_ratio}x</span>` +
      `<span class="stat">ROC10 ${s.roc10}%</span>`;
    $("d-co").textContent = s.name || "";
    $("title").textContent = s.symbol;
    $("d-entry").textContent = s.entry != null ? `${cur} ${s.entry}` : "–";
    $("d-stop").textContent = s.stop != null ? `${cur} ${s.stop}` : "–";

    if (!historyCache[s.symbol]) {
      try {
        const r = await get("/history?symbol=" + encodeURIComponent(s.symbol));
        historyCache[s.symbol] = r.series;
      } catch {
        historyCache[s.symbol] = null;
      }
    }
    if (current === s) drawDetail();
  }

  function drawDetail() {
    const s = historyCache[current.symbol];
    if (s) {
      C.detail($("d-chart"), s);
    } else {
      // No 3-month history for this symbol — fall back to the 20-bar thumbnail
      // data so the screen still shows something rather than an empty box.
      C.detail($("d-chart"), Object.assign({ t: [], v: [] }, current.spark));
    }
  }

  $("back").onclick = () => { current = null; show("list"); };

  // ----------------------------------------------------------------- weekly
  function renderWeekly() {
    if (!weekly) return;
    const o = weekly.overall || {};
    const card = (l, v, cls) =>
      `<div class="c"><p>${l}</p><p class="${cls || ""}">${v}</p></div>`;

    $("w-cards").innerHTML = o.trades
      ? card("Win rate", o.win_rate + "%") +
        card("Profit factor", o.profit_factor ?? "–") +
        card("Signals", o.trades) +
        card("Worst", o.worst + "%", "down")
      : card("Win rate", "–") + card("Profit factor", "–") +
        card("Signals", "0") + card("Worst", "–");

    $("w-curve-label").textContent =
      `Cumulative signal performance · last ${weekly.lookback_weeks} weeks`;

    $("w-strats").innerHTML = (weekly.strategies || []).map((s) => {
      const h = s.horizons || {};
      const line = (n) => h[n]
        ? `+${n}d: ${h[n].win_rate}% win · avg ${h[n].avg > 0 ? "+" : ""}${h[n].avg}% (n=${h[n].n})`
        : null;
      const parts = [5, 10, 20].map(line).filter(Boolean);
      return `<div class="strat-block">
        <h3>${LABELS[s.strategy] || s.strategy} — ${s.signals} new signals</h3>
        ${parts.map((p) => `<p class="l">${p}</p>`).join("")}
        <p class="l">best ${esc(s.best.symbol)} ${s.best.ret > 0 ? "+" : ""}${s.best.ret}% ·
           worst ${esc(s.worst.symbol)} ${s.worst.ret > 0 ? "+" : ""}${s.worst.ret}%</p>
      </div>`;
    }).join("") || `<p class="empty">${esc(weekly.note || "No review data yet.")}</p>`;

    $("w-note").textContent = weekly.note || "";
    if (view === "weekly") C.line($("w-chart"), weekly.equity_curve || []);
  }

  // ------------------------------------------------------------------- nav
  function show(v) {
    view = v;
    ["list", "detail", "weekly"].forEach((x) => {
      $("view-" + x).hidden = x !== v;
    });
    document.querySelectorAll("nav button").forEach((b) => {
      b.classList.toggle("on", b.dataset.view === v ||
        (v === "detail" && b.dataset.view === "list"));
    });
    if (v !== "detail") {
      $("title").textContent = v === "weekly" ? "Weekly review" : "BursaMusangKing";
    }
    window.scrollTo(0, 0);
    // Canvases in a hidden section have zero width, so draw after they're shown.
    requestAnimationFrame(redraw);
  }
  document.querySelectorAll("nav button").forEach((b) => {
    b.onclick = () => { current = null; show(b.dataset.view); };
  });

  // ------------------------------------------------------------- run a scan
  $("run").onclick = async () => {
    if (DEMO) {
      banner("Demo mode — set WORKER_URL in config.js to run real scans.", "err");
      setTimeout(() => banner(null), 4000);
      return;
    }
    const btn = $("run");
    btn.disabled = true;
    banner("Queuing scan…");
    const before = latest ? latest.generated_at : null;

    try {
      const headers = { "Content-Type": "application/json" };
      if (CFG.RUN_TOKEN) headers["X-Run-Token"] = CFG.RUN_TOKEN;
      const r = await fetch(API + "/run", { method: "POST", headers, body: "{}" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.detail || j.error || r.status);
    } catch (e) {
      banner("Couldn't start the scan: " + e.message, "err");
      btn.disabled = false;
      return;
    }

    banner("Scanning the full market — this takes a few minutes. "
         + "Results refresh automatically.");
    pollForNew(before, Date.now() + (CFG.POLL_SECONDS || 420) * 1000);
  };

  function pollForNew(before, deadline) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      try {
        const st = await get("/status");
        if (st.latest && st.latest !== before) {
          Object.keys(historyCache).forEach((k) => delete historyCache[k]);
          await loadAll();
          banner("Scan complete — all screeners updated.");
          setTimeout(() => banner(null), 4000);
          $("run").disabled = false;
          return;
        }
      } catch { /* keep polling */ }

      if (Date.now() > deadline) {
        banner("Scan is taking longer than usual. It's still running on "
             + "GitHub — reload in a few minutes.", "err");
        $("run").disabled = false;
        return;
      }
      pollForNew(before, deadline);
    }, 10000);
  }

  // ---------------------------------------------------------------- startup
  if (DEMO) {
    banner("Demo mode — showing sample data. Set WORKER_URL in config.js "
         + "to connect your live scans.");
  }
  loadAll();

  // Register the shell cache, and reload once when a new worker takes over so
  // the installed app picks up deploys instead of serving an old shell forever.
  if ("serviceWorker" in navigator) {
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloaded) return;
      reloaded = true;
      location.reload();
    });
    navigator.serviceWorker.register("sw.js")
      .then((reg) => reg.update().catch(() => {}))
      .catch(() => {});
  }
})();
