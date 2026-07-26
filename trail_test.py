"""
Compare exit rules on the same entry signals.

Entries come from your existing strategies, unchanged. Only the EXIT differs,
so any difference in the numbers is attributable to the exit rule and nothing
else — same signals, same bars, same fill assumptions.

  python trail_test.py --symbol GCB
  python trail_test.py --symbol GCB --strategy trending
  python trail_test.py --top 300                    # whole liquid universe
  python trail_test.py --top 300 --strategy trending --split 0.7

Variants tested:
  fixed        your current rule: +15% target, -7% stop, 40-bar time limit
  trail2.0     no target; stop trails 2.0 x ATR14 below the highest close
  trail2.5     same at 2.5 x ATR
  trail3.0     same at 3.0 x ATR
  trail3.5     same at 3.5 x ATR
  ema20        no target; exit on first close below EMA20

Every trailing variant keeps the -7% initial stop until the trail rises above
it, and the stop only ever ratchets up.
"""

import argparse
import sys
from datetime import datetime

import numpy as np
import pandas as pd

import upstream

# Peak tracked on CLOSES, not intraday highs. Using the day's high to set the
# peak and then assuming the stop fills at its exact price credits you the best
# print of the day and debits a clean fill — flattering, and on thin Bursa
# counters that gap is real money.
TRAIL_MULTS = [2.0, 2.5, 3.0, 3.5]
MAX_HOLD_TRAIL = 250   # a cap this loose exists only to stop runaway loops


def simulate(df: pd.DataFrame, entries: list[int], rule: str,
             stop_pct: float, tp_pct: float | None, max_hold: int,
             mult: float = 2.5) -> pd.DataFrame:
    """Walk each entry forward under one exit rule. Returns a trade frame."""
    o = df["open"].to_numpy(float)
    h = df["high"].to_numpy(float)
    lo = df["low"].to_numpy(float)
    c = df["close"].to_numpy(float)
    atr = df["atr"].to_numpy(float) if "atr" in df.columns else np.full(len(df), np.nan)
    ema = df["ema20"].to_numpy(float) if "ema20" in df.columns else np.full(len(df), np.nan)
    n = len(df)

    rows = []
    for sig in entries:
        i = sig + 1                       # entry at the next bar's open
        if i >= n:
            continue
        entry = o[i]
        if not np.isfinite(entry) or entry <= 0:
            continue

        stop = entry * (1 - stop_pct)
        target = entry * (1 + tp_pct) if tp_pct else None
        peak = c[i]
        exit_px, exit_i, why = None, None, None

        for j in range(i, min(n, i + max_hold + 1)):
            # Stop checked before target and before the peak update. If a bar
            # both takes out the stop and makes a new high, assuming the good
            # outcome is how backtests flatter themselves.
            if lo[j] <= stop:
                exit_px, exit_i, why = stop, j, "stop"
                break
            if target is not None and h[j] >= target:
                exit_px, exit_i, why = target, j, "target"
                break

            peak = max(peak, c[j])

            if rule == "trail" and np.isfinite(atr[j]):
                stop = max(stop, peak - mult * atr[j])
            elif rule == "ema20" and np.isfinite(ema[j]) and j > i and c[j] < ema[j]:
                exit_px, exit_i, why = c[j], j, "ema20"
                break

        if exit_px is None:
            j = min(n - 1, i + max_hold)
            exit_px, exit_i, why = c[j], j, "timeout"

        rows.append({
            "entry_date": df.index[i], "exit_date": df.index[exit_i],
            "ret_pct": (exit_px / entry - 1) * 100,
            "hold_days": exit_i - i, "reason": why,
            "peak_pct": (peak / entry - 1) * 100,
        })

    return pd.DataFrame(rows)


def stats(tr: pd.DataFrame) -> dict:
    if tr is None or tr.empty:
        return {"trades": 0}
    r = tr["ret_pct"]
    w, l = r[r > 0], r[r <= 0]
    gl = abs(l.sum())
    equity = float(np.prod(1 + r / 100))
    return {
        "trades": len(r),
        "win%": round(100 * len(w) / len(r), 1),
        "avg%": round(r.mean(), 2),
        "avg_win%": round(w.mean(), 2) if len(w) else 0.0,
        "avg_loss%": round(l.mean(), 2) if len(l) else 0.0,
        "PF": round(w.sum() / gl, 2) if gl else float("inf"),
        "best%": round(r.max(), 1),
        "worst%": round(r.min(), 1),
        "hold": round(tr["hold_days"].mean(), 1),
        "giveback%": round((tr["peak_pct"] - tr["ret_pct"]).mean(), 1),
        "equityx": round(equity, 2),
    }


def table(title: str, results: dict):
    cols = ["trades", "win%", "avg%", "avg_win%", "avg_loss%", "PF",
            "best%", "worst%", "hold", "giveback%", "equityx"]
    print(f"\n{title}")
    print("-" * 120)
    print(f"{'rule':<10}" + "".join(f"{c:>10}" for c in cols))
    print("-" * 120)
    for name, s in results.items():
        if s.get("trades", 0) == 0:
            print(f"{name:<10}{'no trades':>9}")
            continue
        print(f"{name:<10}" + "".join(f"{s.get(c, ''):>10}" for c in cols))


