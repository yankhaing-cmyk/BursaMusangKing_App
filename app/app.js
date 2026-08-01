/* BursaMusangKing — six-screener browser app */
(() => {
  "use strict";

  const CFG = window.BMK_CONFIG || {};
  const API = (CFG.WORKER_URL || "").replace(/\/+$/, "");
  const DEMO = !API;
  const $ = (id) => document.getElementById(id);

  const SHORT = {
    trending: "Trending",
    early_uptrend: "Early",
    reversal: "Reversal",
    gaining_momentum: "Momentum",
    base_breakout: "Breakout",
    meta_leader: "M.E.T.A.",
  };
  const LABELS = {
    trending: "Trending",
    early_uptrend: "Early uptrend",
    reversal: "Reversal",
    gaining_momentum: "Gaining momentum",
    base_breakout: "Base breakout",
    meta_leader: "M.E.T.A. leader",
  };
  const META_DESC = "Leadership pullback or tight leadership breakout";

  let latest = null;
  let weekly = null;
  let backtest = null;
  let filter = null;
  let current = null;
  let view = "list";
  let btStrat = null;
  let btExit = "fixed";
  let btKind = null;
  let btSort = "best";
  let wSort = "recent";
  let pollTimer = null;
  let resizeTimer = null;
  const historyCache = {};

  const esc = (value) => String(value ?? "").replace(/[&<>\"]/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  })[ch]);
  const fmtTime = (iso) => iso ? new Date(iso).toLocaleString(undefined, {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  }) : "–";
  const fmtDay = (iso) => iso ? new Date(`${iso}T00:00:00`).toLocaleDateString(
    undefined, { day: "2-digit", month: "short", year: "2-digit" }
  ) : "–";

  function banner(text, kind = "") {
    const el = $("banner");
    el.textContent = text || "";
    el.className = `banner${text ? " show" : ""}${kind ? ` ${kind}` : ""}`;
  }

  // --------------------------------------------------------------- theme
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  let theme = localStorage.getItem("bmk-theme") || (media.matches ? "dark" : "light");
  function applyTheme(mode) {
    document.documentElement.setAttribute("data-theme", mode);
    $("theme").textContent = mode === "dark" ? "☀" : "◐";
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", mode === "dark" ? "#1c1c1a" : "#ffffff");
    requestAnimationFrame(redraw);
  }
  applyTheme(theme);
  $("theme").onclick = () => {
    theme = theme === "dark" ? "light" : "dark";
    localStorage.setItem("bmk-theme", theme);
    applyTheme(theme);
  };
  media.addEventListener("change", (event) => {
    if (localStorage.getItem("bmk-theme")) return;
    theme = event.matches ? "dark" : "light";
    applyTheme(theme);
  });
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(redraw, 120);
  });

  // --------------------------------------------------------------- fetch
  async function get(path) {
    if (DEMO) {
      if (path.startsWith("/history")) {
        const data = await fetch("demo/history.json", { cache: "no-store" }).then((r) => {
          if (!r.ok) throw new Error(`demo/history.json → ${r.status}`);
          return r.json();
        });
        const symbol = new URLSearchParams(path.split("?")[1] || "").get("symbol");
        return { symbol, bars: data.bars, series: (data.series || {})[symbol] };
      }
      const file = path === "/latest" ? "latest.json"
        : path === "/weekly" ? "weekly.json"
        : path === "/backtest" ? "backtest.json" : null;
      if (!file) throw new Error(`unknown demo path ${path}`);
      const response = await fetch(`demo/${file}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`demo/${file} → ${response.status}`);
      return response.json();
    }
    const response = await fetch(API + path, { cache: "no-store" });
    if (!response.ok) throw new Error(`${path} → ${response.status}`);
    return response.json();
  }

  async function loadAll() {
    try {
      latest = await get("/latest");
      renderChips();
      renderList();
      $("updated").textContent = `Updated ${fmtTime(latest.generated_at)}`;
    } catch (error) {
      banner(`Couldn't load scan results. ${error.message}`, "err");
      $("count").textContent = "";
    }
    try {
      weekly = await get("/weekly");
      renderWeekly();
    } catch (_) { /* first weekly report may not exist */ }
    try {
      backtest = await get("/backtest");
      renderBacktest();
    } catch (_) {
      $("bt-meta").textContent = "No backtest report yet. Run App Backtest in GitHub Actions.";
    }
  }

  // --------------------------------------------------------------- canvas
  function canvasCtx(canvas, fallbackHeight) {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(40, rect.width || canvas.parentElement?.clientWidth || 300);
    const height = Math.max(30, rect.height || fallbackHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return { ctx, width, height };
  }
  function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  function finite(values) {
    return values.filter((v) => Number.isFinite(Number(v))).map(Number);
  }
  function drawSpark(canvas, series) {
    if (!canvas || !series) return;
    const { ctx, width, height } = canvasCtx(canvas, 42);
    const o = series.o || [], h = series.h || [], l = series.l || [], c = series.c || [];
    const vals = finite([...h, ...l, ...c]);
    if (!vals.length) return;
    const min = Math.min(...vals), max = Math.max(...vals);
    const span = max - min || 1;
    const n = c.length;
    const step = width / Math.max(n, 1);
    const y = (v) => 3 + (max - Number(v)) / span * (height - 6);
    const up = css("--up"), down = css("--down"), line = css("--line");
    ctx.strokeStyle = line;
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(0, height - 1); ctx.lineTo(width, height - 1); ctx.stroke();
    for (let i = 0; i < n; i += 1) {
      if (![o[i], h[i], l[i], c[i]].every((v) => Number.isFinite(Number(v)))) continue;
      const x = i * step + step / 2;
      ctx.strokeStyle = Number(c[i]) >= Number(o[i]) ? up : down;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y(h[i])); ctx.lineTo(x, y(l[i])); ctx.stroke();
      const top = Math.min(y(o[i]), y(c[i]));
      const bh = Math.max(1, Math.abs(y(o[i]) - y(c[i])));
      ctx.fillRect(x - Math.max(1, step * 0.22), top, Math.max(2, step * 0.44), bh);
    }
  }
  function drawDetail(canvas, series) {
    if (!canvas || !series) return;
    const { ctx, width, height } = canvasCtx(canvas, 260);
    const o = series.o || [], h = series.h || [], l = series.l || [], c = series.c || [];
    const vals = finite([...h, ...l, ...(series.e20 || []), ...(series.e50 || []), ...(series.e200 || [])]);
    if (!vals.length) return;
    const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
    const pad = { l: 6, r: 6, t: 8, b: 20 };
    const plotW = width - pad.l - pad.r, plotH = height - pad.t - pad.b;
    const n = c.length, step = plotW / Math.max(n, 1);
    const y = (v) => pad.t + (max - Number(v)) / span * plotH;
    const x = (i) => pad.l + i * step + step / 2;
    ctx.strokeStyle = css("--line"); ctx.lineWidth = 0.5;
    for (let g = 1; g < 4; g += 1) {
      const gy = pad.t + plotH * g / 4;
      ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(width - pad.r, gy); ctx.stroke();
    }
    const up = css("--up"), down = css("--down");
    for (let i = 0; i < n; i += 1) {
      if (![o[i], h[i], l[i], c[i]].every((v) => Number.isFinite(Number(v)))) continue;
      ctx.strokeStyle = Number(c[i]) >= Number(o[i]) ? up : down;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x(i), y(h[i])); ctx.lineTo(x(i), y(l[i])); ctx.stroke();
      const top = Math.min(y(o[i]), y(c[i]));
      const bh = Math.max(1, Math.abs(y(o[i]) - y(c[i])));
      ctx.fillRect(x(i) - Math.max(1, step * 0.25), top, Math.max(2, step * 0.50), bh);
    }
    const drawMA = (arr, colour, dash = []) => {
      if (!arr || !arr.length) return;
      ctx.strokeStyle = colour; ctx.lineWidth = 1.2; ctx.setLineDash(dash);
      ctx.beginPath(); let started = false;
      arr.forEach((v, i) => {
        if (!Number.isFinite(Number(v))) { started = false; return; }
        if (!started) { ctx.moveTo(x(i), y(v)); started = true; } else ctx.lineTo(x(i), y(v));
      });
      ctx.stroke(); ctx.setLineDash([]);
    };
    drawMA(series.e20, css("--accent"));
    drawMA(series.e50, "#c58a22");
    drawMA(series.e200, css("--muted"), [4, 3]);
  }
  function drawLine(canvas, points, second = null) {
    if (!canvas) return;
    const { ctx, width, height } = canvasCtx(canvas, 150);
    const a = points || [], b = second || [];
    const vals = finite([...a.map((p) => p.v), ...b.map((p) => p.v)]);
    if (vals.length < 2) return;
    const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
    const pad = 8, all = [...a, ...b], n = Math.max(all.length, 2);
    const y = (v) => pad + (max - Number(v)) / span * (height - pad * 2);
    const draw = (arr, colour, xOffset, denominator) => {
      if (!arr.length) return;
      ctx.strokeStyle = colour; ctx.lineWidth = 1.8; ctx.beginPath();
      arr.forEach((p, i) => {
        const x = pad + (xOffset + i) / Math.max(denominator - 1, 1) * (width - pad * 2);
        if (i === 0) ctx.moveTo(x, y(p.v)); else ctx.lineTo(x, y(p.v));
      });
      ctx.stroke();
    };
    ctx.strokeStyle = css("--line"); ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(pad, height / 2); ctx.lineTo(width - pad, height / 2); ctx.stroke();
    if (b.length) {
      draw(a, css("--muted"), 0, a.length + b.length);
      draw(b, css("--accent"), Math.max(a.length - 1, 0), a.length + b.length);
    } else {
      draw(a, css("--accent"), 0, a.length);
    }
  }

  // --------------------------------------------------------------- list
  function visible() {
    if (!latest) return [];
    const all = latest.stocks || [];
    return filter ? all.filter((s) => s.strategy === filter) : all;
  }
  function renderChips() {
    if (!latest) return;
    const counts = {};
    (latest.stocks || []).forEach((s) => { counts[s.strategy] = (counts[s.strategy] || 0) + 1; });
    const strats = latest.strategies || Object.keys(counts);
    if (filter === null || !strats.includes(filter)) filter = strats.find((s) => counts[s]) || strats[0];
    $("chips").innerHTML = strats.map((s) => `
      <button class="chip${s === filter ? " on" : ""}" data-s="${esc(s)}">
        <span>${esc(SHORT[s] || LABELS[s] || s)}</span><span class="n">${counts[s] || 0}</span>
      </button>`).join("");
    $("chips").querySelectorAll(".chip").forEach((button) => {
      button.onclick = () => { filter = button.dataset.s; renderChips(); renderList(); };
    });
  }
  function renderList() {
    if (!latest) return;
    const rows = visible();
    const currency = latest.currency || "";
    $("count").textContent = `${rows.length} match${rows.length === 1 ? "" : "es"} · ${latest.stocks_screened || 0} screened`;
    if (!rows.length) {
      $("list").innerHTML = `<p class="empty">No ${esc(LABELS[filter] || filter)} matches in this scan.</p>`;
      return;
    }
    $("list").innerHTML = rows.map((s, i) => {
      const dir = Number(s.change_pct) >= 0 ? "up" : "down";
      const sign = Number(s.change_pct) > 0 ? "+" : "";
      const sub = s.strategy === "meta_leader"
        ? `${META_DESC} · Vol ${s.vol_ratio}x`
        : `RSI ${s.rsi} · ADX ${s.adx} · Vol ${s.vol_ratio}x`;
      return `<button class="row" data-i="${i}">
        <span class="spark"><canvas id="sp${i}"></canvas></span>
        <span class="row-mid">
          <span class="name">${esc(s.symbol)}${s.is_new ? '<span class="badge">NEW</span>' : ""}</span>
          ${s.name ? `<span class="co">${esc(s.name)}</span>` : ""}
          <span class="sub">${esc(sub)}</span>
        </span>
        <span class="row-end">
          <span class="chg ${dir}">${sign}${s.change_pct ?? 0}%</span>
          <span class="px">${esc(currency)}${s.close}</span>
        </span>
      </button>`;
    }).join("");
    $("list").querySelectorAll(".row").forEach((row) => {
      row.onclick = () => openDetail(rows[Number(row.dataset.i)]);
    });
    requestAnimationFrame(() => rows.forEach((s, i) => drawSpark($(`sp${i}`), s.spark)));
  }

  // --------------------------------------------------------------- detail
  async function openDetail(stock) {
    current = stock;
    show("detail");
    const currency = latest.currency || "";
    const category = (LABELS[stock.strategy] || stock.strategy).toUpperCase();
    $("d-title").innerHTML = `${esc(stock.symbol)}<span class="sep">|</span>`
      + `<span class="cat">${esc(category)}</span><span class="sep">|</span>`
      + `<span class="stat">${esc(currency)}${stock.close}</span>`
      + `<span class="stat">RSI ${stock.rsi}</span>`
      + `<span class="stat">ADX ${stock.adx}</span>`
      + `<span class="stat">Vol ${stock.vol_ratio}x</span>`;
    $("d-co").textContent = stock.name || "";
    $("title").textContent = stock.symbol;
    const exit = latest.exit_rule || {};
    $("d-lvl-head").textContent = `Levels${exit.label ? ` · ${exit.label}` : ""}`;
    $("d-entry").textContent = stock.entry != null ? `${currency} ${stock.entry}` : "–";
    $("d-stop").textContent = stock.stop != null
      ? `${currency} ${stock.stop}${stock.stop_pct_now != null ? `  ${stock.stop_pct_now}%` : ""}` : "–";
    $("d-trail").textContent = stock.trail_dist != null
      ? `${currency} ${stock.trail_dist}${exit.mult ? `  (${exit.mult}× ATR14)` : ""}` : "–";
    $("d-lvl-note").textContent = stock.strategy === "meta_leader"
      ? `${META_DESC}. Entry is the next bar's open; the displayed price is the latest close.`
      : (stock.stop == null ? "" : `Entry is the next bar's open; ${currency} ${stock.entry} is the latest close shown for reference.`);
    if (!(stock.symbol in historyCache)) {
      try {
        const result = await get(`/history?symbol=${encodeURIComponent(stock.symbol)}`);
        historyCache[stock.symbol] = result.series || null;
      } catch (_) {
        historyCache[stock.symbol] = null;
      }
    }
    if (current === stock) drawDetail($("d-chart"), historyCache[stock.symbol] || stock.spark);
  }
  $("back").onclick = () => { current = null; show("list"); };

  // --------------------------------------------------------------- weekly
  function renderWeekly() {
    if (!weekly) return;
    const overall = weekly.overall || {};
    const card = (label, value, cls = "") => `<div class="c"><p>${label}</p><p class="${cls}">${value}</p></div>`;
    $("w-cards").innerHTML = overall.trades
      ? card("Win rate", `${overall.win_rate}%`) + card("Profit factor", overall.profit_factor ?? "–")
        + card("Signals", overall.trades) + card("Worst", `${overall.worst}%`, "down")
      : card("Win rate", "–") + card("Profit factor", "–") + card("Signals", 0) + card("Worst", "–");
    $("w-curve-label").textContent = `Cumulative signal performance · last ${weekly.lookback_weeks || "?"} weeks`;
    $("w-strats").innerHTML = (weekly.strategies || []).map((s) => {
      const h = s.horizons || {};
      const parts = [5, 10, 20].filter((n) => h[n]).map((n) =>
        `+${n}d: ${h[n].win_rate}% win · avg ${h[n].avg > 0 ? "+" : ""}${h[n].avg}% (n=${h[n].n})`
      );
      const best = s.best || {}, worst = s.worst || {};
      return `<div class="strat-block"><h3>${esc(LABELS[s.strategy] || s.strategy)} — ${s.signals || 0} new signals</h3>
        ${parts.map((p) => `<p class="l">${esc(p)}</p>`).join("")}
        ${best.symbol ? `<p class="l">best ${esc(best.symbol)} ${best.ret > 0 ? "+" : ""}${best.ret}% · worst ${esc(worst.symbol || "–")} ${worst.ret > 0 ? "+" : ""}${worst.ret ?? "–"}%</p>` : ""}
      </div>`;
    }).join("") || `<p class="empty">${esc(weekly.note || "No completed signals yet.")}</p>`;
    $("w-note").textContent = (weekly.strategies || []).length ? (weekly.note || "") : "";
    renderSignals();
    const curve = weekly.equity_curve || [];
    $("w-chart").parentElement.hidden = curve.length < 2;
    $("w-curve-label").hidden = curve.length < 2;
    if (view === "weekly" && curve.length > 1) requestAnimationFrame(() => drawLine($("w-chart"), curve));
  }
  const W_SORTS = [["recent", "Newest"], ["best10", "Best +10d"], ["worst10", "Worst +10d"], ["pending", "Pending first"]];
  function renderSignals() {
    const all = weekly?.signals || [];
    $("w-siglist").hidden = !all.length;
    if (!all.length) return;
    const pending = all.filter((x) => x.p).length;
    $("w-sig-title").textContent = `Signals · ${all.length}${pending ? ` · ${pending} still pending` : ""}`;
    $("w-sort").innerHTML = W_SORTS.map(([key, label]) => `<button class="sort${key === wSort ? " on" : ""}" data-s="${key}">${label}</button>`).join("");
    $("w-sort").querySelectorAll(".sort").forEach((button) => {
      button.onclick = () => { wSort = button.dataset.s; renderSignals(); };
    });
    const byReturn = (direction) => (a, b) => {
      if (a.r10 == null && b.r10 == null) return a.d < b.d ? 1 : -1;
      if (a.r10 == null) return 1;
      if (b.r10 == null) return -1;
      return direction * (b.r10 - a.r10);
    };
    const rows = all.slice().sort(
      wSort === "best10" ? byReturn(1)
        : wSort === "worst10" ? byReturn(-1)
          : wSort === "pending" ? ((a, b) => Number(Boolean(b.p)) - Number(Boolean(a.p)) || (a.d < b.d ? 1 : -1))
            : ((a, b) => a.d < b.d ? 1 : a.d > b.d ? -1 : 0)
    );
    const cell = (label, value) => value == null
      ? `<span>${label} <b class="faint">–</b></span>`
      : `<span>${label} <b class="${value > 0 ? "up" : "down"}">${value > 0 ? "+" : ""}${value}%</b></span>`;
    $("w-sigs").innerHTML = rows.map((x) => `<div class="sg-row">
      <div class="sg-top"><span class="sym">${esc(x.s)}${x.p ? ' <span class="pend">PENDING</span>' : ""}</span><span class="d">${fmtDay(x.d)}</span></div>
      ${x.n ? `<p class="sg-co">${esc(x.n)}</p>` : ""}
      <div class="sg-h">${cell("5d", x.r5)}${cell("10d", x.r10)}${cell("20d", x.r20)}</div>
    </div>`).join("");
  }

  // --------------------------------------------------------------- backtest
  const LEVEL_ICON = { good: "✓", warn: "!", bad: "✕", thin: "·" };
  const nTest = (strategy, exit) => (((strategy.exits || {})[exit] || {}).test || {}).trades || 0;
  function btStrategy() {
    const list = backtest?.strategies || [];
    if (!list.length) return null;
    if (!btStrat || !list.some((s) => s.strategy === btStrat)) {
      btStrat = list.reduce((best, item) => nTest(item, "fixed") > nTest(best, "fixed") ? item : best, list[0]).strategy;
    }
    return list.find((s) => s.strategy === btStrat) || list[0];
  }
  function btCurrent() {
    const strategy = btStrategy();
    if (!strategy) return null;
    return (strategy.exits || {})[btExit] || (strategy.exits || {}).fixed || null;
  }
  function renderBacktest() {
    if (!backtest) return;
    const strategy = btStrategy();
    const currentExit = btCurrent();
    const rules = backtest.exit_rules || [{ key: "fixed", label: "Fixed", detail: "" }];
    $("bt-meta").textContent = `${backtest.universe_size || 0} stocks · ${backtest.date_from || "?"} – ${backtest.date_to || "?"}${currentExit ? ` · ${currentExit.trades_total || 0} trades` : ""}`;
    $("bt-exits").innerHTML = rules.map((rule) => `<button class="${rule.key === btExit ? "on" : ""}" data-e="${esc(rule.key)}">${esc(rule.label)}</button>`).join("");
    $("bt-exits").querySelectorAll("button").forEach((button) => {
      button.onclick = () => { btExit = button.dataset.e; btKind = null; renderBacktest(); };
    });
    const rule = rules.find((item) => item.key === btExit);
    $("bt-exitrule").textContent = rule?.detail || "";
    $("bt-chips").hidden = view !== "backtest";
    $("bt-chips").innerHTML = (backtest.strategies || []).map((s) => `<button class="chip${s.strategy === btStrat ? " on" : ""}" data-s="${esc(s.strategy)}"><span>${esc(SHORT[s.strategy] || s.strategy)}</span><span class="n">${nTest(s, btExit)}</span></button>`).join("");
    $("bt-chips").querySelectorAll(".chip").forEach((button) => {
      button.onclick = () => { btStrat = button.dataset.s; btKind = null; renderBacktest(); };
    });
    if (!strategy || !currentExit) return;
    const verdict = currentExit.verdict || {};
    $("bt-verdict").innerHTML = verdict.text
      ? `<div class="verdict v-${esc(verdict.level || "thin")}"><span>${LEVEL_ICON[verdict.level] || "·"}</span><span>${esc(verdict.text + (verdict.vs ? ` ${verdict.vs}` : ""))}</span></div>` : "";
    const train = currentExit.train || {}, test = currentExit.test || {};
    const pct = (x) => x == null ? "–" : `${x}%`;
    const num = (x) => x == null ? "–" : x;
    const wl = (x) => x.wins == null ? "–" : `${x.wins}/${x.losses}`;
    const rows = [
      ["Win rate", pct(train.win_rate), pct(test.win_rate), "win"],
      ["Loss rate", pct(train.loss_rate), pct(test.loss_rate), "lose"],
      ["Won / lost", wl(train), wl(test), null],
      ["Profit factor", num(train.profit_factor), num(test.profit_factor), null],
      ["Avg return", pct(train.avg), pct(test.avg), "all"],
      ["Worst trade", pct(train.worst), pct(test.worst), "lose"],
      ["Trades", num(train.trades), num(test.trades), "all"],
    ];
    $("bt-rows").innerHTML = rows.map(([label, tr, te, kind]) => `<div class="bt-row"><span>${label}</span><span class="tr">${tr}</span>${kind ? `<button class="te tap" data-k="${kind}">${te} ›</button>` : `<span class="te">${te}</span>`}</div>`).join("");
    $("bt-rows").querySelectorAll(".tap").forEach((button) => {
      button.onclick = () => { btKind = button.dataset.k; btSort = btKind === "lose" ? "worst" : "best"; drawTrades(); };
    });
    const card = (label, value) => `<div class="c"><p>${label}</p><p>${value}</p></div>`;
    $("bt-cards").innerHTML = card("Max drawdown", currentExit.max_drawdown == null ? "–" : `${currentExit.max_drawdown}%`)
      + card("Avg hold", test.avg_hold == null ? "–" : `${test.avg_hold}d`)
      + card("Best trade", test.best == null ? "–" : `+${test.best}%`)
      + card("Median", test.median == null ? "–" : `${test.median}%`);
    const strategyConfig = (backtest.strategy_config || {})[strategy.strategy] || {};
    const params = backtest.params || {};
    $("bt-cfg").textContent = Object.entries(strategyConfig).map(([k, v]) => `${k} ${v}`).join(" · ")
      + (Object.keys(params).length ? `\n${Object.entries(params).map(([k, v]) => `${k} ${v}`).join(" · ")}` : "");
    $("bt-updated").textContent = `Last run ${fmtTime(backtest.generated_at)}`;
    $("bt-note").textContent = backtest.note || "";
    const equity = currentExit.equity || {};
    requestAnimationFrame(() => drawLine($("bt-chart"), equity.train || [], equity.test || []));
    if (!btKind) closeTrades();
  }
  const SORTS = [["best", "Best first"], ["worst", "Worst first"], ["recent", "Most recent"]];
  function drawTrades() {
    const currentExit = btCurrent();
    if (!currentExit || !btKind) return;
    let rows = (currentExit.trades || []).filter((t) => t.p === "test");
    let title = "All test trades";
    if (btKind === "win") { rows = rows.filter((t) => t.r > 0); title = "Winning trades"; }
    if (btKind === "lose") { rows = rows.filter((t) => t.r <= 0); title = "Losing trades"; }
    rows.sort(btSort === "best" ? (a, b) => b.r - a.r : btSort === "worst" ? (a, b) => a.r - b.r : (a, b) => a.in < b.in ? 1 : -1);
    $("tl-title").textContent = `${title} · ${rows.length}`;
    $("tl-sort").innerHTML = SORTS.map(([key, label]) => `<button class="sort${key === btSort ? " on" : ""}" data-s="${key}">${label}</button>`).join("");
    $("tl-sort").querySelectorAll(".sort").forEach((button) => {
      button.onclick = () => { btSort = button.dataset.s; drawTrades(); };
    });
    $("tl-rows").innerHTML = rows.length ? rows.map((t) => `<div class="tl-row"><div class="tl-l1"><span class="sym">${esc(t.s)} <span class="why">${esc(t.x)}</span></span><span class="ret ${t.r > 0 ? "up" : "down"}">${t.r > 0 ? "+" : ""}${t.r}%</span></div><div class="tl-l2"><span class="dt">${fmtDay(t.in)} → ${fmtDay(t.out)} · ${t.h}d</span></div></div>`).join("") : '<p class="empty">No trades in this bucket.</p>';
    $("tl-note").textContent = `${rows.length} trade${rows.length === 1 ? "" : "s"}`;
    $("bt-panel").classList.add("open");
  }
  function closeTrades() {
    $("bt-panel").classList.remove("open");
    btKind = null;
  }
  $("tl-close").onclick = closeTrades;

  // --------------------------------------------------------------- nav
  function show(next) {
    view = next;
    ["list", "detail", "weekly", "backtest"].forEach((name) => {
      $("view-" + name).hidden = name !== next;
    });
    $("run").hidden = next !== "list";
    $("bt-chips").hidden = next !== "backtest" || !backtest;
    document.querySelectorAll("nav button").forEach((button) => {
      button.classList.toggle("on", button.dataset.view === next || (next === "detail" && button.dataset.view === "list"));
    });
    if (next !== "detail") $("title").textContent = next === "weekly" ? "Weekly review" : next === "backtest" ? "Backtest" : "BursaMusangKing";
    document.querySelector("main")?.scrollTo(0, 0);
    if (next === "weekly") renderWeekly();
    if (next === "backtest") renderBacktest();
    requestAnimationFrame(redraw);
  }
  document.querySelectorAll("nav button").forEach((button) => {
    button.onclick = () => { current = null; show(button.dataset.view); };
  });
  function redraw() {
    if (view === "list" && latest) renderList();
    if (view === "detail" && current) drawDetail($("d-chart"), historyCache[current.symbol] || current.spark);
    if (view === "weekly" && weekly?.equity_curve?.length > 1) drawLine($("w-chart"), weekly.equity_curve);
    if (view === "backtest" && backtest) {
      const eq = btCurrent()?.equity || {};
      drawLine($("bt-chart"), eq.train || [], eq.test || []);
    }
  }

  // --------------------------------------------------------------- scan
  $("run").onclick = async () => {
    if (DEMO) {
      banner("Demo mode — set WORKER_URL in config.js to run real scans.", "err");
      setTimeout(() => banner(null), 3500);
      return;
    }
    const button = $("run");
    button.disabled = true;
    banner("Queuing scan…");
    const before = latest?.generated_at || null;
    try {
      const headers = { "Content-Type": "application/json" };
      if (CFG.RUN_TOKEN) headers["X-Run-Token"] = CFG.RUN_TOKEN;
      const response = await fetch(API + "/run", { method: "POST", headers, body: "{}" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) throw new Error(body.detail || body.error || response.status);
    } catch (error) {
      banner(`Couldn't start the scan: ${error.message}`, "err");
      button.disabled = false;
      return;
    }
    banner("Scanning the full market. Results refresh automatically.");
    pollForNew(before, Date.now() + (CFG.POLL_SECONDS || 420) * 1000);
  };
  function pollForNew(before, deadline) {
    clearTimeout(pollTimer);
    const poll = async () => {
      try {
        const fresh = await get("/latest");
        if (fresh.generated_at && fresh.generated_at !== before) {
          latest = fresh;
          renderChips(); renderList();
          $("updated").textContent = `Updated ${fmtTime(latest.generated_at)}`;
          $("run").disabled = false;
          banner(`Scan complete — ${latest.total_hits || latest.stocks?.length || 0} matches.`);
          setTimeout(() => banner(null), 4000);
          return;
        }
      } catch (_) { /* retry */ }
      if (Date.now() >= deadline) {
        $("run").disabled = false;
        banner("The scan is still running or timed out. Check GitHub Actions.", "err");
        return;
      }
      pollTimer = setTimeout(poll, 10000);
    };
    pollTimer = setTimeout(poll, 8000);
  }

  // --------------------------------------------------------------- startup
  if (DEMO) banner("Demo mode — showing sample data. Set WORKER_URL in config.js to connect live scans.");
  show("list");
  loadAll();
  if ("serviceWorker" in navigator) {
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloaded) return;
      reloaded = true;
      location.reload();
    });
    navigator.serviceWorker.register("sw.js").then((reg) => reg.update().catch(() => {})).catch(() => {});
  }
})();
