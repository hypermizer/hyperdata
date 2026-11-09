import test from "node:test";
import assert from "node:assert/strict";
import {exposureChange, historicalWindows, liquidationBands, logicalTime, logicalCoordinate, snapshotFreshness} from "../public/lib/liquidations.js";
import {createAssetLiquidations} from "../public/asset-liquidations.js";
const snapshot=(prices,values)=>({mid_price:100,snapshot_ts_ms:Date.now(),levels:prices.map((price,i)=>({price,long_notional:values[i],short_notional:0,long_count:1,short_count:0}))});
test("liquidation comparison rebins absolute prices, conserving overlap rather than pairing changing bucket indices",()=>{
  const previous=snapshot([90,100,110],[100,200,300]);
  const current=snapshot([95,105,115],[150,250,350]);
  const bands=liquidationBands(current);
  assert.equal(exposureChange(bands[0],previous,"long"),0);
  assert.equal(exposureChange(bands[1],previous,"long"),0);
  assert.equal(exposureChange(bands[2],previous,"long"),null);
});
test("historical liquidation bands never fill gaps beyond the source cadence or before their snapshot",()=>{
  const a={snapshot_ts_ms:1_000_000},b={snapshot_ts_ms:2_000_000};
  const windows=historicalWindows([b,a]);
  assert.deepEqual(windows.map(({start,end})=>[start,end]),[[1000,1300],[2000,2300]]);
  assert.equal(logicalTime(1150,[1000,1100,1200]),1.5);
  assert.equal(logicalCoordinate(1.5,{logicalToCoordinate:i=>Number.isInteger(i)?i*100:0}),150);
});
test("stale snapshots are distinguished from slow or recent collection",()=>{
  const now=Date.now();
  assert.equal(snapshotFreshness({snapshot_ts_ms:now-300000},now),"recent");
  assert.equal(snapshotFreshness({snapshot_ts_ms:now-3600000},now),"delayed");
  assert.equal(snapshotFreshness({snapshot_ts_ms:now-3*3600000},now),"stale");
});
test("enabling history during a pending latest fetch cannot overwrite the heatmap with a response without history",async()=>{
  const nodes=Object.fromEntries(["toggle","panel","range","side","history","status","metrics","nearby","note","hover"].map(key=>[key,{
    checked:key==="toggle",value:key==="range"?"5":"both",hidden:false,textContent:"",innerHTML:"",listeners:{},
    addEventListener(name,fn){this.listeners[name]=fn;},replaceChildren(){this.innerHTML="";},
  }]));
  const doc={hidden:false,querySelector:(selector)=>nodes[selector.replace("#asset-liquidations-","")],addEventListener(){}};
  let releaseFirst,firstStarted=false,rendered;
  const latest={...snapshot([99,100,101],[50,60,70]),snapshot_ts_ms:Date.now(),total_long:180,total_short:0,flagged_notional:0};
  const base={latest,previous:null,request:{history_complete:true},provider:{status:"ready",collector_heartbeat:new Date().toISOString()}};
  const client={sameOrigin:true,watchLiquidations:()=>Promise.resolve(),liquidations:(_asset,history)=>{
    if(!history){firstStarted=true;return new Promise(resolve=>{releaseFirst=()=>resolve({...base,history:[]});});}
    return Promise.resolve({...base,history:[latest]});
  }};
  const controller=createAssetLiquidations(client,()=>100,doc);
  try {
    controller.setChart("BTC",{setLiquidations(data){rendered=data;}});
    await new Promise(r=>setImmediate(r));assert.equal(firstStarted,true);
    nodes.history.checked=true;nodes.history.listeners.change();
    await new Promise(r=>setImmediate(r));assert.equal(rendered.history.length,1);
    releaseFirst();await new Promise(r=>setImmediate(r));assert.equal(rendered.history.length,1);
  }finally{controller.setChart(null,null);}
});
