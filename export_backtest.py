"""
Run the backtester under two exit rules -> public/backtest.json.

  fixed   your current rule, straight from upstream's backtest.backtest():
          +take_profit% target, -stop_loss% stop, hold_days limit
  atr     same entry signals, but no target at all — the stop trails
          TRAIL_ATR_MULT x ATR14 below the highest close since entry and only
          ever ratchets up, with a much looser hold limit

Everything else is shared: the same check functions, the same next-bar-open
entry, the same commission both sides, the same conservative
stop-before-target resolution within a bar.

  python export_backtest.py --top 300
  python export_backtest.py --top 300 --publish
  TRAIL_ATR_MULT=2.5 python export_backtest.py --top 300
"""

import argparse
import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

import upstream

OUT = Path("public")
MAX_TRADES_PER_STRATEGY = 400
TRAIL_ATR_MULT = float(os.environ.get("TRAIL_ATR_MULT", "3.0"))
TRAIL_HOLD_DAYS = 250   # a limit this loose exists only to bound the loop


def _clean(v):
    if v is None:
        return None
    if isinstance(v, float):
        if math.isinf(v) or math.isnan(v):
            return None
        return round(v, 3)
    return v


# --------------------------------------------------------------- ATR exit
def _simulate_atr(df: pd.DataFrame, signal_i: int, bt: dict, mult: float) -> dict | None:
    """Enter at the next open; exit on a ratcheting ATR trailing stop.

    Deliberately mirrors upstream simulate_trade() in every respect except the
    exit, so any difference in results is the exit rule and nothing else:
    same entry bar, same commission, same stop-fills-at-stop-price assumption.

    The peak is tracked on CLOSES, not intraday highs. Using the day's high to
    set the peak and then assuming a clean fill at the stop credits you the
    best print and debits the best fill — flattering, and on thin Bursa
    counters that gap is real money.
    """
    entry_i = signal_i + 1
    if entry_i >= len(df):
        return None
    entry = float(df["open"].iloc[entry_i])
    if entry <= 0:
        return None

    o = df["open"].to_numpy(float)
    lo_a = df["low"].to_numpy(float)
    c_a = df["close"].to_numpy(float)
    atr_a = (df["atr"].to_numpy(float) if "atr" in df.columns
             else pd.Series([float("nan")] * len(df)).to_numpy())

    stop = entry * (1 + bt["stop_loss_pct"] / 100)   # stop_loss_pct is negative
    peak = c_a[entry_i]
    exit_price, exit_i, reason = None, None, "timeout"
    last = min(entry_i + TRAIL_HOLD_DAYS, len(df) - 1)

    for j in range(entry_i, last + 1):
        # Stop checked before the peak update: a bar that both breaks the stop
        # and makes a new high resolves against us, as upstream does.
        if lo_a[j] <= stop:
            exit_price, exit_i, reason = stop, j, "trail_stop"
            break
        if c_a[j] > peak:
            peak = c_a[j]
        a = atr_a[j]
        if a == a and a > 0:                      # not NaN
            stop = max(stop, peak - mult * a)     # ratchet only

    if exit_price is None:
        exit_price, exit_i = float(c_a[last]), last

    gross = (exit_price / entry - 1) * 100
    net = gross - 2 * bt["commission_pct"]
    return {
        "entry_date": df.index[entry_i], "exit_date": df.index[exit_i],
        "entry": entry, "exit": exit_price, "ret_pct": net,
        "hold_days": exit_i - entry_i, "reason": reason,
    }


