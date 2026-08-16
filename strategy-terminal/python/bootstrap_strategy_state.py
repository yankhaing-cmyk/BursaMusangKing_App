#!/usr/bin/env python3
"""One-time historical bootstrap for the Bursa ATR Strategy Terminal."""
import json, os
from datetime import datetime, timezone
import requests
import upstream

STRATEGIES=('trending','gaining_momentum','meta_leader')
ATR_MULT=float(os.environ.get('TRAIL_ATR_MULT','3.0'))
MIN_UNIVERSE=int(os.environ.get('MIN_UNIVERSE','900'))
NEAR_STOP_PCT=float(os.environ.get('NEAR_STOP_PCT','3.0'))

def f(v):
    try:
        x=float(v)
        return x if x==x and abs(x)!=float('inf') else None
    except Exception:return None

def replay_symbol(symbol,name,e,strategy,params,check,bt):
    cycle=0; status='FLAT'; signal_date=entry_date=closed_date=None
    entry=peak=stop=initial=None; hold=0; last_event=None
    events=[]; trades=[]
    commission=float(bt.get('commission_pct',0)); stop_pct=float(bt.get('stop_loss_pct',-7))
    pending_i=None
    for i in range(220,len(e)):
        date=str(e.index[i])[:10]; row=e.iloc[i]
        o,l,c,a=f(row.get('open')),f(row.get('low')),f(row.get('close')),f(row.get('atr'))
        if not all(x is not None and x>0 for x in (o,l,c,a)): continue
        if status=='BUY_PENDING':
            if pending_i is not None and i>pending_i:
                entry_date=date; entry=o; peak=c; initial=entry*(1+stop_pct/100); stop=initial; hold=0; status='OPEN'; last_event='ENTRY_CONFIRMED'
                events.append({'trade_date':date,'strategy':strategy,'symbol':symbol,'name':name,'event_type':'ENTRY_CONFIRMED','price':entry,'atr_stop':stop,'entry_price':entry,'return_pct':None,'cycle':cycle,'message':'Historical bootstrap: next-session entry confirmed.'})
                if l<=stop:
                    exit_price=stop; ret=(exit_price/entry-1)*100-2*commission; closed_date=date; status='CLOSED'; last_event='SELL'
                    events.append({'trade_date':date,'strategy':strategy,'symbol':symbol,'name':name,'event_type':'SELL','price':exit_price,'atr_stop':stop,'entry_price':entry,'return_pct':ret,'cycle':cycle,'message':'Historical bootstrap: ATR trailing stop exit.'})
                    trades.append({'strategy':strategy,'symbol':symbol,'name':name,'cycle':cycle,'signal_date':signal_date,'entry_date':entry_date,'entry_price':entry,'exit_date':date,'exit_price':exit_price,'return_pct':ret,'hold_days':hold,'exit_reason':'trail_stop'})
                else: stop=max(stop,peak-ATR_MULT*a)
                continue
        if status in ('OPEN','NEAR_SELL'):
            hold+=1
            if l<=stop:
                exit_price=stop; ret=(exit_price/entry-1)*100-2*commission; closed_date=date; status='CLOSED'; last_event='SELL'
                events.append({'trade_date':date,'strategy':strategy,'symbol':symbol,'name':name,'event_type':'SELL','price':exit_price,'atr_stop':stop,'entry_price':entry,'return_pct':ret,'cycle':cycle,'message':'Historical bootstrap: ATR trailing stop exit.'})
                trades.append({'strategy':strategy,'symbol':symbol,'name':name,'cycle':cycle,'signal_date':signal_date,'entry_date':entry_date,'entry_price':entry,'exit_date':date,'exit_price':exit_price,'return_pct':ret,'hold_days':hold,'exit_reason':'trail_stop'})
                continue
            peak=max(peak,c); stop=max(stop,peak-ATR_MULT*a); status='OPEN'; continue
        if status=='CLOSED': status='FLAT'
        if status=='FLAT':
            try: hit=bool(check(e,i,params))
            except Exception: hit=False
            if hit:
                cycle+=1; status='BUY_PENDING'; signal_date=date; pending_i=i; last_event='BUY_SIGNAL'
                events.append({'trade_date':date,'strategy':strategy,'symbol':symbol,'name':name,'event_type':'BUY_SIGNAL','price':c,'atr_stop':None,'entry_price':None,'return_pct':None,'cycle':cycle,'message':'Historical bootstrap: strategy signal; entry next session open.'})
    last=e.iloc[-1]; latest_close=f(last.get('close')); latest_atr=f(last.get('atr')); last_date=str(e.index[-1])[:10]
    if status=='OPEN' and latest_close and stop and stop>0:
        dist=(latest_close/stop-1)*100
        if dist<=NEAR_STOP_PCT:
            status='NEAR_SELL'; last_event='NEAR_SELL'
            events.append({'trade_date':last_date,'strategy':strategy,'symbol':symbol,'name':name,'event_type':'NEAR_SELL','price':latest_close,'atr_stop':stop,'entry_price':entry,'return_pct':None,'cycle':cycle,'message':f'Historical bootstrap: price is {dist:.1f}% above ATR stop.'})
    state={'strategy':strategy,'symbol':symbol,'name':name,'status':status,'signal_date':signal_date,'entry_date':entry_date,'entry_price':entry,'peak_close':peak,'atr_stop':stop,'initial_stop':initial,'latest_close':latest_close,'latest_atr':latest_atr,'last_trade_date':last_date,'last_event':last_event,'last_event_at':last_date,'closed_date':closed_date,'exit_price':trades[-1]['exit_price'] if trades else None,'return_pct':trades[-1]['return_pct'] if trades else None,'hold_days':hold,'cycle':cycle}
    return state,events,trades

