"""
Weekly review -> JSON for the app's Weekly tab (+ optional Telegram).

Same question upstream review.py asks: how does a FRESH signal actually
perform? Only is_new signals are evaluated, at +5/+10/+20 trading days, so a
stock that trends for three weeks doesn't get counted fifteen times and
flatter the stats.

  python export_review.py
  SEND_TELEGRAM=1 python export_review.py --publish
"""

import argparse
import json
import math
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

import upstream
import app_signal_log as slog

OUT = Path("public")
HORIZONS = [5, 10, 20]
LOOKBACK_WEEKS = 8


def forward_returns(sig_date, sig_close: float, df: pd.DataFrame) -> dict:
    # Anchor to the last bar at or BEFORE the signal date — that is the bar
    # whose close was recorded as sig_close. side="left" anchored to the next
    # bar at or after, which for a weekend-stamped signal jumped forward to the
    # following Monday: the horizon was measured from a different day than the
    # entry price, and two trading days were silently thrown away.
    idx = int(df.index.searchsorted(pd.Timestamp(sig_date), side="right")) - 1
    if idx < 0:
        # Signal predates every bar we hold — history too short, not pending.
        return {"_no_bar": True}

    matured = len(df) - 1 - idx          # bars available after the anchor
    out = {"_bars_since": int(matured)}
    for h in HORIZONS:
        j = idx + h
        if j < len(df):
            out[h] = (float(df["close"].iloc[j]) / sig_close - 1) * 100
    out["latest"] = (float(df["close"].iloc[-1]) / sig_close - 1) * 100
    if not any(h in out for h in HORIZONS):
        out["_pending"] = True
    return out


def _profit_factor(returns: list[float]) -> float | None:
    gains = sum(r for r in returns if r > 0)
    losses = -sum(r for r in returns if r < 0)
    # Strict JSON has no Infinity value. When there are gains but no losses,
    # the mathematical profit factor is infinite; publish null so the app can
    # display a dash rather than emitting invalid JSON.
    if losses == 0:
        return None
    return round(gains / losses, 2)


