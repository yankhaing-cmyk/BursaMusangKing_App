/* BursaMusangKing — PWA front end */
(() => {
  const CFG = window.BMK_CONFIG || {};
  const API = (CFG.WORKER_URL || "").replace(/\/+$/, "");
  const $ = (id) => document.getElementById(id);

  const LABELS = {
    trending: "Trending",
    early_uptrend: "Early uptrend",
    reversal: "Reversal",
    gaining_momentum: "Gaining momentum",
  };

  let latest = null, weekly = null, historyCache = {};
  let filter = null, sparks = [], detailChart = null, weeklyChart = null;
  let pollTimer = null;

  // ------------------------------------------------------------------ theme
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  function applyTheme(mode) {
    document.documentElement.setAttribute("data-theme", mode);
    $("theme").textContent = mode === "dark" ? "☀" : "◐";
    document.querySelector('meta[name="theme-color"]')
      .setAttribute("content", mode === "dark" ? "#1c1c1a" : "#ffffff");
    redrawCharts();
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

  function css(name) {
    return getComputedStyle(document.documentElement)
      .getPropertyValue(name).trim();
  }

  // ----------------------------------------------------------------- banner
  function banner(msg, kind) {
    const el = $("banner");
    if (!msg) { el.className = "banner"; el.textContent = ""; return; }
    el.className = "banner show" + (kind === "err" ? " err" : "");
    el.textContent = msg;
  }

  // ------------------------------------------------------------------ fetch
  // Demo mode: with no real Worker configured, read the sample JSON in ./demo
  // so you can see the app working before deploying anything.
  const DEMO = !API || API.includes("example.workers.dev");

  async function get(path) {
    let url;
    if (DEMO) {
      const key = path.startsWith("/history") ? "history" : path.slice(1).split("?")[0];
      if (key === "status") {
        const l = await (await fetch("demo/latest.json")).json();
        return { latest: l.generated_at, weekly: null };
      }
      url = `demo/${key}.json`;
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) throw new Error(`${url} → ${r.status}`);
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
    } catch { /* weekly is optional until the first review runs */ }
  }

  function fmtTime(iso) {
    if (!iso) return "–";
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
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

  function renderList() {
    const rows = visible();
    const cur = latest.currency || "";
    $("count").textContent =
      `${rows.length} match${rows.length === 1 ? "" : "es"} · ` +
      `${latest.stocks_screened} screened`;

    sparks.forEach((c) => c.destroy());
    sparks = [];

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
          <p class="name">${s.symbol}${s.is_new ? '<span class="badge">NEW</span>' : ""}</p>
          <p class="sub">RSI ${s.rsi} · ADX ${s.adx} · Vol ${s.vol_ratio}x</p>
        </div>
        <div class="row-end">
          <p class="chg ${dir}">${sign}${s.change_pct}%</p>
          <p class="px">${cur} ${s.close}</p>
        </div>
      </div>`;
    }).join("");

    rows.forEach((s, i) => {
      sparks.push(miniChart($(`sp${i}`), s.spark));
    });
    $("list").querySelectorAll(".row").forEach((r) => {
      r.onclick = () => openDetail(rows[+r.dataset.i]);
    });
  }

  function candleData(bars) {
    return bars.map((b, i) => ({ x: i, o: b.o, h: b.h, l: b.l, c: b.c }));
  }

  function miniChart(canvas, bars) {
    return new Chart(canvas, {
      type: "candlestick",
      data: { datasets: [{
        data: candleData(bars || []),
        borderWidth: 1,
        color: { up: css("--up"), down: css("--down"), unchanged: css("--faint") },
      }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        scales: { x: { display: false }, y: { display: false } },
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
      },
    });
  }

  // ----------------------------------------------------------------- detail
  async function openDetail(s) {
    show("detail");
    $("title").textContent = s.symbol;
    $("d-name").textContent = s.symbol;
    $("d-sub").textContent =
      `${LABELS[s.strategy] || s.strategy} · 3 month daily candles`;
    $("d-rsi").textContent = s.rsi;
    $("d-adx").textContent = s.adx;
    $("d-ema").textContent = s.ema20 ?? "–";
    $("d-vol").textContent = s.vol_ratio + "x";
    const cur = latest.currency || "";
    $("d-entry").textContent = s.entry != null ? `${cur} ${s.entry}` : "–";
    $("d-stop").textContent = s.stop != null ? `${cur} ${s.stop}` : "–";

    let bars = historyCache[s.symbol];
    if (!bars) {
      try {
        const r = await get("/history?symbol=" + encodeURIComponent(s.symbol));
        bars = r.series;
        historyCache[s.symbol] = bars;
      } catch {
        bars = s.spark;  // fall back to the 20-bar sparkline data
      }
    }
    drawDetail(bars, s);
  }

  function drawDetail(bars, s) {
    if (detailChart) detailChart.destroy();
    const sets = [{
      type: "candlestick",
      data: candleData(bars),
      color: { up: css("--up"), down: css("--down"), unchanged: css("--faint") },
    }];

    const lines = {
      id: "levels",
      afterDatasetsDraw(chart) {
        if (!s || s.entry == null) return;
        const { ctx, chartArea, scales } = chart;
        [[s.entry, css("--up")], [s.stop, css("--down")]].forEach(([v, col]) => {
          const y = scales.y.getPixelForValue(v);
          if (y < chartArea.top || y > chartArea.bottom) return;
          ctx.save();
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = col;
          ctx.beginPath();
          ctx.moveTo(chartArea.left, y);
          ctx.lineTo(chartArea.right, y);
          ctx.stroke();
          ctx.restore();
        });
      },
    };

    detailChart = new Chart($("d-chart"), {
      data: { datasets: sets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        scales: {
          x: { display: false },
          y: { grid: { color: css("--line") },
               ticks: { color: css("--faint"), font: { size: 10 } } },
        },
        plugins: { legend: { display: false } },
      },
      plugins: [lines],
    });
  }

  $("back").onclick = () => show("list");

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
    drawWeeklyChart();

    $("w-strats").innerHTML = (weekly.strategies || []).map((s) => {
      const h = s.horizons || {};
      const line = (n) => h[n]
        ? `+${n}d: ${h[n].win_rate}% win · avg ${h[n].avg > 0 ? "+" : ""}${h[n].avg}% (n=${h[n].n})`
        : null;
      const parts = [5, 10, 20].map(line).filter(Boolean);
      return `<div class="strat-block">
        <h3>${LABELS[s.strategy] || s.strategy} — ${s.signals} new signals</h3>
        ${parts.map((p) => `<p class="l">${p}</p>`).join("")}
        <p class="l">best ${s.best.symbol} ${s.best.ret > 0 ? "+" : ""}${s.best.ret}% ·
           worst ${s.worst.symbol} ${s.worst.ret > 0 ? "+" : ""}${s.worst.ret}%</p>
      </div>`;
    }).join("") || `<p class="empty">${weekly.note || "No review data yet."}</p>`;

    $("w-note").textContent = weekly.note || "";
  }

  function drawWeeklyChart() {
    if (weeklyChart) weeklyChart.destroy();
    const pts = (weekly && weekly.equity_curve) || [];
    weeklyChart = new Chart($("w-chart"), {
      type: "line",
      data: {
        labels: pts.map((p) => p.date.slice(5)),
        datasets: [{
          data: pts.map((p) => p.value),
          borderColor: css("--accent"), borderWidth: 2,
          pointRadius: 0, tension: .3, fill: false,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        scales: {
          x: { grid: { display: false },
               ticks: { color: css("--faint"), font: { size: 10 }, maxTicksLimit: 6 } },
          y: { grid: { color: css("--line") },
               ticks: { color: css("--faint"), font: { size: 10 } } },
        },
        plugins: { legend: { display: false } },
      },
    });
  }

  function redrawCharts() {
    if (latest) renderList();
    if (weekly) drawWeeklyChart();
  }

  // ------------------------------------------------------------------- nav
  function show(view) {
    ["list", "detail", "weekly"].forEach((v) => {
      $("view-" + v).hidden = v !== view;
    });
    document.querySelectorAll("nav button").forEach((b) => {
      b.classList.toggle("on", b.dataset.view === view ||
        (view === "detail" && b.dataset.view === "list"));
    });
    $("title").textContent =
      view === "weekly" ? "Weekly review" : "BursaMusangKing";
    window.scrollTo(0, 0);
  }
  document.querySelectorAll("nav button").forEach((b) => {
    b.onclick = () => show(b.dataset.view);
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
          await loadAll();
          banner("Scan complete — all screeners updated.");
          setTimeout(() => banner(null), 4000);
          $("run").disabled = false;
          return;
        }
      } catch { /* keep polling */ }

      if (Date.now() > deadline) {
        banner("Scan is taking longer than usual. It's still running on "
             + "GitHub — pull down to refresh in a few minutes.", "err");
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

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
