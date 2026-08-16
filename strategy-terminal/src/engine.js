export const STRATEGIES = ["trending", "gaining_momentum", "meta_leader"];

export function processState(prev, row, strategy, opts = {}) {
  const commissionPct = Number(opts.commissionPct || 0);
  const stopLossPct = Number(opts.stopLossPct ?? -7);
  const atrMult = Number(opts.atrMult || 3);
  const nearStopPct = Number(opts.nearStopPct || 3);
  const hit = Boolean(row.hits?.[strategy]);
  const tradeDate = row.trade_date;
  const open = Number(row.open);
  const low = Number(row.low);
  const close = Number(row.close);
  const atr = Number(row.atr);

  const s = prev ? { ...prev } : {
    strategy, symbol: row.symbol, name: row.name || "", status: "FLAT", cycle: 0,
    hold_days: 0
  };
  s.name = row.name || s.name || "";
  s.latest_close = close;
  s.latest_atr = atr;
  s.last_trade_date = tradeDate;
  s.updated_at = new Date().toISOString();
  const events = [];

  if (s.status === "BUY_PENDING") {
    if (tradeDate > String(s.signal_date || "") && open > 0 && low > 0 && close > 0) {
      s.status = "OPEN";
      s.entry_date = tradeDate;
      s.entry_price = open;
      s.peak_close = close;
      s.initial_stop = open * (1 + stopLossPct / 100);
      s.atr_stop = s.initial_stop;
      s.hold_days = 0;
      events.push(ev("ENTRY_CONFIRMED", row, strategy, open, s, `Entry confirmed at next-session open ${fmt(open)}.`));
      if (low <= s.atr_stop) {
        closeTrade(s, row, strategy, commissionPct, events, "trail_stop");
      } else if (atr > 0) {
        s.atr_stop = Math.max(s.atr_stop, s.peak_close - atrMult * atr);
      }
    }
    return { state: s, events };
  }

  if (s.status === "OPEN" || s.status === "NEAR_SELL") {
    s.hold_days = Number(s.hold_days || 0) + 1;
    if (low <= Number(s.atr_stop)) {
      closeTrade(s, row, strategy, commissionPct, events, "trail_stop");
      return { state: s, events };
    }
    if (close > Number(s.peak_close || close)) s.peak_close = close;
    if (atr > 0) s.atr_stop = Math.max(Number(s.atr_stop || 0), s.peak_close - atrMult * atr);
    const dist = close > 0 ? (close / s.atr_stop - 1) * 100 : 999;
    if (dist <= nearStopPct) {
      if (s.status !== "NEAR_SELL") events.push(ev("NEAR_SELL", row, strategy, close, s, `Price is ${dist.toFixed(1)}% above the ATR stop.`));
      s.status = "NEAR_SELL";
    } else {
      s.status = "OPEN";
    }
    return { state: s, events };
  }

  if (s.status === "CLOSED") {
    if (tradeDate <= String(s.closed_date || "")) return { state: s, events };
    s.status = "FLAT";
  }

  if (s.status === "FLAT" && hit) {
    s.status = "BUY_PENDING";
    s.signal_date = tradeDate;
    s.cycle = Number(s.cycle || 0) + 1;
    s.last_event = "BUY_SIGNAL";
    events.push(ev("BUY_SIGNAL", row, strategy, close, s, `New ${strategyLabel(strategy)} ATR buy signal. Entry is next session open.`));
  }
  return { state: s, events };
}

function closeTrade(s, row, strategy, commissionPct, events, reason) {
  const exit = Number(s.atr_stop);
  const gross = (exit / Number(s.entry_price) - 1) * 100;
  const net = gross - 2 * commissionPct;
  s.status = "CLOSED";
  s.closed_date = row.trade_date;
  s.exit_price = exit;
  s.return_pct = net;
  s.last_event = "SELL";
  events.push(ev("SELL", row, strategy, exit, s, `ATR trailing stop triggered at ${fmt(exit)}; strategy return ${net.toFixed(2)}%.`));
}

function ev(type, row, strategy, price, s, message) {
  return {
    event_type: type,
    trade_date: row.trade_date,
    strategy,
    symbol: row.symbol,
    name: row.name || "",
    price,
    atr_stop: Number.isFinite(Number(s.atr_stop)) ? Number(s.atr_stop) : null,
    entry_price: Number.isFinite(Number(s.entry_price)) ? Number(s.entry_price) : null,
    return_pct: Number.isFinite(Number(s.return_pct)) ? Number(s.return_pct) : null,
    cycle: Number(s.cycle || 0),
    message
  };
}

export function strategyLabel(s) {
  return ({trending:"Trending", gaining_momentum:"Momentum", meta_leader:"M.E.T.A."})[s] || s;
}

export function fmt(n) { return `RM${Number(n).toFixed(3)}`; }
