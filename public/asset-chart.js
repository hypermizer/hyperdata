export function createAssetChart(container) {
  const library = window.LightweightCharts;
  if (!library?.createChart || !library?.CandlestickSeries) {
    throw new Error("Chart library unavailable.");
  }

  const chart = library.createChart(container, {
    autoSize: true,
    height: 430,
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
  const series = chart.addSeries(library.CandlestickSeries, {
    upColor: "#20d6a5",
    downColor: "#ff4d5d",
    borderVisible: false,
    wickUpColor: "#20d6a5",
    wickDownColor: "#ff4d5d",
    priceLineColor: "#2c8881",
  });

  return {
    setData(candles) {
      series.setData(candles);
      chart.timeScale().fitContent();
    },
    update(candle) {
      series.update(candle);
    },
    destroy() {
      chart.remove();
    },
  };
}
