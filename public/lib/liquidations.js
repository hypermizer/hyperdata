export const LIQUIDATION_COLORS = { long: "32,214,165", short: "255,166,87" };
export function liquidationBands(snapshot) {
  const rows=snapshot?.levels ?? [];
  if(!rows.length) return [];
  return rows.map((r,i)=>{
    const left=i ? (rows[i-1].price+r.price)/2 : r.price-(rows[1]?.price-r.price || snapshot.mid_price*0.002)/2;
    const right=i+1<rows.length ? (r.price+rows[i+1].price)/2 : r.price+(r.price-rows[i-1]?.price || snapshot.mid_price*0.002)/2;
    return {...r,low:Math.max(0,left),high:right};
  });
}
// Compare absolute price intervals, never bucket indices: each snapshot is recentered.
export function exposureChange(band, previous, side) {
  const bands=liquidationBands(previous);
  if(!bands.length || bands[0].low>band.low+1e-8 || bands.at(-1).high<band.high-1e-8) return null;
  const key=side==="long" ? "long_notional" : "short_notional";
  const before=bands.reduce((sum,r)=>sum+r[key]*Math.max(0,Math.min(r.high,band.high)-Math.max(r.low,band.low))/(r.high-r.low),0);
  return band[key]-before;
}
export function snapshotFreshness(snapshot, now=Date.now()) {
  if(!snapshot) return "unavailable";
  const age=now-snapshot.snapshot_ts_ms;
  return age>2*3600_000 ? "stale" : age>15*60_000 ? "delayed" : "recent";
}
export function historicalWindows(snapshots) {
  const sorted=[...snapshots].sort((a,b)=>a.snapshot_ts_ms-b.snapshot_ts_ms);
  return sorted.map((snapshot,i)=>({snapshot,start:snapshot.snapshot_ts_ms/1000,
    end:Math.min(snapshot.snapshot_ts_ms+5*60_000,sorted[i+1]?.snapshot_ts_ms ?? Infinity)/1000}));
}
// Lightweight Charts uses logical indices for timestamps between candle opens.
export function logicalTime(time, candleTimes) {
  if(!candleTimes.length) return null;
  let lo=0,hi=candleTimes.length;
  while(lo<hi) {const mid=(lo+hi)>>>1;if(candleTimes[mid]<=time) lo=mid+1;else hi=mid;}
  const i=Math.min(Math.max(0,lo-1),Math.max(0,candleTimes.length-2));
  const width=candleTimes[i+1]-candleTimes[i] || 60;
  return i+(time-candleTimes[i])/width;
}
export function logicalCoordinate(index,timeScale) {
  // The bundled chart version accepts integer indices only. Interpolate the
  // coordinates so a snapshot between candle opens is placed at its true time.
  const first=Math.floor(index),left=timeScale.logicalToCoordinate(first),right=timeScale.logicalToCoordinate(first+1);
  return left===null || right===null ? null : left+(right-left)*(index-first);
}