def _backtest_atr(data, strategies, bt, indicators, checks, mult) -> dict:
    """Mirror of upstream backtest() with the ATR exit substituted in."""
    all_trades = {s: [] for s in strategies}
    for symbol, raw in data.items():
        try:
            df = indicators.enrich(raw)
        except Exception:
            continue
        n = len(df)
        for name, params in strategies.items():
            if not params.get("enabled", True):
                continue
            check = checks[name]
            cooldown_until = -1
            for i in range(220, n - 1):           # EMA200 warm-up, as upstream
                if i <= cooldown_until:
                    continue
                try:
                    if check(df, i, params):
                        tr = _simulate_atr(df, i, bt, mult)
                        if tr:
                            tr["symbol"] = symbol
                            tr["strategy"] = name
                            all_trades[name].append(tr)
                            cooldown_until = i + tr["hold_days"] + 1
                except Exception:
                    continue
    return {s: pd.DataFrame(t) for s, t in all_trades.items()}


# ------------------------------------------------------------------- stats
def _stats(summarize, part: pd.DataFrame) -> dict:
    s = summarize(part)
    if not s or s.get("trades", 0) == 0:
        return {"trades": 0}
    r = part["ret_pct"]
    wins = int((r > 0).sum())
    losses = int((r <= 0).sum())
    total = wins + losses
    return {
        "trades": int(s["trades"]),
        "wins": wins,
        "losses": losses,
        "gross_profit": _clean(float(r[r > 0].sum())),
        "gross_loss": _clean(float(abs(r[r <= 0].sum()))),
        "win_rate": _clean(s.get("win_rate_%")),
        "loss_rate": _clean(round(100 * losses / total, 1)) if total else None,
        "avg": _clean(s.get("avg_ret_%")),
        "median": _clean(s.get("median_ret_%")),
        "profit_factor": _clean(s.get("profit_factor")),
        "best": _clean(s.get("best_%")),
        "worst": _clean(s.get("worst_%")),
        "avg_hold": _clean(s.get("avg_hold_days")),
        "avg_win": _clean(round(float(r[r > 0].mean()), 2)) if wins else None,
    }


def _equity(part: pd.DataFrame, start: float = 100.0):
    curve, peak, mdd, v = [], start, 0.0, start
    for _, row in part.iterrows():
        v *= (1 + float(row["ret_pct"]) / 100)
        peak = max(peak, v)
        mdd = min(mdd, (v / peak - 1) * 100)
        curve.append({"d": pd.Timestamp(row["exit_date"]).strftime("%Y-%m-%d"),
                      "v": round(v, 2)})
    return curve, round(mdd, 2)


def _thin(curve, keep=120):
    if len(curve) <= keep:
        return curve
    step = len(curve) / keep
    out = [curve[int(i * step)] for i in range(keep)]
    if out[-1] != curve[-1]:
        out.append(curve[-1])
    return out


def _verdict(train: dict, test: dict, baseline_pf: float | None = None) -> dict:
    n = test.get("trades", 0)
    if n < 20:
        return {"level": "thin", "text": f"Only {n} test trades — too few to judge."}

    pf_tr, pf_te = train.get("profit_factor"), test.get("profit_factor")
    wr_tr, wr_te = train.get("win_rate"), test.get("win_rate")
    if pf_te is None or pf_tr is None:
        return {"level": "thin", "text": "Profit factor unavailable for one period."}

    if pf_te < 1.0:
        v = {"level": "bad",
             "text": "Loses money out of sample. The in-sample edge did not survive."}
    elif pf_te < 1.2:
        v = {"level": "warn",
             "text": "Barely above break-even out of sample. Costs and slippage "
                     "could erase this."}
    elif pf_tr < 1.1:
        v = {"level": "warn",
             "text": "Train period barely worked, so the test gain is more likely "
                     "noise than a real edge."}
    elif pf_te < pf_tr * 0.75 or (wr_tr and wr_te and wr_te < wr_tr - 8):
        v = {"level": "warn",
             "text": "Test decays from train. Edge is real but weaker out of sample."}
    elif pf_te >= pf_tr:
        v = {"level": "good",
             "text": "Test holds up against train — no sign of curve-fitting."}
    else:
        v = {"level": "good", "text": "Test is close to train. Reasonably robust."}

    # Against your current rule, which is the question this screen answers.
    if baseline_pf is not None and pf_te is not None:
        if pf_te > baseline_pf * 1.1:
            v["vs"] = (f"Beats the fixed rule on test profit factor, "
                       f"{pf_te:.2f} against {baseline_pf:.2f}.")
        elif pf_te < baseline_pf * 0.9:
            v["vs"] = (f"Worse than the fixed rule, {pf_te:.2f} against "
                       f"{baseline_pf:.2f}.")
        else:
            v["vs"] = (f"Roughly level with the fixed rule, {pf_te:.2f} against "
                       f"{baseline_pf:.2f} — not a clear improvement.")
    return v


