"""
Run one scan -> write JSON for the app -> optionally send Telegram.

Both outputs come from ONE scan, so the app and Telegram can never disagree
about what matched. Telegram is opt-in here (SEND_TELEGRAM=1) because your
original repo is probably already alerting you; turn it on only if you want
this pipeline to be the one that messages you.

  python export_scan.py                 # JSON only
  SEND_TELEGRAM=1 python export_scan.py # JSON + Telegram alert
  python export_scan.py --publish       # also POST the JSON to the Worker

NOTE: modified to use ranked_scan() instead of screener.scan() directly, so
strategy hit lists (and therefore the app's stock lists / Telegram alerts)
are sorted strongest-to-weakest by a composite ADX/RSI-band/vol_ratio score
instead of scan()'s default vol_ratio-only ordering. Nothing is dropped --
same hits, same dict shape, just reordered. Requires ranked_scan.py to exist
in the upstream BursaMusangKing repo (it's imported after the clone is on
sys.path).
"""

import argparse
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import requests

import upstream
import app_signal_log as slog

OUT = Path("public")
SPARK_BARS = 20   # bars shown in the tiny list thumbnail
DETAIL_BARS = 63  # ~3 months, matches upstream CHARTS["bars"]

# Must match export_backtest.py, or the app would show levels for a rule the
# backtest never tested — which is exactly the drift this replaced.
TRAIL_ATR_MULT = float(os.environ.get("TRAIL_ATR_MULT", "3.0"))