def run(symbols, strategies, split, stop_pct, tp_pct, max_hold_fixed):
    eng = upstream.engine()
    config = eng["config"]
    screener = eng["screener"]
    indicators = eng["indicators"]
    data_fetcher = eng["data_fetcher"]

    data = data_fetcher.fetch_many(
        symbols, max_workers=config.UNIVERSE["max_workers"])
    have = {k: v for k, v in data.items() if v is not None and not v.empty}
    print(f"price history: {len(have)}/{len(symbols)} symbols")
    if not have:
        print("no data — nothing to test")
        return

    variants = {"fixed": ("fixed", None, tp_pct, max_hold_fixed)}
    for m in TRAIL_MULTS:
        variants[f"trail{m}"] = ("trail", m, None, MAX_HOLD_TRAIL)
    variants["ema20"] = ("ema20", None, None, MAX_HOLD_TRAIL)

    all_trades = {k: [] for k in variants}
    signal_count, stats_errors, err_examples = {}, {}, {}

    for sym, raw in have.items():
        try:
            df = indicators.enrich(raw)
        except Exception as exc:
            print(f"  !! {sym}: enrich failed ({exc}) — skipped")
            continue

        for strat in strategies:
            check = screener.CHECKS.get(strat)
            if check is None:
                raise SystemExit(
                    f"unknown strategy '{strat}'. Available: "
                    + ", ".join(screener.CHECKS))
            params = config.STRATEGIES[strat]

            # The same check function the live scan and the backtester call,
            # evaluated at every bar. Errors are counted, not swallowed — a
            # silent skip here reports "no trades" for what is actually a bug.
            entries, errs, last_err = [], 0, None
            for i in range(60, len(df) - 1):
                try:
                    hit = check(df, i, params)
                except Exception as exc:
                    errs += 1
                    last_err = exc
                    continue
                if hit and (not entries or i - entries[-1] > 5):
                    entries.append(i)

            if errs:
                stats_errors[strat] = stats_errors.get(strat, 0) + errs
                if last_err is not None:
                    err_examples.setdefault(strat, str(last_err))
            signal_count[strat] = signal_count.get(strat, 0) + len(entries)
            if not entries:
                continue

            for name, (rule, mult, tp, mh) in variants.items():
                t = simulate(df, entries, rule, stop_pct, tp, mh,
                             mult=mult or 2.5)
                if not t.empty:
                    t["symbol"] = sym
                    t["strategy"] = strat
                    all_trades[name].append(t)

    frames = {k: (pd.concat(v, ignore_index=True).sort_values("entry_date")
                  if v else pd.DataFrame())
              for k, v in all_trades.items()}

    print("entry signals found: " + (", ".join(
        f"{k} {v}" for k, v in signal_count.items()) or "none"))
    for strat, count in stats_errors.items():
        print(f"  !! {strat}: {count} bars raised an error, e.g. "
              f"{err_examples.get(strat, '?')}")

    n = len(frames.get("fixed", pd.DataFrame()))
    if n == 0:
        print("\nNo trades. Either the strategy genuinely never triggered on "
              "this sample,\nor an error above suppressed it. With a single "
              "symbol, no trigger is common —\n'trending' needs a full "
              "EMA20>EMA50>EMA200 stack plus ADX and RSI in range\nall at once, "
              "which many counters never satisfy. Try --top 300.")
        return

    table(f"ALL TRADES  ({', '.join(strategies)})",
          {k: stats(v) for k, v in frames.items()})

    if split and n:
        cut = int(n * split)
        table(f"TRAIN (first {int(split*100)}%)",
              {k: stats(v.iloc[:cut]) for k, v in frames.items() if not v.empty})
        table(f"TEST (last {int((1-split)*100)}%)",
              {k: stats(v.iloc[cut:]) for k, v in frames.items() if not v.empty})

    print("\nColumns: giveback% = average distance from a trade's peak to where "
          "it actually exited.\n         equityx = compounding every trade "
          "sequentially, one position at a time.")

    if n < 30:
        print(f"\n*** {n} trades is far too few to choose an exit rule on. ***\n"
              "    Differences this small are noise. Re-run with --top 300 for "
              "a sample\n    that can actually distinguish the variants.")
    elif n < 100:
        print(f"\nNote: {n} trades is a thin sample — treat gaps under about "
              "0.3 in PF as noise.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", action="append",
                    help="ticker, repeatable (e.g. --symbol GCB)")
    ap.add_argument("--top", type=int, default=0,
                    help="instead of --symbol, use the N most liquid stocks")
    ap.add_argument("--strategy", action="append",
                    help="strategy name, repeatable; default = all enabled")
    ap.add_argument("--split", type=float, default=0.7,
                    help="train/test split, 0 to disable")
    ap.add_argument("--stop", type=float, default=None,
                    help="initial stop as a fraction, default from config")
    ap.add_argument("--tp", type=float, default=None,
                    help="fixed take-profit as a fraction, default from config")
    ap.add_argument("--hold", type=int, default=None,
                    help="max bars for the fixed rule, default from config")
    a = ap.parse_args()

    eng = upstream.engine()
    cfg = eng["config"]
    bt = cfg.BACKTEST

    stop_pct = a.stop if a.stop is not None else abs(bt.get("stop_loss_pct", 7)) / 100
    tp_pct = a.tp if a.tp is not None else abs(bt.get("take_profit_pct", 15)) / 100
    hold = a.hold if a.hold is not None else bt.get("hold_days", 40)

    strategies = a.strategy or [k for k, v in cfg.STRATEGIES.items()
                                if v.get("enabled", True)]

    if a.symbol:
        symbols = a.symbol
    elif a.top:
        from universe import get_universe
        symbols = get_universe()["symbol"].dropna().unique().tolist()[: a.top]
    else:
        print("give --symbol GCB or --top 300")
        sys.exit(1)

    print(f"[{datetime.now():%Y-%m-%d %H:%M}] {len(symbols)} symbol(s), "
          f"strategies: {', '.join(strategies)}")
    print(f"fixed rule: +{tp_pct*100:.0f}% target / -{stop_pct*100:.0f}% stop "
          f"/ {hold} bars")
    run(symbols, strategies, a.split, stop_pct, tp_pct, hold)