export class LiquidationPrimitive {
  constructor() {this.latest=null;this.history=[];this.range=5;this.side="both";this.times=[];this.bands=[];this.windows=[];}
  attached({chart,series,requestUpdate}) {this.chart=chart;this.series=series;this.requestUpdate=requestUpdate;}
  detached() {this.chart=null;this.series=null;this.requestUpdate=null;}
  setCandles(candles) {this.times=candles.map(c=>c.time);this.requestUpdate?.();}
  updateCandle(candle) {
    if(this.times.at(-1)===candle.time) return;
    if(!this.times.length || candle.time>this.times.at(-1)) this.times.push(candle.time);
    this.requestUpdate?.();
  }
  setData({latest=null,history=[],range=5,side="both"}={}) {
    this.latest=latest;this.history=history;this.range=range;this.side=side;
    this.bands=liquidationBands(latest);
    this.windows=historicalWindows(history).map(w=>({...w,bands:liquidationBands(w.snapshot)}));
    const peak=(max,r)=>this.inRange(r)?Math.max(max,this.side!=="short"?r.long_notional:0,this.side!=="long"?r.short_notional:0):max;
    this.peak=this.windows.reduce((max,w)=>w.bands.reduce(peak,max),this.bands.reduce(peak,1));
    this.requestUpdate?.();
  }
  inRange(row) {return this.latest && Math.abs(row.price/this.latest.mid_price-1)*100<=this.range+1e-8;}
  inspectPrice(price) {
    if(price===null || !this.latest || snapshotFreshness(this.latest)==="stale") return null;
    return this.bands.find(r=>r.low<=price && r.high>=price && this.inRange(r)) ?? null;
  }
  autoscaleInfo() {
    if(!this.latest || snapshotFreshness(this.latest)==="stale") return null;
    const rows=this.bands.filter(r=>this.inRange(r) && (this.side!=="short" && r.long_notional>0 || this.side!=="long" && r.short_notional>0));
    return rows.length ? {priceRange:{minValue:rows[0].low,maxValue:rows.at(-1).high}} : null;
  }
  paneViews() {return [{zOrder:()=>"bottom",renderer:()=>({draw:(target)=>this.draw(target)})}];}
  draw(target) {
    if(!this.series || !this.chart || !this.latest) return;
    target.useMediaCoordinateSpace(({context:ctx,mediaSize:{width,height}})=>{
      const sides=this.side==="both" ? ["long","short"] : [this.side];
      const visible=this.chart.timeScale().getVisibleLogicalRange();
      const max=this.peak || 1;
      const alpha=(n)=>0.08+0.48*Math.sqrt(Math.min(1,n/max));
      const yBounds=(r)=>{
        const y1=this.series.priceToCoordinate(r.high),y2=this.series.priceToCoordinate(r.low);
        if(y1===null || y2===null || y2<0 || y1>height) return null;
        return [Math.max(0,y1),Math.max(1,Math.min(height,y2)-Math.max(0,y1))];
      };
      ctx.save();ctx.beginPath();ctx.rect(0,0,width,height);ctx.clip();
      for(const window of this.windows) {
        const first=logicalTime(window.start,this.times),last=logicalTime(window.end,this.times);
        if(first===null || last===null || visible && (last<visible.from || first>visible.to)) continue;
        const x1=logicalCoordinate(first,this.chart.timeScale()),x2=logicalCoordinate(last,this.chart.timeScale());
        if(x1===null || x2===null || x2<=0 || x1>=width) continue;
        for(const band of window.bands) {
          if(!this.inRange(band)) continue;
          const y=yBounds(band);if(!y) continue;
          for(const side of sides) {
            const n=band[side+"_notional"];if(n<=0) continue;
            ctx.fillStyle=`rgba(${LIQUIDATION_COLORS[side]},${alpha(n)*0.7})`;
            ctx.fillRect(Math.max(0,x1),y[0],Math.max(0.5,Math.min(width,x2)-Math.max(0,x1)),y[1]);
          }
        }
      }
      // The right-edge profile describes the latest snapshot, not historical candles.
      if(snapshotFreshness(this.latest)!=="stale") {
        const profileWidth=Math.min(125,width*0.24);
        for(const band of this.bands) {
          if(!this.inRange(band)) continue;
          const y=yBounds(band);if(!y) continue;
          for(const side of sides) {
            const n=band[side+"_notional"];if(n<=0) continue;
            const length=profileWidth*Math.sqrt(Math.min(1,n/max));
            ctx.fillStyle=`rgba(${LIQUIDATION_COLORS[side]},0.7)`;
            ctx.fillRect(width-length,y[0],length,y[1]);
          }
        }
        ctx.font="10px sans-serif";ctx.textAlign="right";ctx.fillStyle="#cbd1d8";
        ctx.fillText("LATEST LIQUIDATIONS",width-6,14);
      }
      ctx.restore();
    });
  }
}
