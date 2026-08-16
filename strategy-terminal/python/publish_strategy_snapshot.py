#!/usr/bin/env python3
"""Full Bursa daily snapshot for Trending/Momentum/M.E.T.A. ATR state tracking.
Uses the upstream BursaMusangKing rules directly; it does not duplicate entry logic.
"""
import json, os, sys
from datetime import datetime, timezone
import requests
import upstream

STRATEGIES=('trending','gaining_momentum','meta_leader')
ATR_MULT=float(os.environ.get('TRAIL_ATR_MULT','3.0'))
MIN_UNIVERSE=int(os.environ.get('MIN_UNIVERSE','900'))

def num(v):
    try:
        x=float(v); return x if x==x and abs(x)!=float('inf') else None
    except Exception:return None

def run(publish=True):
    eng=upstream.engine();cfg=eng['config'];fetcher=eng['data_fetcher'];ind=eng['indicators'];scr=eng['screener']
    data=fetcher.fetch_market(); screened=len(data)
    if screened<MIN_UNIVERSE: raise RuntimeError(f'FAIL-CLOSED: only {screened} market symbols returned; need >= {MIN_UNIVERSE}')
    names={}
    try:
        upstream.ensure();import universe
        u=universe.get_universe()
        if 'description' in u.columns:names={str(r['symbol']):str(r['description']) for _,r in u.iterrows() if r.get('description')==r.get('description')}
    except Exception as exc: print('name lookup warning:',exc)
    dated=[str(raw.index[-1])[:10] for raw in data.values() if raw is not None and len(raw)]
    if not dated: raise RuntimeError('FAIL-CLOSED: market feed returned no dated bars')
    latest_date=max(dated)
    rows=[]; bad=0; stale=0
    for symbol,raw in data.items():
        try:
            if raw is None or not len(raw) or str(raw.index[-1])[:10] != latest_date:
                stale+=1; continue
            e=ind.enrich(raw)
            if e is None or len(e)<220: bad+=1; continue
            i=len(e)-1; row=e.iloc[i]
            o,l,c,a=num(row.get('open')),num(row.get('low')),num(row.get('close')),num(row.get('atr'))
            if not all(x is not None and x>0 for x in (o,l,c,a)): bad+=1; continue
            hits={}
            for strategy in STRATEGIES:
                p=cfg.STRATEGIES.get(strategy)
                check=scr.CHECKS.get(strategy)
                try:hits[strategy]=bool(p and check and check(e,i,p))
                except Exception:hits[strategy]=False
            rows.append({'symbol':symbol,'name':names.get(symbol,''),'open':round(o,4),'low':round(l,4),'close':round(c,4),'atr':round(a,5),'hits':hits})
        except Exception: bad+=1
    if len(rows)<MIN_UNIVERSE: raise RuntimeError(f'FAIL-CLOSED: only {len(rows)} current-date valid rows; bad={bad} stale={stale}; need >= {MIN_UNIVERSE}')
    bt=cfg.BACKTEST
    payload={'generated_at':datetime.now(timezone.utc).isoformat(),'trade_date':latest_date,'stocks_screened':screened,'rows':rows,'params':{'atr_mult':ATR_MULT,'stop_loss_pct':float(bt.get('stop_loss_pct',-7)),'commission_pct':float(bt.get('commission_pct',0))},'strategies':list(STRATEGIES)}
    with open('strategy_snapshot.json','w') as f:json.dump(payload,f,separators=(',',':'))
    print(f'prepared {len(rows)}/{screened} rows date={latest_date} bad={bad} stale={stale}')
    if publish:
        base=os.environ['WORKER_URL'].rstrip('/'); token=os.environ['PUBLISH_TOKEN']
        r=requests.post(base+'/api/publish',json=payload,headers={'Authorization':'Bearer '+token},timeout=180)
        print('publish',r.status_code,r.text[:500]);r.raise_for_status();res=r.json()
        if not res.get('ok'):raise RuntimeError(res)
        h=requests.get(base+'/api/health',headers={'Cache-Control':'no-cache'},timeout=60);h.raise_for_status();health=h.json()
        if health.get('last_run',{}).get('trade_date')!=latest_date:raise RuntimeError(f'publish verification mismatch: {health}')
        print('VERIFIED',json.dumps(health,separators=(',',':')))
    return payload

if __name__=='__main__':run('--no-publish' not in sys.argv)
