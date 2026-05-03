import { resolve } from "path";
import { loadHistoricalCandles } from "../dataLoader";
import { ExecutionSimulator } from "../executionSimulator";
import { calculateMetrics } from "../metrics";

describe("backtest module", () => {
  it("loads historical candle CSV data", async () => {
    const bars = await loadHistoricalCandles(resolve(__dirname, "fixtures", "candles.csv"), "BTCUSDT-PERP");

    expect(bars).toHaveLength(3);
    expect(bars[0]).toMatchObject({
      symbol: "BTCUSDT-PERP",
      open: 100,
      high: 105,
      low: 99,
      close: 104,
      volume: 10,
    });
  });

  it("simulates execution and reports metrics", () => {
    const executor = new ExecutionSimulator({
      startingBalance: 1000,
      positionSizeUsdt: 100,
      feeRatePct: 0,
      slippagePct: 0,
    });

    executor.onSignal("BTCUSDT-PERP", {
      type: "long",
      reason: "test-long",
      indicators: { emaFast: 1, emaMid: 1, emaSlow: 1, rsi: 50 },
      trend: { bullStack: true, bearStack: false, longLook: true, shortLook: false, longTrig: true, shortTrig: false },
    }, bar(100));
    executor.close("BTCUSDT-PERP", bar(110), "target");

    const trades = executor.getTrades();
    const metrics = calculateMetrics(trades, 1000, executor.getBalance(), executor.getMaxDrawdown());

    expect(trades).toHaveLength(1);
    expect(metrics.totalPnl).toBe(10);
    expect(metrics.winRatePct).toBe(100);
  });
});

function bar(close: number) {
  return {
    startTime: close,
    endTime: close,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    buyVolume: 1,
    sellVolume: 0,
  };
}
