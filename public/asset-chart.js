import { LiquidationPrimitive } from "./lib/liquidations.js?v=20261109-liquidations";

export function createAssetChart(container, onCursorTime = () => {}, onLiquidationHover = () => {}, options = {}) {
  const library = window.LightweightCharts;
  if (!library?.createChart || !library?.CandlestickSeries || !library?.HistogramSeries) {
    throw new Error("Chart library unavailable.");
  }

  const chart = library.createChart(container, {
    autoSize: true,
    height: options.height ?? 430,
    layout: {
      background: { type: "solid", color: "#101214" },
      textColor: "#a8afb7",
      attributionLogo: true,
    },
    grid: {
      vertLines: { color: "rgba(236, 239, 241, 0.06)" },
      horzLines: { color: "rgba(236, 239, 241, 0.06)" },
    },
    rightPriceScale: { borderColor: "#34383d" },
    timeScale: {
      borderColor: "#34383d",
      timeVisible: true,
      secondsVisible: false,
    },
  });
  const candleSeries = chart.addSeries(library.CandlestickSeries, {
    upColor: "#20d6a5",
    downColor: "#ff4d5d",
    borderVisible: false,
    wickUpColor: "#20d6a5",
    wickDownColor: "#ff4d5d",
    priceLineColor: "#2c8881",
  });
  const volumeSeries = chart.addSeries(library.HistogramSeries, {
    priceFormat: { type: "volume" },
    priceScaleId: "",
    lastValueVisible: false,
    priceLineVisible: false,
  });
  const liquidations = new LiquidationPrimitive();
  candleSeries.attachPrimitive(liquidations);
  volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  chart.subscribeCrosshairMove((parameter) => {
    onCursorTime(typeof parameter.time === "number" ? parameter.time : null);
    onLiquidationHover(liquidations.inspectPrice(parameter.point ? candleSeries.coordinateToPrice(parameter.point.y) : null));
  });
  let applyingRange = false;
  if (options.onRangeChange) chart.timeScale().subscribeVisibleTimeRangeChange((range) => {
    if (!applyingRange && range && typeof range.from === "number" && typeof range.to === "number") options.onRangeChange(range);
  });

  function candlePoint(candle) {
    const { time, open, high, low, close } = candle;
    return { time, open, high, low, close };
  }

  function volumePoint(candle) {
    return {
      time: candle.time,
      value: candle.volume ?? 0,
      color: candle.close >= candle.open ? "rgba(32, 214, 165, 0.35)" : "rgba(255, 77, 93, 0.35)",
    };
  }

  return {
    setVisibleRange(range) {
      applyingRange = true;
      try { chart.timeScale().setVisibleRange(range); }
      finally { applyingRange = false; }
    },
    setData(candles, resetView = true) {
      candleSeries.setData(candles.map(candlePoint));
      liquidations.setCandles(candles);
      volumeSeries.setData(candles.map(volumePoint));
      if (resetView) {
        const finalIndex = candles.length - 1;
        chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, finalIndex - 149), to: finalIndex + 5 });
      }
    },
    update(candle) {
      candleSeries.update(candlePoint(candle));
      liquidations.updateCandle(candle);
      volumeSeries.update(volumePoint(candle));
    },
    setLiquidations(data) { liquidations.setData(data); },
    destroy() {
      candleSeries.detachPrimitive(liquidations);
      chart.remove();
    },
  };
}