def _num(v, nd=3):
    """Round for JSON, mapping NaN/inf to null so the chart can break the line."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return round(f, nd)


def _series(e: pd.DataFrame, bars: int) -> dict:
    """Column arrays for the detail chart.

    EMAs and the volume average are computed by upstream's enrich() over the
    FULL downloaded history, then sliced to the display window — so EMA200 is
    a true 200-bar average, not a 63-bar one. Symbols with less than 200 bars
    of history get nulls, and the chart simply doesn't draw that line.
    """
    tail = e.tail(bars)
    out = {
        "t": [pd.Timestamp(i).strftime("%Y-%m-%d") for i in tail.index],
        "o": [_num(v) for v in tail["open"]],
        "h": [_num(v) for v in tail["high"]],
        "l": [_num(v) for v in tail["low"]],
        "c": [_num(v) for v in tail["close"]],
        "v": [int(v) if pd.notna(v) else 0 for v in tail["volume"]],
    }
    for col, key in (("ema20", "e20"), ("ema50", "e50"), ("ema200", "e200"),
                     ("vol_avg20", "vavg")):
        out[key] = ([_num(v) for v in tail[col]] if col in tail.columns
                    else [None] * len(tail))
    return out


def _spark(e: pd.DataFrame, bars: int) -> dict:
    """Minimal OHLC for the list thumbnail — no EMAs, no volume."""
    tail = e.tail(bars)
    return {
        "o": [_num(v) for v in tail["open"]],
        "h": [_num(v) for v in tail["high"]],
        "l": [_num(v) for v in tail["low"]],
        "c": [_num(v) for v in tail["close"]],
    }


def _pct_change(df: pd.DataFrame) -> float:
    if len(df) < 2:
        return 0.0
    prev = float(df["close"].iloc[-2])
    last = float(df["close"].iloc[-1])
    if prev == 0:
        return 0.0
    return round((last / prev - 1) * 100, 2)


def _levels(e: pd.DataFrame, stop_pct: float, mult: float) -> dict:
    """Entry and stop for the rule the backtest actually validates.

    These used to be their own invention — entry at EMA20 for a pullback, stop
    at 1.5 ATR — neither of which any backtest had ever tested. The numbers on
    screen now come from the same parameters the ATR replay uses, so what you
    see when you tap a stock is the rule whose results you can go and read.

    Entry is the next bar's open, matching the backtest, so the last close is
    shown only as a reference price.
    """
    try:
        row = e.iloc[-1]
        close = float(row["close"])
        atr = (float(row["atr"]) if "atr" in e.columns and pd.notna(row.get("atr"))
               else close * 0.03)
        if atr <= 0:
            atr = close * 0.03

        init_stop = close * (1 - stop_pct)      # the -7% floor
        trail_dist = mult * atr
        trail_stop = close - trail_dist
        # On day one the fixed stop is usually tighter; the trail takes over
        # only once it rises above. Show whichever is actually governing.
        active = max(init_stop, trail_stop)
        return {
            "entry": round(close, 3),
            "stop": round(active, 3),
            "stop_init": round(init_stop, 3),
            "trail_dist": round(trail_dist, 3),
            "atr": round(atr, 4),
            "stop_from": "trail" if trail_stop > init_stop else "initial",
            "stop_pct_now": round((active / close - 1) * 100, 1),
        }
    except Exception:
        return {}


def _company_names(upstream_mod) -> dict:
    """symbol -> company name, from the cached universe pull.

    get_universe() is cached to CSV per day, so on a scan run this is free —
    the universe was already fetched to build the candidate list.
    """
    try:
        upstream_mod.ensure()
        import universe
        uni = universe.get_universe()
        if "description" not in uni.columns:
            return {}
        return {str(r["symbol"]): str(r["description"])
                for _, r in uni.iterrows()
                if pd.notna(r.get("description"))}
    except Exception as exc:
        print(f"company names unavailable ({exc}) — falling back to tickers")
        return {}


def run(publish: bool = False, send_telegram: bool | None = None) -> dict:
    eng = upstream.engine()
    config = eng["config"]
    screener = eng["screener"]
    indicators = eng["indicators"]
    data_fetcher = eng["data_fetcher"]

    # ranked_scan.py lives in the upstream clone, so it's only importable
    # after upstream.engine() has put that directory on sys.path (engine()
    # calls ensure() internally, so this is safe here).
    from ranked_scan import ranked_scan

    if send_telegram is None:
        send_telegram = os.environ.get("SEND_TELEGRAM", "0") == "1"

    scope = (f"{config.MARKET_NAME} ({config.UNIVERSE_MODE})"
             if config.USE_FULL_MARKET else f"{len(config.WATCHLIST)}-stock watchlist")
    print(f"[{datetime.now():%Y-%m-%d %H:%M}] scanning {scope}")

    data = data_fetcher.fetch_market()
    screened = len(data)
    print(f"data OK for {screened} symbols, screening...")

    hits = ranked_scan(data)
    hits = slog.mark_new(hits)
    n_logged, n_new = slog.append(hits)
    total = sum(len(v) for v in hits.values())
    print(f"{total} hits ({n_new} new), {n_logged} logged")

    names = _company_names(upstream)
    stop_pct = abs(config.BACKTEST.get("stop_loss_pct", -7)) / 100
    now = datetime.now(timezone.utc)
    stocks, history = [], {}

    for strat, rows in hits.items():
        for r in rows:
            sym = r["symbol"]
            df = data.get(sym)
            if df is None or df.empty:
                continue

            # enrich once over full history, reuse for spark, series and levels
            try:
                e = indicators.enrich(df)
            except Exception:
                e = df

            rec = {
                "symbol": sym,
                "name": names.get(sym, ""),
                "strategy": strat,
                "close": r["close"],
                "rsi": r["rsi"],
                "adx": r["adx"],
                "vol_ratio": r["vol_ratio"],
                "roc10": r["roc10"],
                "is_new": bool(r.get("is_new", False)),
                "change_pct": _pct_change(df),
                "spark": _spark(e, SPARK_BARS),
            }
            rec.update(_levels(e, stop_pct, TRAIL_ATR_MULT))
            stocks.append(rec)
            if sym not in history:
                history[sym] = _series(e, DETAIL_BARS)

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
        "exit_rule": {
            "label": f"ATR trail {TRAIL_ATR_MULT:g}x",
            "mult": TRAIL_ATR_MULT,
            "stop_pct": round(stop_pct * 100, 1),
        },
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


def _verify_publish(base: str, name: str, expected: str | None):
    """Verify that the Worker is serving the same generated_at we just wrote.

    Workers KV can briefly serve an older value in another location after a
    write, so retry for up to three minutes before declaring the publish bad.
    """
    if name not in {"latest", "weekly", "backtest"} or not expected:
        return

    last = None
    for attempt in range(18):
        try:
            r = requests.get(
                f"{base}/status",
                headers={"Cache-Control": "no-cache"},
                timeout=30,
            )
            r.raise_for_status()
            last = r.json().get(name)
            print(
                f"verify {name} attempt {attempt + 1}: "
                f"expected={expected}, worker={last}"
            )
            if last == expected:
                print(f"publish {name}: VERIFIED")
                return
        except Exception as exc:
            print(f"verify {name} attempt {attempt + 1} failed: {exc}")
        time.sleep(10)

    raise RuntimeError(
        f"Publish verification failed for {name}: "
        f"expected={expected}, worker={last}"
    )


def publish_files(only: tuple[str, ...] | None = None):
    """POST JSON blobs to the Worker and fail on any publishing error."""
    base = os.environ.get("WORKER_URL", "").rstrip("/")
    token = os.environ.get("PUBLISH_TOKEN", "")

    if not base:
        raise RuntimeError("WORKER_URL is not configured")
    if not token:
        raise RuntimeError("PUBLISH_TOKEN is not configured")

    # Tolerate someone pasting a full route into the secret (e.g. .../status).
    for suffix in (
        "/status", "/latest", "/weekly", "/history", "/backtest", "/publish"
    ):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
            print(f"WORKER_URL had '{suffix}' on the end — using {base}")
            break

    keys = only or ("latest", "history", "weekly", "backtest")

    for name in keys:
        path = OUT / f"{name}.json"

        if not path.exists():
            if only and name in only:
                raise FileNotFoundError(
                    f"Expected publish file does not exist: {path}"
                )
            continue

        payload = path.read_bytes()

        try:
            local_json = json.loads(
                payload,
                parse_constant=lambda x: (_ for _ in ()).throw(
                    ValueError(f"non-standard JSON constant: {x}")
                ),
            )
        except Exception as exc:
            raise RuntimeError(
                f"{path} is not strict JSON (NaN/Infinity are not allowed): {exc}"
            ) from exc

        r = requests.post(
            f"{base}/publish?key={name}",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "X-Publish-Token": token,
            },
            timeout=120,
        )

        print(f"publish {name}: {r.status_code} {r.text[:300]}")
        r.raise_for_status()

        try:
            result = r.json()
        except ValueError as exc:
            raise RuntimeError(
                f"Worker returned invalid JSON for {name}: {r.text[:300]}"
            ) from exc

        if result.get("ok") is not True:
            raise RuntimeError(f"Worker rejected {name}: {result}")

        _verify_publish(base, name, local_json.get("generated_at"))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--publish", action="store_true",
                    help="POST results to the Cloudflare Worker")
    ap.add_argument("--telegram", action="store_true",
                    help="force-send Telegram regardless of SEND_TELEGRAM")
    args = ap.parse_args()
    run(publish=args.publish, send_telegram=True if args.telegram else None)