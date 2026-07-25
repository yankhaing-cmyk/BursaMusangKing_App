"""
Run the upstream backtester -> public/backtest.json for the app's Backtest tab.

Reuses backtest.backtest() from your original repo unchanged, so the numbers
here are the same numbers `python backtest.py` prints. This file only adds the
things a console report can't give you: an equity curve, a drawdown figure,
a train-vs-test verdict, and the individual trades behind every metric.

The trade list is the point. A profit factor of 1.6 built almost entirely on
one +38% outlier is not a 1.6 strategy, and a backtest will happily "fill"
a counter that traded RM40k that day. Neither is visible in a summary row.

  python export_backtest.py --top 300
  python export_backtest.py --top 300 --publish
  python export_backtest.py                  # entire universe, slow
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
MAX_TRADES_PER_STRATEGY = 400   # newest first; keeps the KV blob small


def _clean(v):
    """JSON has no inf/nan. Profit factor is inf when a period had no losers."""
    if v is None:
        return None
    if isinstance(v, float):
        if math.isinf(v) or math.isnan(v):
            return None
        return round(v, 3)
    return v


def _stats(summarize, part: pd.DataFrame) -> dict:
    s = summarize(part)
    if not s or s.get("trades", 0) == 0:
        return {"trades": 0}

    # Counted here rather than derived from win_rate — rounding a percentage
    # back into a count drifts by one or two on small samples.
    r = part["ret_pct"]
    wins = int((r > 0).sum())
    losses = int((r <= 0).sum())
    total = wins + losses

    return {
        "trades": int(s["trades"]),
        "wins": wins,
        "losses": losses,
        # Emitted so the app can compute each trade's share of profit against
        # the TRUE period total, not just the trades that fit in the capped
        # list. Otherwise contribution percentages would quietly overstate.
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
    }


def _equity(part: pd.DataFrame, start: float = 100.0) -> tuple[list, float]:
    """Compound trade returns in entry order. Returns (curve, max_drawdown_pct).

    Sequential compounding assumes one position at a time — it is a shape to
    eyeball, not a portfolio simulation. Real concurrent positions and position
    sizing would change both the curve and the drawdown.
    """
    curve, peak, mdd, v = [], start, 0.0, start
    for _, row in part.iterrows():
        v *= (1 + float(row["ret_pct"]) / 100)
        peak = max(peak, v)
        mdd = min(mdd, (v / peak - 1) * 100)
        curve.append({
            "d": pd.Timestamp(row["exit_date"]).strftime("%Y-%m-%d"),
            "v": round(v, 2),
        })
    return curve, round(mdd, 2)


def _thin(curve: list, keep: int = 120) -> list:
    """Downsample for the phone. 400 points in a 150px-tall chart is mush."""
    if len(curve) <= keep:
        return curve
    step = len(curve) / keep
    out = [curve[int(i * step)] for i in range(keep)]
    if out[-1] != curve[-1]:
        out.append(curve[-1])
    return out


def _verdict(train: dict, test: dict) -> dict:
    """Compare out-of-sample against in-sample. Great TRAIN + bad TEST is the
    signature of a curve-fit, which is the whole reason for the split."""
    n = test.get("trades", 0)
    if n < 20:
        return {"level": "thin",
                "text": f"Only {n} test trades — too few to judge."}

    pf_tr, pf_te = train.get("profit_factor"), test.get("profit_factor")
    wr_tr, wr_te = train.get("win_rate"), test.get("win_rate")

    if pf_te is None or pf_tr is None:
        return {"level": "thin", "text": "Profit factor unavailable for one period."}

    if pf_te < 1.0:
        return {"level": "bad",
                "text": "Loses money out of sample. The in-sample edge did not survive."}

    if pf_te < 1.2:
        return {"level": "warn",
                "text": "Barely above break-even out of sample. Costs and slippage "
                        "could erase this."}

    # Test beating a train period that itself barely worked is noise, not edge.
    if pf_tr < 1.1:
        return {"level": "warn",
                "text": "Train period barely worked, so the test gain is more likely "
                        "noise than a real edge."}

    if pf_te < pf_tr * 0.75 or (wr_tr and wr_te and wr_te < wr_tr - 8):
        return {"level": "warn",
                "text": "Test decays from train. Edge is real but weaker out of sample."}

    if pf_te >= pf_tr:
        return {"level": "good",
                "text": "Test holds up against train — no sign of curve-fitting."}

    return {"level": "good", "text": "Test is close to train. Reasonably robust."}


def _trades(part: pd.DataFrame, period: str) -> list:
    rows = []
    for _, r in part.iterrows():
        rows.append({
            "s": r["symbol"],
            "in": pd.Timestamp(r["entry_date"]).strftime("%Y-%m-%d"),
            "out": pd.Timestamp(r["exit_date"]).strftime("%Y-%m-%d"),
            "r": round(float(r["ret_pct"]), 2),
            "h": int(r["hold_days"]),
            "x": r["reason"],
            "p": period,
        })
    return rows


def run(top: int = 300, publish: bool = False) -> dict:
    eng = upstream.engine()
    config = eng["config"]
    data_fetcher = eng["data_fetcher"]

    upstream.ensure()
    import backtest as bt_mod

    # No pre-filter here, deliberately. The live pre-filter reads TODAY's
    # indicators; using it to choose which stocks to replay would leak the
    # future into the past.
    if config.USE_FULL_MARKET:
        try:
            from universe import get_universe
            uni = get_universe()
            symbols = uni["symbol"].dropna().unique().tolist()
            if top > 0:
                symbols = symbols[:top]      # universe is sorted by traded value
            print(f"backtesting {len(symbols)} stocks...")
            data = data_fetcher.fetch_many(
                symbols, max_workers=config.UNIVERSE["max_workers"])
        except Exception as exc:
            print(f"universe fetch failed ({exc}); using watchlist")
            data = data_fetcher.fetch_watchlist()
    else:
        data = data_fetcher.fetch_watchlist()

    print(f"got data for {len(data)} symbols, replaying...")
    trades_by_strat = bt_mod.backtest(data)
    split = config.BACKTEST["train_test_split"]

    first, last = None, None
    for df in data.values():
        if df is None or df.empty:
            continue
        a, b = df.index[0], df.index[-1]
        first = a if first is None or a < first else first
        last = b if last is None or b > last else last

    out_strats = []
    for name, tr in trades_by_strat.items():
        if tr is None or tr.empty:
            out_strats.append({"strategy": name, "train": {"trades": 0},
                               "test": {"trades": 0},
                               "verdict": {"level": "thin",
                                           "text": "No trades generated."},
                               "equity": {"train": [], "test": []},
                               "max_drawdown": None, "trades": []})
            continue

        tr = tr.sort_values("entry_date").reset_index(drop=True)
        cut = int(len(tr) * split)
        train_p, test_p = tr.iloc[:cut], tr.iloc[cut:]

        train_s, test_s = _stats(bt_mod.summarize, train_p), _stats(bt_mod.summarize, test_p)
        eq_train, _ = _equity(train_p)
        start_test = eq_train[-1]["v"] if eq_train else 100.0
        eq_test, mdd_test = _equity(test_p, start=start_test)

        rows = _trades(test_p, "test") + _trades(train_p, "train")
        rows.sort(key=lambda r: r["in"], reverse=True)

        out_strats.append({
            "strategy": name,
            "train": train_s,
            "test": test_s,
            "verdict": _verdict(train_s, test_s),
            "equity": {"train": _thin(eq_train), "test": _thin(eq_test)},
            "max_drawdown": mdd_test,
            "trades": rows[:MAX_TRADES_PER_STRATEGY],
            "trades_total": len(tr),
        })

        print(f"  {name}: {len(tr)} trades "
              f"(train {train_s.get('trades', 0)} / test {test_s.get('trades', 0)})")

    enabled = {k: v for k, v in config.STRATEGIES.items() if v.get("enabled", True)}
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "market": config.MARKET,
        "currency": config.CURRENCY,
        "universe_size": len(data),
        "split": split,
        "date_from": pd.Timestamp(first).strftime("%Y-%m-%d") if first is not None else None,
        "date_to": pd.Timestamp(last).strftime("%Y-%m-%d") if last is not None else None,
        "params": {k: v for k, v in config.BACKTEST.items()
                   if k != "train_test_split"},
        "strategy_config": {k: {kk: vv for kk, vv in v.items() if kk != "enabled"}
                            for k, v in enabled.items()},
        "strategies": out_strats,
        "note": "Entry at next bar's open, stop assumed to fill at the stop "
                "price. Real fills on thin counters will be worse. Not advice.",
    }

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "backtest.json").write_text(json.dumps(report, separators=(",", ":")))
    size = (OUT / "backtest.json").stat().st_size
    print(f"wrote public/backtest.json ({size // 1024}KB)")

    if publish:
        from export_scan import publish_files
        publish_files(only=("backtest",))

    return report


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=300,
                    help="backtest the N most liquid stocks (0 = entire market, slow)")
    ap.add_argument("--publish", action="store_true")
    args = ap.parse_args()
    run(top=args.top, publish=args.publish)
