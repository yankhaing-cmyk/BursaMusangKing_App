import test from 'node:test';import assert from 'node:assert/strict';import {processState} from '../src/engine.js';
const row=(d,{o=10,l=9.8,c=10,a=.5,hit=false}={})=>({trade_date:d,symbol:'TEST.KL',name:'Test',open:o,low:l,close:c,atr:a,hits:{trending:hit}});
test('flat hit becomes BUY_PENDING, not imaginary same-day entry',()=>{const x=processState(null,row('2026-08-10',{hit:true}),'trending',{stopLossPct:-7,atrMult:3});assert.equal(x.state.status,'BUY_PENDING');assert.equal(x.events[0].event_type,'BUY_SIGNAL');assert.equal(x.state.entry_price,undefined)});
test('pending enters next session open',()=>{let x=processState(null,row('2026-08-10',{hit:true}),'trending',{stopLossPct:-7,atrMult:3});x=processState(x.state,row('2026-08-11',{o:10.2,l:10,c:10.4,a:.4}),'trending',{stopLossPct:-7,atrMult:3});assert.equal(x.state.entry_price,10.2);assert.equal(x.state.status,'OPEN');assert.equal(x.events[0].event_type,'ENTRY_CONFIRMED')});
test('stop is checked before peak ratchet',()=>{let s={strategy:'trending',symbol:'TEST.KL',status:'OPEN',entry_price:10,peak_close:11,atr_stop:10.5,hold_days:4,cycle:1,entry_date:'2026-08-01'};const x=processState(s,row('2026-08-12',{o:11,l:10.4,c:12,a:.2}),'trending',{commissionPct:.1,atrMult:3});assert.equal(x.state.status,'CLOSED');assert.equal(x.state.exit_price,10.5);assert.equal(x.events[0].event_type,'SELL')});
test('ATR stop only ratchets upward',()=>{let s={strategy:'trending',symbol:'TEST.KL',status:'OPEN',entry_price:10,peak_close:11,atr_stop:10.4,hold_days:4,cycle:1,entry_date:'2026-08-01'};let x=processState(s,row('2026-08-12',{o:11,l:10.8,c:11.5,a:.2}),'trending',{atrMult:3});assert.equal(Number(x.state.atr_stop.toFixed(2)),10.9);x=processState(x.state,row('2026-08-13',{o:11.4,l:11,c:11.2,a:.5}),'trending',{atrMult:3});assert.equal(Number(x.state.atr_stop.toFixed(2)),10.9)});

test('full Bursa-sized snapshot processes 1100 stocks across 3 strategies without state loss',()=>{
  const strategies=['trending','gaining_momentum','meta_leader'];
  const maps=new Map(strategies.map(s=>[s,new Map()]));
  for(let i=0;i<1100;i++){
    const symbol=String(i).padStart(4,'0')+'.KL';
    const r={trade_date:'2026-08-16',symbol,name:'Stock '+i,open:1+i/1000,low:.99+i/1000,close:1.01+i/1000,atr:.03,hits:{trending:i%10===0,gaining_momentum:i%17===0,meta_leader:i%29===0}};
    for(const strategy of strategies){const out=processState(null,r,strategy,{stopLossPct:-7,atrMult:3});maps.get(strategy).set(symbol,out.state)}
  }
  for(const strategy of strategies)assert.equal(maps.get(strategy).size,1100);
  const bytes=Buffer.byteLength(JSON.stringify(Object.fromEntries(maps.get('trending'))));
  assert.ok(bytes<2_000_000,`strategy snapshot is ${bytes} bytes and must stay under D1's 2MB row limit`);
});