def run(publish: bool = False, send_telegram: bool | None = None) -> dict:
    eng = upstream.engine()
    config = eng["config"]
    data_fetcher = eng["data_fetcher"]

    if send_telegram is None:
        send_telegram = os.environ.get("SEND_TELEGRAM", "0") == "1"

    log = slog.load_log()
    now = datetime.now(timezone.utc)
    empty = {
        "generated_at": now.isoformat(),
        "lookback_weeks": LOOKBACK_WEEKS,
        "horizons": HORIZONS,
        "strategies": [],
        "overall": {},
        "equity_curve": [],
        "note": "Not enough signal history yet — needs a few more scan days.",
    }

    if log.empty:
        empty["note"] = (f"No signals logged yet in {slog.LOG_FILE}. The daily "
                         "scan writes this file and commits it back to the repo.")
        _write(empty, publish)
        print(f"no signals logged yet (looked for {slog.LOG_FILE})")
        return empty

    # Diagnostics first — an empty review is almost always one of these three,
    # and without them you cannot tell which.
    total = len(log)
    n_new_all = int(log["is_new"].sum())
    print(f"log: {total} rows, {n_new_all} flagged new, "
          f"dates {log['date'].min().date()} to {log['date'].max().date()}")

    cutoff = pd.Timestamp(datetime.now().date()) - timedelta(weeks=LOOKBACK_WEEKS)
    log = log[(log["date"] >= cutoff) & log["is_new"].astype(bool)]
    if log.empty:
        empty["note"] = (
            f"{total} signals logged, but none are both flagged NEW and inside "
            f"the {LOOKBACK_WEEKS}-week window. A repeat of a signal that "
            "already fired in the last 7 days is not counted again.")
        _write(empty, publish)
        print(f"nothing to review: {total} rows, {n_new_all} new, "
              f"cutoff {cutoff.date()}")
        return empty

    symbols = sorted(log["symbol"].unique())
    print(f"reviewing {len(log)} new signals across {len(symbols)} symbols...")
    data = data_fetcher.fetch_many(symbols,
                                   max_workers=config.UNIVERSE["max_workers"])

    # Without this, a failed price fetch produces an empty review that looks
    # identical to "no signals yet" — the loop below just skips every row.
    got = sum(1 for v in data.values() if v is not None and not v.empty)
    print(f"price history OK for {got}/{len(symbols)} symbols")
    if got == 0:
        empty["note"] = (f"{len(log)} signals to review, but price history came "
                         "back empty for every symbol. The data source likely "
                         "failed on this run — check the log and re-run.")
        _write(empty, publish)
        print("aborting: no price data returned")
        return empty

    per_strategy, all_r10, trade_rows = [], [], []
    signal_rows = []        # the per-signal list the Weekly tab renders
    pending = missing = 0   # too recent to score / no price history

    # Company names come from the cached universe pull, same source the scan
    # uses, so this costs nothing extra on a run.
    try:
        from export_scan import _company_names
        names = _company_names(upstream)
    except Exception as exc:
        print(f"company names unavailable ({exc})")
        names = {}

    for strat in sorted(log["strategy"].unique()):
        s = log[log["strategy"] == strat]
        buckets = {h: [] for h in HORIZONS}
        open_rets, evaluated = [], 0
        best = {"symbol": None, "ret": None}
        worst = {"symbol": None, "ret": None}

        for _, row in s.iterrows():
            df = data.get(row["symbol"])
            if df is None or df.empty:
                missing += 1
                continue
            fr = forward_returns(row["date"], float(row["close"]), df)
            sym = row["symbol"]
            rec = {
                "s": sym,
                "n": names.get(sym, ""),
                "st": strat,
                "d": pd.Timestamp(row["date"]).strftime("%Y-%m-%d"),
                "px": round(float(row["close"]), 3),
            }
            if fr.get("_no_bar"):
                missing += 1
                continue

            # How many bars have elapsed — lets the app say "3/5 days" instead
            # of a bare dash, so a young signal is visibly distinct from a
            # broken one.
            rec["bars"] = fr.get("_bars_since")
            rec["latest"] = round(fr["latest"], 2)
            for h in HORIZONS:
                rec[f"r{h}"] = round(fr[h], 2) if h in fr else None
            rec["p"] = all(rec.get(f"r{h}") is None for h in HORIZONS)
            signal_rows.append(rec)

            if rec["p"]:
                pending += 1
                open_rets.append(fr["latest"])
                continue

            evaluated += 1
            for h in HORIZONS:
                if h in fr:
                    buckets[h].append(fr[h])

            # Only a genuinely matured +10d return may enter the headline
            # stats. Falling back to the open return here was making 1-4 day
            # moves show up as "+10d" win rates, best and worst.
            if 10 not in fr:
                continue
            r10 = fr[10]
            all_r10.append(r10)
            trade_rows.append({"date": pd.Timestamp(row["date"]).strftime("%Y-%m-%d"),
                               "ret": r10})
            if best["ret"] is None or r10 > best["ret"]:
                best = {"symbol": row["symbol"], "ret": round(r10, 1)}
            if worst["ret"] is None or r10 < worst["ret"]:
                worst = {"symbol": row["symbol"], "ret": round(r10, 1)}

        if evaluated == 0:
            continue

        horizons = {}
        for h in HORIZONS:
            if buckets[h]:
                arr = pd.Series(buckets[h])
                horizons[str(h)] = {
                    "n": int(len(arr)),
                    "win_rate": round(100 * float((arr > 0).mean()), 1),
                    "avg": round(float(arr.mean()), 2),
                    "median": round(float(arr.median()), 2),
                    "profit_factor": _profit_factor(list(arr)),
                }

        per_strategy.append({
            "strategy": strat,
            "signals": evaluated,
            "horizons": horizons,
            "open": {"n": len(open_rets),
                     "avg": round(float(pd.Series(open_rets).mean()), 2)} if open_rets else None,
            "best": best,
            "worst": worst,
        })

    overall = {}
    if all_r10:
        arr = pd.Series(all_r10)
        overall = {
            "trades": int(len(arr)),
            "win_rate": round(100 * float((arr > 0).mean()), 1),
            "avg": round(float(arr.mean()), 2),
            "profit_factor": _profit_factor(list(arr)),
            "worst": round(float(arr.min()), 2),
            "best": round(float(arr.max()), 2),
        }

    # cumulative average return by signal date — the Weekly tab's curve
    equity = []
    if trade_rows:
        td = pd.DataFrame(trade_rows).sort_values("date")
        running = 100.0
        for d, grp in td.groupby("date"):
            running *= (1 + float(grp["ret"].mean()) / 100 / len(HORIZONS))
            equity.append({"date": d, "value": round(running, 2)})

    if not per_strategy:
        empty["signals"] = sorted(signal_rows, key=lambda r: r["d"], reverse=True)[:400]
        empty["pending"] = pending
        if pending:
            empty["note"] = (
                f"{pending} signals are logged but none are old enough to "
                "score yet. Results appear about 5 trading days after a signal "
                "fires, so this fills in over the coming weeks.")
        elif missing:
            empty["note"] = (f"{missing} signals had no usable price history "
                             "on this run.")
        _write(empty, publish)
        print(f"nothing evaluated yet: {pending} pending, {missing} missing history")
        return empty

    report = {
        "generated_at": now.isoformat(),
        "market": config.MARKET,
        "lookback_weeks": LOOKBACK_WEEKS,
        "horizons": HORIZONS,
        "strategies": per_strategy,
        "overall": overall,
        "equity_curve": equity,
        "pending": pending,
        "signals": sorted(signal_rows, key=lambda r: r["d"], reverse=True)[:400],
        "note": "Live signal performance. Past results do not predict future "
                "results — this is information, not financial advice.",
    }

    _write(report, publish)

    if send_telegram and per_strategy:
        _send_telegram(eng, report)

    print(f"weekly review: {overall.get('trades', 0)} evaluated trades, "
          f"{pending} still pending")
    return report