def _trades(part: pd.DataFrame, period: str) -> list:
    return [{
        "s": r["symbol"],
        "in": pd.Timestamp(r["entry_date"]).strftime("%Y-%m-%d"),
        "out": pd.Timestamp(r["exit_date"]).strftime("%Y-%m-%d"),
        "r": round(float(r["ret_pct"]), 2),
        "h": int(r["hold_days"]),
        "x": r["reason"],
        "p": period,
    } for _, r in part.iterrows()]


def _pack(name, trades_by_strat, summarize, split, baseline_pf=None) -> dict:
    """Turn one exit rule's trade frames into the per-strategy JSON block."""
    out = {}
    for strat, tr in trades_by_strat.items():
        if tr is None or tr.empty:
            out[strat] = {"train": {"trades": 0}, "test": {"trades": 0},
                          "verdict": {"level": "thin", "text": "No trades generated."},
                          "equity": {"train": [], "test": []},
                          "max_drawdown": None, "trades": [], "trades_total": 0}
            continue
        tr = tr.sort_values("entry_date").reset_index(drop=True)
        cut = int(len(tr) * split)
        a, b = tr.iloc[:cut], tr.iloc[cut:]
        ta, tb = _stats(summarize, a), _stats(summarize, b)
        eq_a, _ = _equity(a)
        eq_b, mdd = _equity(b, start=eq_a[-1]["v"] if eq_a else 100.0)
        rows = _trades(b, "test") + _trades(a, "train")
        rows.sort(key=lambda r: r["in"], reverse=True)
        out[strat] = {
            "train": ta, "test": tb,
            "verdict": _verdict(ta, tb, (baseline_pf or {}).get(strat)),
            "equity": {"train": _thin(eq_a), "test": _thin(eq_b)},
            "max_drawdown": mdd,
            "trades": rows[:MAX_TRADES_PER_STRATEGY],
            "trades_total": len(tr),
        }
    return out


