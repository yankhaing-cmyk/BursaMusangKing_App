"""
Loads the ORIGINAL BursaMusangKing repo as a read-only engine.

Nothing here writes to, forks, or modifies the upstream repo. It is cloned
shallow into a temp dir at runtime and put on sys.path, so this project always
screens with EXACTLY the same rules as your live Telegram screener. Tune
config.py upstream and this app follows automatically — no drift, no
duplicated strategy code to keep in sync.

Env vars:
  UPSTREAM_REPO  default yankhaing-cmyk/BursaMusangKing
  UPSTREAM_REF   default main
  UPSTREAM_DIR   default ./_upstream (reused if already present)
"""

import os
import subprocess
import sys
from pathlib import Path

REPO = os.environ.get("UPSTREAM_REPO", "yankhaing-cmyk/BursaMusangKing")
REF = os.environ.get("UPSTREAM_REF", "main")
DIR = Path(os.environ.get("UPSTREAM_DIR", "_upstream")).resolve()

_loaded = False


def ensure() -> Path:
    """Clone (or reuse) the upstream repo and put it on sys.path."""
    global _loaded
    if _loaded:
        return DIR

    if not (DIR / "screener.py").exists():
        DIR.parent.mkdir(parents=True, exist_ok=True)
        url = f"https://github.com/{REPO}.git"
        print(f"[upstream] cloning {REPO}@{REF} -> {DIR}")
        subprocess.run(
            ["git", "clone", "--depth", "1", "--branch", REF, url, str(DIR)],
            check=True,
            capture_output=True,
        )
    else:
        print(f"[upstream] reusing existing clone at {DIR}")

    if str(DIR) not in sys.path:
        # append, not insert(0): local modules of THIS repo win on name clash
        sys.path.append(str(DIR))

    _loaded = True
    return DIR


def engine():
    """Import and hand back the upstream modules we rely on."""
    ensure()
    import config
    import data_fetcher
    import indicators
    import screener
    import telegram_bot

    return {
        "config": config,
        "data_fetcher": data_fetcher,
        "indicators": indicators,
        "screener": screener,
        "telegram_bot": telegram_bot,
    }
