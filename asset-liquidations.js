import { exposureChange, liquidationBands, snapshotFreshness } from "./lib/liquidations.js?v=20261109-liquidations";

const escapeHtml=(v)=>String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const usd=(n)=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",notation:"compact",maximumFractionDigits:2}).format(n);
const price=(n)=>new Intl.NumberFormat("en-US",{maximumSignificantDigits:8}).format(n);
const date=(n)=>new Date(n).toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",timeZoneName:"short"});

export function createAssetLiquidations(client, getMark, doc=document) {
  const e=Object.fromEntries(["toggle","panel","range","side","history","status","metrics","nearby","note","hover"].map(k=>[k,doc.querySelector(`#asset-liquidations-${k}`)]));
  let asset=null,chart=null,data=null,timer=null,generation=0,refreshing=false,lastDemand=0,lastRead=0,historyLoaded=false;
  const enabled=()=>e.toggle.checked;
  const clear=()=>{chart?.setLiquidations();};
  function render() {
    e.panel.hidden=!enabled();
    if(!enabled()) {clear();return;}
    if(!asset || !chart) {e.panel.hidden=true;e.metrics.replaceChildren();e.nearby.replaceChildren();e.note.textContent="";return;}
    if(!client.sameOrigin) {
      clear();e.status.innerHTML=`<a href="${escapeHtml(client.url)}/#/assets/${encodeURIComponent(asset ?? "BTC")}/overview/1h">Open the private Hyperdata app</a> with your client certificate to view liquidation data.`;
      e.metrics.replaceChildren();e.nearby.replaceChildren();e.note.textContent="The provider key stays on your server.";return;
    }
    const latest=data?.latest;
    const collectorStale=data?.provider && (!data.provider.collector_heartbeat || Date.now()-Date.parse(data.provider.collector_heartbeat)>90_000);
    if(!latest) {
      clear();e.metrics.replaceChildren();e.nearby.replaceChildren();
      e.status.textContent=data?.request?.last_error ?? (collectorStale ? "Liquidation collection is unavailable; retrying shortly." : data?.provider?.status && data.provider.status!=="ready" ? "Collection paused · "+data.provider.status.replaceAll("_"," ") : "Loading liquidation snapshot…");
      e.note.textContent="Market coverage varies. Missing snapshots are not zero exposure.";return;
    }
    const freshness=snapshotFreshness(latest),age=Math.max(0,Math.floor((Date.now()-latest.snapshot_ts_ms)/60_000));
    const error=data.request?.last_error ?? (collectorStale?"Collector unavailable; showing the last snapshot.":null);
    const providerPaused=data.provider?.status && data.provider.status!=="ready";
    const historyState=e.history.checked ? historyLoaded && data.request?.history_complete ? ` · ${data.history.length} historical snapshots` : " · loading 24h history…" : "";
    e.status.textContent=`${freshness==="stale"?"STALE · PROFILE HIDDEN":freshness==="delayed"?"DELAYED SNAPSHOT":"SNAPSHOT"} · ${date(latest.snapshot_ts_ms)} · ${age}m ago${historyState}${error?" · "+error:providerPaused?" · collection paused: "+data.provider.status.replaceAll("_"," "):""}`;
    chart?.setLiquidations({latest,history:e.history.checked && historyLoaded?data.history:[],range:Number(e.range.value),side:e.side.value});
    const range=Number(e.range.value), mark=getMark(asset) || latest.mid_price;
    const bands=liquidationBands(latest).filter(r=>Math.abs(r.price/latest.mid_price-1)*100<=range+1e-8);
    const longs=bands.reduce((s,r)=>s+r.long_notional,0),shorts=bands.reduce((s,r)=>s+r.short_notional,0);
    e.metrics.innerHTML=[["LONGS IN RANGE",usd(longs)],["SHORTS IN RANGE",usd(shorts)],["APPROX. / UNALLOCATED",usd(latest.flagged_notional)]]
      .map(([label,value])=>`<span><small>${label}</small><strong>${value}</strong></span>`).join("");
    const items=bands.flatMap(band=>["long","short"].filter(side=>e.side.value==="both" || e.side.value===side)
      .filter(side=>band[side+"_notional"]>0).map(side=>({band,side,distance:(band.price/mark-1)*100})))
      .sort((a,b)=>Math.abs(a.distance)-Math.abs(b.distance)).slice(0,8);
    const previous=data.previous && data.previous.snapshot_ts_ms<latest.snapshot_ts_ms ? data.previous : null;
    e.nearby.innerHTML=items.length ? `<table class="paper-table"><thead><tr><th>SIDE</th><th>PRICE ZONE</th><th>EXPOSURE</th><th>POSITIONS</th><th>FROM LIVE MARK</th><th>CHANGE*</th></tr></thead><tbody>${items.map(({band,side,distance})=>{
      const delta=previous?exposureChange(band,previous,side):null;
      return `<tr><td class="liquidation-${side}">${side.toUpperCase()}</td><td>${price(band.low)}–${price(band.high)}</td><td>${usd(band[side+"_notional"])}</td><td>${band[side+"_count"].toLocaleString()}</td><td>${distance>=0?"+":""}${distance.toFixed(2)}%</td><td>${delta===null?"—":(delta>=0?"+":"−")+usd(Math.abs(delta))}</td></tr>`;
    }).join("")}</tbody></table>` : "No mapped exposure in the selected range. This does not imply zero exposure across the whole book.";
    const hip3=asset.includes(":");
    const resolution=latest.source==="histogram" ? ` Re-binned source histogram${latest.source_bin_width?"; native width "+price(latest.source_bin_width):""}.` : "";
    e.note.textContent=`0xArchive projected exposure · cyan: longs · orange: shorts. Right-edge bars show the latest snapshot; the optional heatmap shows retained snapshots at their observation times. Range is centered on snapshot mark ${price(latest.mid_price)}. Updates are about every 5 minutes. ${hip3?"HIP-3 positions can lag 30–65 minutes; cross-margin exposure is excluded from bands and included in approximate/unallocated exposure.":"Core positions are advanced using fills from older account snapshots; intervening isolated-margin changes and funding are not applied."}${resolution} Whole-book totals: longs ${usd(latest.total_long)}, shorts ${usd(latest.total_short)}. *Change is an approximate comparison over the same price interval${previous?" since "+date(previous.snapshot_ts_ms):"; another snapshot is needed"}. A decrease does not confirm liquidation. Historical gaps remain blank.`;
  }
  async function refresh() {
    if(!asset || !chart || !enabled() || !client.sameOrigin || refreshing || doc.hidden) return;
    if(data?.latest && (!e.history.checked || historyLoaded && data.request?.history_complete) && Date.now()-lastRead<30_000 && lastDemand!==0) return;
    const token=generation,selected=asset,includeHistory=e.history.checked;refreshing=true;
    try {
      if(Date.now()-lastDemand>45_000) {await client.watchLiquidations(selected,includeHistory);if(token!==generation)return;lastDemand=Date.now();}
      const snapshot=await client.liquidations(selected,includeHistory);
      if(token!==generation) return;
      data=snapshot;historyLoaded=includeHistory;lastRead=Date.now();render();
    } catch(error) {
      if(token===generation) {if(data) render();e.status.textContent=(data?"Showing the last snapshot · ":"")+(error.message ?? "Liquidation data unavailable.");}
    } finally {if(token===generation) refreshing=false;}
  }
  e.toggle.addEventListener("change",()=>{render();if(enabled())void refresh();});
  for(const key of ["range","side"]) e[key].addEventListener("change",render);
  e.history.addEventListener("change",()=>{generation++;refreshing=false;lastDemand=0;lastRead=0;historyLoaded=false;render();void refresh();});
  doc.addEventListener("visibilitychange",()=>{if(!doc.hidden)void refresh();});
  return {
    inspect(band) {
      e.hover.textContent=enabled() && band ? `${price(band.low)}–${price(band.high)} · LONGS ${usd(band.long_notional)} (${band.long_count.toLocaleString()} positions) · SHORTS ${usd(band.short_notional)} (${band.short_count.toLocaleString()} positions) · latest snapshot`
        : "Move over the chart to inspect a price zone in the latest snapshot.";
    },
    setChart(nextAsset,nextChart) {
      generation++;refreshing=false;clearInterval(timer);timer=null;
      chart?.setLiquidations();chart=nextChart;
      if(asset!==nextAsset) {data=null;lastDemand=0;lastRead=0;historyLoaded=false;}
      asset=nextAsset;
      e.hover.textContent="Move over the chart to inspect a price zone in the latest snapshot.";
      render();
      if(chart) {void refresh();timer=setInterval(()=>{render();void refresh();},10_000);}
    },
  };
}