def run(top: int = 300, publish: bool = False, mult: float = TRAIL_ATR_MULT) -> dict:
    eng = upstream.engine()
    config = eng["config"]
    indicators = eng["indicators"]
    data_fetcher = eng["data_fetcher"]
    screener = eng["screener"]

    upstream.ensure()
    import backtest as bt_mod

    # No pre-filter: the live pre-filter reads TODAY's indicators, and using it
    # to choose which stocks to replay would leak the future backwards.
    if config.USE_FULL_MARKET:
        try:
            from universe import get_universe
            symbols = get_universe()["symbol"].dropna().unique().tolist()
            if top > 0:
                symbols = symbols[:top]
            print(f"backtesting {len(symbols)} stocks...")
            data = data_fetcher.fetch_many(
                symbols, max_workers=config.UNIVERSE["max_workers"])
        except Exception as exc:
            print(f"universe fetch failed ({exc}); using watchlist")
            data = data_fetcher.fetch_watchlist()
    else:
        data = data_fetcher.fetch_watchlist()

    print(f"got data for {len(data)} symbols")
    split = config.BACKTEST["train_test_split"]

    # Backtesting is measurement, not trading. A strategy switched off for the
    # live scan is exactly the one you need numbers for before deciding to
    # switch it on, so force-enable everything here — `enabled` continues to
    # gate the live scan and Telegram alerts, and nothing here sends anything.
    live = {k: bool(v.get("enabled", True)) for k, v in config.STRATEGIES.items()}
    strategies = {k: {**v, "enabled": True}
                  for k, v in config.STRATEGIES.items()
                  if k in screener.CHECKS}
    off = [k for k, on in live.items() if not on and k in strategies]
    if off:
        print(f"including strategies not live in the scan: {', '.join(off)}")

    print("replaying with the fixed exit...")
    fixed_trades = bt_mod.backtest(data, strategies)

    print(f"replaying with the ATR trail ({mult}x)...")
    atr_trades = _backtest_atr(data, strategies, config.BACKTEST,
                               indicators, screener.CHECKS, mult)

    fixed_block = _pack("fixed", fixed_trades, bt_mod.summarize, split)
    baseline_pf = {s: (v.get("test") or {}).get("profit_factor")
                   for s, v in fixed_block.items()}
    atr_block = _pack("atr", atr_trades, bt_mod.summarize, split,
                      baseline_pf=baseline_pf)

    first = last = None
    for df in data.values():
        if df is None or df.empty:
            continue
        a, b = df.index[0], df.index[-1]
        first = a if first is None or a < first else first
        last = b if last is None or b > last else last

    bt = config.BACKTEST
    out_strategies = []
    for strat in strategies:
        f, t = fixed_block.get(strat, {}), atr_block.get(strat, {})
        out_strategies.append({"strategy": strat,
                               "live": live.get(strat, True),
                               "exits": {"fixed": f, "atr": t}})
        print(f"  {strat}: fixed {f.get('trades_total', 0)} trades "
              f"(PF test {(f.get('test') or {}).get('profit_factor')}), "
              f"atr {t.get('trades_total', 0)} trades "
              f"(PF test {(t.get('test') or {}).get('profit_factor')})")

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "market": config.MARKET,
        "currency": config.CURRENCY,
        "universe_size": len(data),
        "split": split,
        "date_from": pd.Timestamp(first).strftime("%Y-%m-%d") if first is not None else None,
        "date_to": pd.Timestamp(last).strftime("%Y-%m-%d") if last is not None else None,
        "exit_rules": [
            {"key": "fixed",
             "label": f"Fixed +{abs(bt['take_profit_pct']):.0f}%/"
                      f"-{abs(bt['stop_loss_pct']):.0f}%",
             "detail": f"target +{abs(bt['take_profit_pct']):.0f}% · "
                       f"stop -{abs(bt['stop_loss_pct']):.0f}% · "
                       f"hold {bt['hold_days']}d"},
            {"key": "atr",
             "label": f"ATR trail {mult:g}x",
             "detail": f"no target · stop trails {mult:g}x ATR14 below the "
                       f"highest close · initial stop "
                       f"-{abs(bt['stop_loss_pct']):.0f}% · hold {TRAIL_HOLD_DAYS}d"},
        ],
        "params": {k: v for k, v in bt.items() if k != "train_test_split"},
        "trail_atr_mult": mult,
        "strategy_config": {k: {kk: vv for kk, vv in v.items() if kk != "enabled"}
                            for k, v in strategies.items()},
        "strategies": out_strategies,
        "note": "Entry at next bar's open, stop assumed to fill at the stop "
                "price, commission both sides. Each exit rule re-enters only "
                "after its own trade closes, so trade counts differ — longer "
                "holds mean fewer opportunities, which is a real cost of "
                "trailing. Not advice.",
    }

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "backtest.json").write_text(json.dumps(report, separators=(",", ":")))
    print(f"wrote public/backtest.json "
          f"({(OUT / 'backtest.json').stat().st_size // 1024}KB)")

    if publish:
        from export_scan import publish_files
        publish_files(only=("backtest",))
    return report


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=300)
    ap.add_argument("--mult", type=float, default=TRAIL_ATR_MULT,
                    help="ATR multiple for the trailing stop")
    ap.add_argument("--publish", action="store_true")
    a = ap.parse_args()
    run(top=a.top, publish=a.publish, mult=a.mult)