def _clean_json(o):
    """Recursively convert report values to strict JSON-safe primitives.

    Python's json module accepts/emits NaN and Infinity by default, but the
    Cloudflare Worker validates with JavaScript JSON.parse(), which rejects
    those non-standard constants. Convert every non-finite number to null.
    """
    if hasattr(o, "item"):
        return _clean_json(o.item())
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, dict):
        return {str(k): _clean_json(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean_json(v) for v in o]
    return o


def _jsonable(o):
    """Last-resort coercion for uncommon scalar objects."""
    if hasattr(o, "item"):
        return _clean_json(o.item())
    raise TypeError(f"{type(o).__name__} is not JSON serializable")


def _write(report: dict, publish: bool):
    OUT.mkdir(parents=True, exist_ok=True)
    clean = _clean_json(report)
    payload = json.dumps(
        clean, separators=(",", ":"), default=_jsonable, allow_nan=False
    )
    # Strict local validation before publishing. parse_constant raises if a
    # non-standard NaN/Infinity token somehow appears despite allow_nan=False.
    json.loads(
        payload,
        parse_constant=lambda x: (_ for _ in ()).throw(
            ValueError(f"non-standard JSON constant: {x}")
        ),
    )
    (OUT / "weekly.json").write_text(payload)
    print("wrote public/weekly.json")
    if publish:
        from export_scan import publish_files
        publish_files(only=("weekly",))

def _send_telegram(eng, report: dict):
    tb = eng["telegram_bot"]
    labels = getattr(tb, "STRATEGY_LABELS", {})
    lines = [f"<b>Weekly signal review — {datetime.now():%d %b %Y}</b>",
             f"<i>New signals, last {LOOKBACK_WEEKS} weeks</i>", ""]
    o = report.get("overall") or {}
    if o:
        lines.append(f"Overall: {o['win_rate']}% win | avg {o['avg']:+.1f}% "
                     f"| PF {o['profit_factor']} | n={o['trades']}")
        lines.append("")
    for s in report["strategies"]:
        label = labels.get(s["strategy"], s["strategy"]).split("(")[0].strip()
        lines.append(f"<b>{label}</b> — {s['signals']} new signals")
        for h in HORIZONS:
            hh = s["horizons"].get(str(h))
            if hh:
                lines.append(f"  +{h}d: {hh['win_rate']}% win | "
                             f"avg {hh['avg']:+.1f}% (n={hh['n']})")
        if s["best"]["ret"] is not None and s["worst"]["ret"] is not None:
            lines.append(f"  best {s['best']['symbol']} {s['best']['ret']:+.1f}% | "
                         f"worst {s['worst']['symbol']} {s['worst']['ret']:+.1f}%")
        else:
            lines.append("  best/worst pending — no +10d return has matured yet")
        lines.append("")
    msg = "\n".join(lines)
    while msg:
        chunk, msg = msg[:4000], msg[4000:]
        tb.send_message(chunk)
    print("telegram review sent")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--publish", action="store_true")
    ap.add_argument("--telegram", action="store_true")
    args = ap.parse_args()
    run(publish=args.publish, send_telegram=True if args.telegram else None)
