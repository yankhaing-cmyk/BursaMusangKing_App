import sys, unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'python'))
import pandas as pd
from bootstrap_strategy_state import replay_symbol

class BootstrapParityTest(unittest.TestCase):
    def frame(self):
        n=225
        idx=pd.date_range('2026-01-01',periods=n,freq='B')
        rows=[]
        for i in range(n):
            c=10.0 + max(0,i-220)*0.2
            rows.append({'open':c,'low':c-.05,'close':c,'atr':.2})
        return pd.DataFrame(rows,index=idx)

    def test_latest_signal_remains_pending_when_no_next_bar_exists(self):
        e=self.frame()
        def check(df,i,p): return i==len(df)-1
        state, events, trades=replay_symbol('TEST.KL','Test',e,'trending',{},check,{'stop_loss_pct':-7,'commission_pct':.1})
        self.assertEqual(state['status'],'BUY_PENDING')
        self.assertEqual(events[-1]['event_type'],'BUY_SIGNAL')
        self.assertEqual(trades,[])

    def test_historical_signal_enters_next_open(self):
        e=self.frame()
        sig=len(e)-3
        def check(df,i,p): return i==sig
        state, events, _=replay_symbol('TEST.KL','Test',e,'trending',{},check,{'stop_loss_pct':-7,'commission_pct':.1})
        entry=[x for x in events if x['event_type']=='ENTRY_CONFIRMED'][0]
        self.assertEqual(entry['trade_date'],str(e.index[sig+1])[:10])
        self.assertAlmostEqual(entry['price'],float(e.iloc[sig+1]['open']))

if __name__=='__main__':unittest.main()