def run(publish=True):
    eng=upstream.engine(); cfg=eng['config']; fetcher=eng['data_fetcher']; ind=eng['indicators']; scr=eng['screener']
    data=fetcher.fetch_market(); screened=len(data)
    if screened<MIN_UNIVERSE: raise RuntimeError(f'FAIL-CLOSED: bootstrap market coverage {screened} < {MIN_UNIVERSE}')
    dates=[str(df.index[-1])[:10] for df in data.values() if df is not None and len(df)]
    if not dates: raise RuntimeError('FAIL-CLOSED: no market dates')
    trade_date=max(dates)
    names={}
    try:
        upstream.ensure(); import universe
        u=universe.get_universe()
        if 'description' in u.columns:names={str(r['symbol']):str(r['description']) for _,r in u.iterrows() if r.get('description')==r.get('description')}
    except Exception as exc: print('name warning',exc)
    states=[]; events=[]; trades=[]; current=0; bad=0
    for symbol,raw in data.items():
        if raw is None or not len(raw) or str(raw.index[-1])[:10]!=trade_date: continue
        try:e=ind.enrich(raw)
        except Exception: bad+=1; continue
        if e is None or len(e)<221: bad+=1; continue
        current+=1
        for strategy in STRATEGIES:
            p=cfg.STRATEGIES.get(strategy); check=scr.CHECKS.get(strategy)
            if not p or not check: raise RuntimeError(f'Missing upstream strategy/check: {strategy}')
            s,ev,tr=replay_symbol(symbol,names.get(symbol,''),e,strategy,p,check,cfg.BACKTEST)
            states.append(s); events.extend(ev); trades.extend(tr)
    if current<MIN_UNIVERSE: raise RuntimeError(f'FAIL-CLOSED: only {current} current-date bootstrap symbols; bad={bad}')
    events=[x for x in events if x['trade_date']==trade_date]
    trades=[x for x in trades if x['exit_date']==trade_date]
    payload={'generated_at':datetime.now(timezone.utc).isoformat(),'trade_date':trade_date,'stocks_screened':screened,'states':states,'events':events,'trades':trades,'params':{'atr_mult':ATR_MULT,'stop_loss_pct':float(cfg.BACKTEST.get('stop_loss_pct',-7)),'commission_pct':float(cfg.BACKTEST.get('commission_pct',0))},'strategies':list(STRATEGIES)}
    print(f'bootstrap prepared: {current} stocks, {len(states)} states, {len(events)} recent events, {len(trades)} recent closed trades')
    if publish:
        base=os.environ['WORKER_URL'].rstrip('/'); token=os.environ['PUBLISH_TOKEN']
        r=requests.post(base+'/api/bootstrap?replace=1',json=payload,headers={'Authorization':'Bearer '+token},timeout=300); print(r.status_code,r.text[:800]); r.raise_for_status(); result=r.json()
        if not result.get('ok'): raise RuntimeError(result)
        h=requests.get(base+'/api/health',headers={'Cache-Control':'no-cache'},timeout=60); h.raise_for_status(); health=h.json()
        if not health.get('bootstrapped'): raise RuntimeError(f'bootstrap verification failed: {health}')
        print('BOOTSTRAP VERIFIED',json.dumps(health,separators=(',',':')))
    return payload

if __name__=='__main__': run()
