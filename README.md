# BursaMusangKing — app

A phone app front end for the
[BursaMusangKing](https://github.com/yankhaing-cmyk/BursaMusangKing) screener.
Browse matches with inline candlestick charts, tap through to a 3-month chart,
see how signals actually performed, and trigger a fresh scan from your phone.

**Your original repo is never modified.** This project clones it read-only at
runtime and calls its `screener.scan()`, so both pipelines screen with the
identical rules from the same `config.py`. Tune a parameter upstream and this
app follows on the next run — nothing to keep in sync by hand.

```
GitHub Actions ──► clones upstream engine ──► scan ──► latest.json / weekly.json
                                              │                    │
                                              ├──► Telegram        ▼
                                              │            Cloudflare Worker (KV)
                                              │                    │
       app "Run scan now" ──► Worker ──► workflow_dispatch    PWA reads /latest
```

Telegram and the app are two consumers of the same scan — neither replaces the
other, and one scan feeds both.

---

## Try it first, deploy later

The app ships with sample data so you can see it working before setting
anything up:

```bash
cd app
python3 -m http.server 8899
```

Open `http://localhost:8899` (or your machine's LAN IP on your phone). It runs
in demo mode until you fill in `WORKER_URL`.

---

## Files

```
upstream.py            clones the original repo, puts its engine on sys.path
app_signal_log.py      this project's own signal history (separate CSV)
export_scan.py         scan -> public/latest.json + history.json (+ Telegram)
export_review.py       signal performance -> public/weekly.json (+ Telegram)
app/                   the PWA (static — deploy anywhere)
  index.html           shell, styles, light/dark theming
  app.js               list, detail chart, weekly tab, run-scan polling
  config.js            ← the one file you edit: your Worker URL
  demo/                sample JSON so the app works before deployment
worker/worker.js       serves JSON to the app, relays "Run scan now"
worker/wrangler.toml   only needed for the Wrangler CLI — ignore if using the
                       Cloudflare dashboard (setup below uses the dashboard)
.github/workflows/
  app-scan.yml         weekday scan + on-demand dispatch
  app-review.yml       weekly signal review
```

---

## Setup

Everything below is on free tiers.

### 1. Create the repo

Push this folder to a **new** GitHub repo, e.g. `BursaMusangKing-app`. Don't
push it into your existing repo — keeping them separate is what guarantees the
original keeps working untouched.

### 2. Cloudflare Worker (dashboard — no CLI needed)

Sign up at [cloudflare.com](https://cloudflare.com) if you haven't; the free
plan covers all of this.

**2a. Create the KV namespace**

Dashboard → **Storage & Databases** → **KV** → *Create a namespace*.
Name it `SCANS` and create it. This is where scan results are stored.

**2b. Create the Worker**

**Compute (Workers)** → *Create* → *Start from Hello World* → name it
`bursamusangking-app` → Deploy.

Then **Edit code**, select everything in the editor, delete it, and paste in
the full contents of `worker/worker.js` from this repo. Deploy again.

**2c. Bind the KV namespace**

Worker → **Settings** → **Bindings** → *Add* → **KV namespace**:

- Variable name: `SCANS` (must be exactly this — the code looks for `env.SCANS`)
- KV namespace: the `SCANS` you created in 2a

**2d. Add variables and secrets**

Same **Bindings** page, add each of these. Tick **Encrypt** on the bottom three
so they're stored as secrets and never shown again.

| Name | Encrypt? | Value |
|---|---|---|
| `GITHUB_REPO` | no | `yourname/BursaMusangKing-app` |
| `WORKFLOW_FILE` | no | `app-scan.yml` |
| `GITHUB_REF` | no | `main` |
| `ALLOWED_ORIGIN` | no | `*` for now — tighten in step 5 |
| `GITHUB_TOKEN` | **yes** | from step 3 below |
| `PUBLISH_TOKEN` | **yes** | invent any long random string, save a copy |
| `RUN_TOKEN` | **yes** | optional — skip unless you want it |

`PUBLISH_TOKEN` is just a shared password proving the GitHub Action is allowed
to write results. Make one up (a password manager's generator is ideal) and
keep it handy — you'll paste the identical value into GitHub in step 4.

**2e. Note your Worker URL**

Shown on the Worker's overview page:
`https://bursamusangking-app.<your-subdomain>.workers.dev`

Redeploy after any binding change, then open your URL + `/status` in a browser.
`{"latest":null,"weekly":null}` means it's working — no data published yet.

*(`worker/wrangler.toml` is only for the Wrangler CLI. On this path you can
ignore it entirely.)*

### 3. GitHub token for the Worker

GitHub → Settings → Developer settings → **Fine-grained personal access
tokens** → *Generate new token*:

- **Repository access** → Only select repositories → your new app repo
- **Permissions** → Repository permissions → **Actions: Read and write**
- Set an expiry you'll remember; the run button stops working when it lapses

Copy the token (shown once) into the Worker's `GITHUB_TOKEN` variable in 2d.

It can only start a workflow in the app repo — it has no access to your
original repo.

### 4. Repo secrets

In the **app** repo: Settings → Secrets and variables → Actions.

Secrets:

| Name | Value |
|---|---|
| `WORKER_URL` | your Worker URL from step 2 |
| `PUBLISH_TOKEN` | the same string you gave the Worker |
| `TELEGRAM_BOT_TOKEN` | only if you want this pipeline to alert too |
| `TELEGRAM_CHAT_ID` | same |

Variables (optional):

| Name | Default | Notes |
|---|---|---|
| `SEND_TELEGRAM` | `0` | set to `1` to alert from this pipeline |
| `MARKET` | `MYX` | `HKEX` also works — upstream supports both |
| `UPSTREAM_REPO` | `yankhaing-cmyk/BursaMusangKing` | change if you rename |

**On duplicate alerts:** leave `SEND_TELEGRAM` at `0` while your original
repo's `daily-screener.yml` is still running, or you'll get every alert twice.
If you'd rather this repo be the one that messages you, set it to `1` and
disable the schedule in the original workflow — that's a change in the original
repo, so only do it when you're ready.

### 5. Deploy the app

Cloudflare Pages → Create project → connect the repo:

- Build command: *(leave empty)*
- Build output directory: `app`

Then edit `app/config.js`, set `WORKER_URL` to your Worker URL, and push. Open
the Pages URL on your phone → browser menu → **Add to Home Screen**.

Once it's working, go back to the Worker's Bindings page and change
`ALLOWED_ORIGIN` from `*` to your Pages URL, then redeploy the Worker. That
stops other sites from reading your scan data.

### 6. First run

Actions tab → **App Scan** → Run workflow. Two or three minutes later the app
should show results. If it doesn't, open the Worker URL + `/status` in a
browser — it returns the timestamps of what's stored.

---

## How "Run scan now" works

Tap it and the app POSTs to the Worker, which fires `workflow_dispatch` on
`app-scan.yml`. GitHub runs the scan, publishes fresh JSON to the Worker, and
the app polls `/status` every 10 seconds until the timestamp changes, then
reloads. All four strategies come from that one scan, so the whole app —
list, charts, weekly stats — updates together.

A full-market scan takes several minutes because `use_prefilter` is `False`
upstream, meaning it downloads history for every listed stock rather than
short-listing first. The app keeps polling for 7 minutes and then tells you to
check back; the scan itself keeps running regardless.

**On `RUN_TOKEN`:** anything in `config.js` ships to the browser, so a token
there is a speed bump, not a secret. It stops casual triggering by someone who
finds the URL; it won't stop someone who reads the page source. The real
protection is that the Worker only ever dispatches one specific workflow.

---

## Worker API

| Route | Purpose |
|---|---|
| `GET /latest` | newest scan results |
| `GET /history` | 3-month OHLC for all matched symbols |
| `GET /history?symbol=MAYBANK` | one symbol |
| `GET /weekly` | signal performance stats |
| `GET /status` | timestamps, for polling |
| `POST /run` | queue a scan |
| `POST /publish?key=latest` | CI writes results (token-gated) |

---

## Weekly review

`export_review.py` mirrors upstream's `review.py`: it evaluates only **new**
signals at +5/+10/+20 trading days, so a stock that trends for three weeks
isn't counted fifteen times and flattering the win rate. It reads
`app_signals_myx.csv`, which the scan workflow commits back to this repo — so
the Weekly tab stays empty for the first several days until enough signal
history accumulates. That's expected, not a bug.

The equity curve is a cumulative average of signal returns, not a tradeable
backtest — it ignores position sizing, slippage, and whether you could actually
have filled at those prices on thin counters. Treat it as a read on whether the
criteria are working, and use `backtest.py` in the original repo for anything
you'd risk money on.

---

## Costs

Free: Cloudflare Workers (100k requests/day), Workers KV (100k reads,
1k writes/day — a scan uses 3), Pages, and GitHub Actions on a public repo.
The scan does two data pulls a day rather than one, since this pipeline runs
independently of your original — still well within limits.

Not financial advice.
