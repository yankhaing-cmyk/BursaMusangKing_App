/* BursaMusangKing — PWA front end */
(() => {
  const CFG = window.BMK_CONFIG || {};
  const API = (CFG.WORKER_URL || "").replace(/\/+$/, "");
  const $ = (id) => document.getElementById(id);
  const C = window.BMKChart;

  const SHORT = {
    trending: "Trending",
    early_uptrend: "Early",
    reversal: "Reversal",
    gaining_momentum: "Momentum",
    base_breakout: "Breakout",
    meta_leader: "META",
  };

  const LABELS = {
    trending: "Trending",
    early_uptrend: "Early uptrend",
    reversal: "Reversal",
    gaining_momentum: "Momentum",
    base_breakout: "Base breakout",
    meta_leader: "META leader",
  };

  let latest = null, weekly = null, backtest = null;
  let btStrat = null, btOpen = null, btKind = null, btSort = "best";
  let btExit = "fixed";
  let wSort = "recent";
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
    if (view === "weekly" && weekly && (weekly.equity_curve || []).length > 1) {
      C.line($("w-chart"), weekly.equity_curve);
    }
    if (view === "backtest" && backtest) drawBtChart();
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
      $("scr-controls").hidden = view !== "list";
    } catch (e) {
      banner("Couldn't load scan results. " + e.message, "err");
      $("count").textContent = "";
    }
    try {
      weekly = await get("/weekly");
      renderWeekly();
    } catch { /* weekly stays empty until the first review runs */ }
    try {
      backtest = await get("/backtest");
      btEmpty(false);
      renderBacktest();
    } catch {
      btEmpty(true);
    }
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
        ${SHORT[s] || LABELS[s] || s}<span class="n">${counts[s] || 0}</span>
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
  async function openDetail(s, fromHistory) {
    current = s;
    if (fromHistory) applyView("detail"); else go("detail", s.symbol);
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
    const ex = (latest && latest.exit_rule) || {};
    $("d-lvl-head").textContent = "Levels" + (ex.label ? ` · ${ex.label}` : "");
    $("d-entry").textContent = s.entry != null
      ? `${cur} ${s.entry}` : "–";
    $("d-stop").textContent = s.stop != null
      ? `${cur} ${s.stop}` + (s.stop_pct_now != null ? `  ${s.stop_pct_now}%` : "")
      : "–";
    $("d-trail").textContent = s.trail_dist != null
      ? `${cur} ${s.trail_dist}` + (ex.mult ? `  (${ex.mult}× ATR14)` : "")
      : "–";
    // Say which stop is governing today. On a volatile counter the ATR trail
    // starts wider than the fixed floor, so the floor holds until the trail
    // ratchets above it — showing only one number would hide that.
    $("d-lvl-note").textContent = s.stop == null ? "" : (
      (s.stop_from === "trail"
        ? `Trailing stop is governing. It rises as the highest close rises and never falls back. `
        : `The ${ex.stop_pct || 7}% initial stop is governing — the ATR trail is currently wider than it. `)
      + `Entry is the next bar's open; ${cur} ${s.entry} is the last close, shown for reference.`);

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

  // Delegating to history means the on-screen arrow and Android's hardware
  // back button follow the identical path — no chance of them disagreeing.
  $("back").onclick = () => history.back();

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
    }).join("") || `<p class="empty">${esc(weekly.note
        || "No completed signals yet. Results appear about 5 trading days "
         + "after a signal fires.")}</p>`;

    // The note used to render twice — once as the empty-state text inside
    // #w-strats and again in #w-note. Show it in exactly one place.
    const hasStrats = (weekly.strategies || []).length > 0;
    $("w-note").textContent = hasStrats ? (weekly.note || "") : "";
    renderSignals();

    // An empty canvas still occupies its CSS height, which left a large blank
    // gap on a screen that has nothing to plot. Collapse it instead.
    const pts = (weekly.equity_curve || []).length;
    $("w-chart").parentElement.style.display = pts > 1 ? "" : "none";
    $("w-curve-label").style.display = pts > 1 ? "" : "none";
    if (view === "weekly" && pts > 1) C.line($("w-chart"), weekly.equity_curve);
  }

  // --------------------------------------------------------------- backtest
  const LEVEL_ICON = { good: "✓", warn: "!", bad: "✕", thin: "·" };

  const nTest = (s, exit) =>
    (((s.exits || {})[exit] || {}).test || {}).trades || 0;

  function btStrategy() {
    if (!backtest) return null;
    const list = backtest.strategies || [];
    if (!list.length) return null;
    if (!btStrat) {
      // Default to the strategy with the most test trades, not just the first —
      // a strategy with 3 trades tells you nothing and shouldn't open by default.
      const best = list.reduce((a, b) =>
        nTest(b, "fixed") > nTest(a, "fixed") ? b : a, list[0]);
      btStrat = best && best.strategy;
    }
    return list.find((x) => x.strategy === btStrat) || list[0];
  }

  /** The selected strategy under the selected exit rule. */
  function btCurrent() {
    const s = btStrategy();
    if (!s) return null;
    const ex = s.exits || {};
    return ex[btExit] || ex.fixed || null;
  }

  function btEmpty(on) {
    // With no report, the table header, equity legend and config box render as
    // hollow scaffolding around a blank gap, which reads as broken rather than
    // as "nothing here yet". Hide the lot and show one line.
    ["bt-exits", "bt-exitrule", "bt-verdict", "bt-hint", "bt-tbl", "bt-curve-label",
     "bt-legend", "bt-chart-wrap", "bt-cards", "bt-cfg-label", "bt-cfg",
     "bt-updated", "bt-note"].forEach((id) => {
      const el = $(id);
      if (el) el.style.display = on ? "none" : "";
    });
    // The chip grid lives outside <main> and is driven by the hidden attribute,
    // so leave style.display alone here or it would win over the attribute.
    $("bt-chips").hidden = on || view !== "backtest";
    $("bt-meta").textContent = on
      ? "No backtest yet. Run the App Backtest workflow from the Actions tab — "
        + "it takes 20–40 minutes."
      : "";
  }

  function renderBacktest() {
    if (!backtest) return;
    const strat = btStrategy();
    const cur = btCurrent();
    const rules = backtest.exit_rules
      || [{ key: "fixed", label: "Fixed", detail: "" }];

    $("bt-meta").textContent =
      `${backtest.universe_size} stocks · ${backtest.date_from || "?"} – ${backtest.date_to || "?"}` +
      (cur ? ` · ${cur.trades_total || 0} trades` : "");

    // Exit rule sits directly above the verdict it changes, so switching it
    // and watching the banner flip is one glance rather than two screens.
    $("bt-exits").innerHTML = rules.map((r) =>
      `<button class="${r.key === btExit ? "on" : ""}" data-e="${r.key}">${esc(r.label)}</button>`
    ).join("");
    $("bt-exits").querySelectorAll("button").forEach((b) => {
      b.onclick = () => {
        btExit = b.dataset.e; btOpen = null;
        closeTrades(); renderBacktest();
      };
    });
    const rule = rules.find((r) => r.key === btExit);
    const notLive = strat && strat.live === false;
    $("bt-exitrule").textContent = (rule ? rule.detail || "" : "")
      + (notLive
          ? "  ·  Not live: this strategy is backtested but switched off in "
            + "config, so it sends no alerts and shows no chip on Screener."
          : "");

    // Strategy chips live at the bottom beside the nav, matching Screener.
    // They sit outside <main>, so nothing hides them when another tab is
    // showing — and renderBacktest() runs at startup while Screener is still
    // on screen. Gate on the current view, or they leak onto every tab.
    $("bt-chips").hidden = view !== "backtest";
    $("bt-chips").innerHTML = (backtest.strategies || []).map((s) => `
      <button class="chip${s.strategy === btStrat ? " on" : ""}" data-s="${s.strategy}">
        ${SHORT[s.strategy] || s.strategy}<span class="n">${nTest(s, btExit)}</span>
      </button>`).join("");
    $("bt-chips").querySelectorAll(".chip").forEach((c) => {
      c.onclick = () => {
        btStrat = c.dataset.s; btOpen = null;
        closeTrades(); renderBacktest();
      };
    });

    if (!cur) return;
    const v = cur.verdict || {};
    const vs = v.vs ? ` ${v.vs}` : "";
    $("bt-verdict").innerHTML = v.text
      ? `<div class="verdict v-${v.level || "thin"}"><span>${LEVEL_ICON[v.level] || "·"}</span><span>${esc(v.text + vs)}</span></div>`
      : "";

    const tr = cur.train || {}, te = cur.test || {};
    const pct = (x) => (x == null ? "–" : x + "%");
    const num = (x) => (x == null ? "–" : x);
    const wl = (x) => (x.wins == null ? "–" : `${x.wins}/${x.losses}`);
    const rows = [
      { k: "win", l: "Win rate", tr: pct(tr.win_rate), te: pct(te.win_rate), tap: 1 },
      { k: "lose", l: "Loss rate", tr: pct(tr.loss_rate), te: pct(te.loss_rate), tap: 1 },
      { k: null, l: "Won / lost", tr: wl(tr), te: wl(te) },
      { k: null, l: "Profit factor", tr: num(tr.profit_factor), te: num(te.profit_factor) },
      { k: "all", l: "Avg return", tr: pct(tr.avg), te: pct(te.avg), tap: 1 },
      { k: "lose", l: "Worst trade", tr: pct(tr.worst), te: pct(te.worst), tap: 1 },
      { k: "all", l: "Trades", tr: num(tr.trades), te: num(te.trades), tap: 1 },
    ];

    $("bt-rows").innerHTML = rows.map((r, i) => `
      <div class="bt-row">
        <span>${r.l}</span><span class="tr">${r.tr}</span>
        ${r.tap
          ? `<span class="te tap" data-k="${r.k}" data-i="${i}" role="button" tabindex="0">${r.te} ›</span>`
          : `<span class="te">${r.te}</span>`}
      </div>`).join("");

    $("bt-rows").querySelectorAll(".tap").forEach((t) => {
      const go = () => (btOpen === t.dataset.i ? closeTrades() : openTrades(t.dataset.k, t.dataset.i));
      t.onclick = go;
      t.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
      };
    });

    const mdd = cur.max_drawdown;
    const card = (l, val) => `<div class="c"><p>${l}</p><p>${val}</p></div>`;
    $("bt-cards").innerHTML =
      card("Max drawdown", mdd == null ? "–" : mdd + "%") +
      card("Avg hold", te.avg_hold == null ? "–" : te.avg_hold + "d") +
      card("Best trade", te.best == null ? "–" : "+" + te.best + "%") +
      card("Median", te.median == null ? "–" : te.median + "%");

    const cfg = (backtest.strategy_config || {})[strat.strategy] || {};
    const p = backtest.params || {};
    $("bt-cfg").textContent =
      Object.entries(cfg).map(([k, x]) => `${k} ${x}`).join(" · ") +
      (Object.keys(p).length
        ? "\n" + Object.entries(p).map(([k, x]) => `${k} ${x}`).join(" · ")
        : "");

    $("bt-updated").textContent = "Last run " + fmtTime(backtest.generated_at);
    $("bt-note").textContent = backtest.note || "";
    requestAnimationFrame(drawBtChart);
  }

  function drawBtChart() {
    const cur = btCurrent();
    if (!cur) return;
    const eq = cur.equity || {};
    C.split($("bt-chart"), eq.train || [], eq.test || []);
  }

  const SORTS = [
    ["best", "Best first"], ["worst", "Worst first"], ["recent", "Most recent"],
  ];

  function openTrades(kind, idx) {
    btKind = kind;
    // Sensible default per bucket: winners are interesting best-first
    // (concentration), losers worst-first (tail risk).
    btSort = kind === "lose" ? "worst" : "best";
    drawTrades();
    const panel = $("bt-panel");
    panel.style.transition = "height .2s ease";
    panel.style.height = $("bt-panel-in").offsetHeight + "px";
    btOpen = idx;
    $("bt-rows").querySelectorAll(".tap").forEach((t) =>
      t.classList.toggle("on", t.dataset.i === idx));
  }

  function drawTrades() {
    const cur = btCurrent();
    if (!cur || !btKind) return;
    // Only test trades are offered — train trades are the in-sample half the
    // strategy was tuned against, so inspecting them tells you nothing useful.
    let rows = (cur.trades || []).filter((t) => t.p === "test");
    let title = "All test trades";
    if (btKind === "win") { rows = rows.filter((t) => t.r > 0); title = "Winning trades"; }
    if (btKind === "lose") { rows = rows.filter((t) => t.r <= 0); title = "Losing trades"; }

    rows = rows.slice().sort(
      btSort === "best" ? (a, b) => b.r - a.r
      : btSort === "worst" ? (a, b) => a.r - b.r
      : (a, b) => (a.in < b.in ? 1 : a.in > b.in ? -1 : 0));

    // Share of the period's gross profit (or gross loss for a losing trade),
    // measured against the true period totals from the exporter rather than
    // the visible rows — so a capped list can't inflate the percentages.
    const te = cur.test || {};
    const gp = te.gross_profit || 0, gl = te.gross_loss || 0;
    const share = (r) => {
      const base = r > 0 ? gp : gl;
      if (!base) return null;
      return Math.abs(r) / base * 100;
    };

    $("tl-title").textContent = `${title} · ${rows.length}`;

    const showCumHead = btKind !== "all" &&
      ((btKind === "win" && btSort === "best") ||
       (btKind === "lose" && btSort === "worst"));
    $("tl-cap").textContent = showCumHead
      ? (btKind === "win"
          ? "Right column: this trade's share of total profit, then the running total."
          : "Right column: this trade's share of total loss, then the running total.")
      : "";
    $("tl-cap").style.display = showCumHead ? "" : "none";

    $("tl-sort").innerHTML = SORTS.map(([k, l]) =>
      `<button class="sort${k === btSort ? " on" : ""}" data-s="${k}">${l}</button>`).join("");
    $("tl-sort").querySelectorAll(".sort").forEach((b) => {
      b.onclick = () => {
        btSort = b.dataset.s;
        drawTrades();
        $("bt-panel").style.height = $("bt-panel-in").offsetHeight + "px";
      };
    });

    let cum = 0;
    $("tl-rows").innerHTML = rows.length
      ? rows.map((t) => {
          const sh = share(t.r);
          let conTxt = "";
          if (sh != null) {
            // Cumulative only reads meaningfully down a single-sign,
            // magnitude-ordered list — otherwise it's an arbitrary running sum.
            const showCum = btKind !== "all" &&
              ((btKind === "win" && btSort === "best") ||
               (btKind === "lose" && btSort === "worst"));
            if (showCum) {
              cum += sh;
              conTxt = `${sh.toFixed(1)}% · cum ${cum.toFixed(0)}%`;
            } else {
              conTxt = `${sh.toFixed(1)}% of ${t.r > 0 ? "profit" : "loss"}`;
            }
          }
          return `
        <div class="tl-row">
          <div class="tl-l1">
            <span class="sym">${esc(t.s)} <span class="why">${esc(t.x)}</span></span>
            <span class="ret ${t.r > 0 ? "up" : "down"}">${t.r > 0 ? "+" : ""}${t.r}%</span>
          </div>
          <div class="tl-l2">
            <span class="dt">${fmtDay(t.in)} → ${fmtDay(t.out)} · ${t.h}d</span>
            <span class="con">${conTxt}</span>
          </div>
        </div>`;
        }).join("")
      : `<p class="empty">No trades in this bucket.</p>`;

    const capped = (te.trades || 0) > (cur.trades || []).filter((t) => t.p === "test").length;
    $("tl-note").textContent = capped
      ? `Showing the most recent ${rows.length} of ${te.trades}`
      : `${rows.length} trade${rows.length === 1 ? "" : "s"}`;
  }

  function closeTrades() {
    const panel = $("bt-panel");
    if (panel) panel.style.height = "0px";
    btOpen = null; btKind = null;
    const r = $("bt-rows");
    if (r) r.querySelectorAll(".tap").forEach((t) => t.classList.remove("on"));
  }
  $("tl-close").onclick = closeTrades;

  const W_SORTS = [
    ["recent", "Newest"], ["best10", "Best +10d"], ["worst10", "Worst +10d"],
    ["pending", "Pending first"],
  ];

  function renderSignals() {
    const all = (weekly && weekly.signals) || [];
    $("w-siglist").hidden = !all.length;
    if (!all.length) return;

    const pend = all.filter((x) => x.p).length;
    $("w-sig-title").textContent =
      `Signals · ${all.length}` + (pend ? ` · ${pend} still pending` : "");

    $("w-sort").innerHTML = W_SORTS.map(([k, l]) =>
      `<button class="sort${k === wSort ? " on" : ""}" data-s="${k}">${l}</button>`).join("");
    $("w-sort").querySelectorAll(".sort").forEach((b) => {
      b.onclick = () => { wSort = b.dataset.s; renderSignals(); };
    });

    // Pending signals have no return to rank by. Rather than treating a missing
    // value as zero — which would scatter them through the middle of a sorted
    // list — they always sink to the bottom of a return sort.
    const byR = (dir) => (a, b) => {
      const x = a.r10, y = b.r10;
      if (x == null && y == null) return a.d < b.d ? 1 : -1;
      if (x == null) return 1;
      if (y == null) return -1;
      return dir * (y - x);
    };
    const rows = all.slice().sort(
      wSort === "best10" ? byR(1)
      : wSort === "worst10" ? byR(-1)
      : wSort === "pending" ? ((a, b) => (b.p ? 1 : 0) - (a.p ? 1 : 0)
          || (a.d < b.d ? 1 : -1))
      : (a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0));

    const cell = (label, v) => v == null
      ? `<span>${label} <b style="color:var(--faint)">–</b></span>`
      : `<span>${label} <b class="${v > 0 ? "up" : "down"}">${v > 0 ? "+" : ""}${v}%</b></span>`;

    $("w-sigs").innerHTML = rows.map((x) => `
      <div class="sg-row">
        <div class="sg-top">
          <span class="sym">${esc(x.s)}${x.p ? ' <span class="pend">PENDING</span>' : ""}</span>
          <span class="d">${fmtDay(x.d)}</span>
        </div>
        ${x.n ? `<p class="sg-co">${esc(x.n)}</p>` : ""}
        <div class="sg-h">
          ${cell("5d", x.r5)}${cell("10d", x.r10)}${cell("20d", x.r20)}
        </div>
      </div>`).join("");
  }

  function fmtDay(iso) {
    const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const [, m, d] = iso.split("-");
    return `${d} ${M[+m - 1]}`;
  }

  // ------------------------------------------------------------------- nav
  /** Render a view. Does not touch history — call go() for user navigation. */
  function applyView(v) {
    view = v;
    ["list", "detail", "weekly", "backtest"].forEach((x) => {
      $("view-" + x).hidden = x !== v;
    });
    // Both of these sit outside <main>, so they need hiding explicitly.
    $("bt-chips").hidden = v !== "backtest" || !backtest;
    $("scr-controls").hidden = v !== "list" || !latest;
    $("run").hidden = v !== "list";
    document.querySelectorAll("nav button").forEach((b) => {
      b.classList.toggle("on", b.dataset.view === v ||
        (v === "detail" && b.dataset.view === "list"));
    });
    if (v !== "detail") {
      $("title").textContent =
        v === "weekly" ? "Weekly review"
        : v === "backtest" ? "Backtest"
        : "BursaMusangKing";
    }
    const m = document.querySelector("main");
    if (m) m.scrollTop = 0;
    // Canvases in a hidden section have zero width, so draw after they're shown.
    requestAnimationFrame(redraw);
  }
  /** User navigation: push a history entry, then render. */
  function go(v, sym) {
    const st = history.state;
    // Re-tapping the tab you are already on should not stack duplicate
    // entries, or back would appear to do nothing several times over.
    if (st && st.bmk && st.v === v && (st.sym || null) === (sym || null)) {
      applyView(v);
      return;
    }
    history.pushState({ bmk: 1, v: v, sym: sym || null }, "");
    applyView(v);
  }

  document.querySelectorAll("nav button").forEach((b) => {
    b.onclick = () => { current = null; go(b.dataset.view); };
  });

  // Android's hardware back button, the on-screen arrow and browser gestures
  // all arrive here. The list view is the base entry, so pressing back there
  // leaves the app, which is what a user expects from a home screen icon.
  window.addEventListener("popstate", (e) => {
    const st = e.state && e.state.bmk ? e.state : { v: "list", sym: null };
    if (st.v === "detail" && st.sym) {
      const stock = (latest && latest.stocks || []).find((x) => x.symbol === st.sym);
      if (stock) { openDetail(stock, true); return; }
      applyView("list");          // data reloaded since; fall back rather than blank
      return;
    }
    current = null;
    applyView(st.v || "list");
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
  // Run the view switcher once at startup so header controls match the
  // opening view — otherwise they only settle after the first nav tap.
  // Base history entry. Back from here exits the app.
  history.replaceState({ bmk: 1, v: "list", sym: null }, "");
  applyView("list");
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
