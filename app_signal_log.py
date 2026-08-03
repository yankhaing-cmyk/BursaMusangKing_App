"""
This project's OWN signal history.

Deliberately a separate file from the upstream repo's signals_myx.csv so the
two pipelines never fight over the same CSV or each other's git commits. Same
idea and same is_new semantics as upstream signal_log.py: a (symbol, strategy)
pair that already fired within NEW_WINDOW_DAYS is a repeat, not a new signal.

Committed back to THIS repo by the workflow, so history accrues run over run.
"""

import os
from datetime import datetime, timedelta

import pandas as pd

MARKET = os.environ.get("MARKET", "MYX").upper()
LOG_FILE = f"app_signals_{MARKET.lower()}.csv"
NEW_WINDOW_DAYS = 7

COLUMNS = ["date", "symbol", "strategy", "close", "rsi", "adx",
           "vol_ratio", "roc10", "is_new"]


def last_trading_day(d: datetime | None = None) -> pd.Timestamp:
    """Snap a run date back to the trading day whose close the scan just read.

    A weekend "Run scan now" tap reads Friday's close but used to stamp the row
    Saturday. The review then measured the horizon from the wrong bar and threw
    away two trading days. Bursa holidays still slip through — harmless, since
    the review now anchors to the last bar at or before this date.
    """
    ts = pd.Timestamp((d or datetime.now()).date())
    while ts.weekday() >= 5:            # 5 = Sat, 6 = Sun
        ts -= timedelta(days=1)
    return ts


def load_log() -> pd.DataFrame:
    if os.path.exists(LOG_FILE):
        df = pd.read_csv(LOG_FILE)
        if df.empty:
            return pd.DataFrame(columns=COLUMNS)
        df["date"] = pd.to_datetime(df["date"])
        return df
    return pd.DataFrame(columns=COLUMNS)


def mark_new(hits: dict, now: datetime | None = None) -> dict:
    """Annotate each hit with is_new, using log state BEFORE today's append."""
    now = now or datetime.now()
    log = load_log()
    today = last_trading_day(now)
    cutoff = today - timedelta(days=NEW_WINDOW_DAYS)
    if log.empty:
        recent_pairs = set()
    else:
        recent = log[(log["date"] >= cutoff) & (log["date"] < today)]
        recent_pairs = set(zip(recent["symbol"], recent["strategy"]))

    for strat, rows in hits.items():
        for r in rows:
            r["is_new"] = (r["symbol"], strat) not in recent_pairs
    return hits


def append(hits: dict, now: datetime | None = None) -> tuple[int, int]:
    """Append today's hits. Returns (n_logged, n_new). Idempotent per day."""
    now = now or datetime.now()
    scan_date = last_trading_day(now)
    log = load_log()

    if log.empty:
        today_pairs = set()
    else:
        today = log[log["date"] == scan_date]
        today_pairs = set(zip(today["symbol"], today["strategy"]))

    rows, n_new = [], 0
    for strat, items in hits.items():
        for r in items:
            key = (r["symbol"], strat)
            if key in today_pairs:
                continue
            is_new = bool(r.get("is_new", True))
            n_new += int(is_new)
            rows.append({
                "date": scan_date, "symbol": r["symbol"], "strategy": strat,
                "close": r["close"], "rsi": r["rsi"], "adx": r["adx"],
                "vol_ratio": r["vol_ratio"], "roc10": r["roc10"],
                "is_new": is_new,
            })
            today_pairs.add(key)

    if rows:
        log = pd.concat([log, pd.DataFrame(rows)], ignore_index=True)
        log.to_csv(LOG_FILE, index=False)

    return len(rows), n_new
