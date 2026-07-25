"""
Run one scan -> write JSON for the app -> optionally send Telegram.

Both outputs come from ONE scan, so the app and Telegram can never disagree
about what matched. Telegram is opt-in here (SEND_TELEGRAM=1) because your
original repo is probably already alerting you; turn it on only if you want
this pipeline to be the one that messages you.

  python export_scan.py                 # JSON only
  SEND_TELEGRAM=1 python export_scan.py # JSON + Telegram alert
  python export_scan.py --publish       # also POST the JSON to the Worker
"""

import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import requests

import upstream
import app_signal_log as slog

OUT = Path("public")
SPARK_BARS = 20   # bars shown in the tiny list thumbnail
DETAIL_BARS = 63  # ~3 months, matches upstream CHARTS["bars"]


def _ohlc(df: pd.DataFrame, bars: int) -> list[dict]:
    tail = df.tail(bars)
    out = []
    for ts, row in tail.iterrows():
        try:
            out.append({
                "t": pd.Timestamp(ts).strftime("%Y-%m-%d"),
                "o": round(float(row["open"]), 3),
                "h": round(float(row["high"]), 3),
                "l": round(float(row["low"]), 3),
                "c": round(float(row["close"]), 3),
                "v": int(row["volume"]) if pd.notna(row.get("volume")) else 0,
            })
        except Exception:
            continue
    return out


def _pct_change(df: pd.DataFrame) -> float:
    if len(df) < 2:
        return 0.0
    prev = float(df["close"].iloc[-2])
    last = float(df["close"].iloc[-1])
    if prev == 0:
        return 0.0
    return round((last / prev - 1) * 100, 2)


def _levels(df: pd.DataFrame, enrich) -> dict:
    """Entry / stop suggestion. Entry = EMA20 (pullback reference),
    stop = 1.5 ATR below last close. Purely informational, not advice."""
    try:
        e = enrich(df)
        row = e.iloc[-1]
        close = float(row["close"])
        ema20 = float(row["ema20"])
        atr = float(row["atr"]) if "atr" in e.columns and pd.notna(row.get("atr")) else close * 0.03
        return {
            "entry": round(min(close, ema20), 3),
            "stop": round(close - 1.5 * atr, 3),
            "ema20": round(ema20, 3),
        }
    except Exception:
        return {}


def run(publish: bool = False, send_telegram: bool | None = None) -> dict:
    eng = upstream.engine()
    config = eng["config"]
    screener = eng["screener"]
    indicators = eng["indicators"]
    data_fetcher = eng["data_fetcher"]

    if send_telegram is None:
        send_telegram = os.environ.get("SEND_TELEGRAM", "0") == "1"

    scope = (f"{config.MARKET_NAME} ({config.UNIVERSE_MODE})"
             if config.USE_FULL_MARKET else f"{len(config.WATCHLIST)}-stock watchlist")
    print(f"[{datetime.now():%Y-%m-%d %H:%M}] scanning {scope}")

    data = data_fetcher.fetch_market()
    screened = len(data)
    print(f"data OK for {screened} symbols, screening...")

    hits = screener.scan(data)
    hits = slog.mark_new(hits)
    n_logged, n_new = slog.append(hits)
    total = sum(len(v) for v in hits.values())
    print(f"{total} hits ({n_new} new), {n_logged} logged")

    now = datetime.now(timezone.utc)
    stocks, history = [], {}

    for strat, rows in hits.items():
        for r in rows:
            sym = r["symbol"]
            df = data.get(sym)
            if df is None or df.empty:
                continue
            rec = {
                "symbol": sym,
                "strategy": strat,
                "close": r["close"],
                "rsi": r["rsi"],
                "adx": r["adx"],
                "vol_ratio": r["vol_ratio"],
                "roc10": r["roc10"],
                "is_new": bool(r.get("is_new", False)),
                "change_pct": _pct_change(df),
                "spark": _ohlc(df, SPARK_BARS),
            }
            rec.update(_levels(df, indicators.enrich))
            stocks.append(rec)
            if sym not in history:
                history[sym] = _ohlc(df, DETAIL_BARS)

    latest = {
        "generated_at": now.isoformat(),
        "market": config.MARKET,
        "market_name": config.MARKET_NAME,
        "currency": config.CURRENCY,
        "stocks_screened": screened,
        "total_hits": total,
        "new_hits": n_new,
        "strategies": [s for s in config.STRATEGIES
                       if config.STRATEGIES[s].get("enabled", True)],
        "stocks": stocks,
    }

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "latest.json").write_text(json.dumps(latest, separators=(",", ":")))
    (OUT / "history.json").write_text(json.dumps(
        {"generated_at": now.isoformat(), "bars": DETAIL_BARS, "series": history},
        separators=(",", ":")))
    print(f"wrote public/latest.json ({len(stocks)} rows) "
          f"and public/history.json ({len(history)} symbols)")

    if send_telegram:
        tb = eng["telegram_bot"]
        scan_date = datetime.now().strftime("%d %b %Y %H:%M")
        ok = tb.send_scan_results(hits, scan_date, screened)
        print(f"telegram sent: {ok}")

    if publish:
        publish_files()

    return latest


def publish_files():
    """POST the JSON blobs to the Cloudflare Worker, which stores them in KV."""
    base = os.environ.get("WORKER_URL", "").rstrip("/")
    token = os.environ.get("PUBLISH_TOKEN", "")
    if not base or not token:
        print("publish skipped: WORKER_URL / PUBLISH_TOKEN not set")
        return
    for name in ("latest", "history", "weekly"):
        path = OUT / f"{name}.json"
        if not path.exists():
            continue
        r = requests.post(
            f"{base}/publish?key={name}",
            data=path.read_bytes(),
            headers={"Content-Type": "application/json",
                     "X-Publish-Token": token},
            timeout=60,
        )
        print(f"publish {name}: {r.status_code} {r.text[:120]}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--publish", action="store_true",
                    help="POST results to the Cloudflare Worker")
    ap.add_argument("--telegram", action="store_true",
                    help="force-send Telegram regardless of SEND_TELEGRAM")
    args = ap.parse_args()
    run(publish=args.publish, send_telegram=True if args.telegram else None)
