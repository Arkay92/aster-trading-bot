import { TradeStatistics } from "../tradeStatistics";

describe("TradeStatistics", () => {
  let stats: TradeStatistics;

  beforeEach(() => {
    stats = new TradeStatistics();
  });

  it("should calculate PNL correctly for a long trade", () => {
    stats.startTrade("BTCUSDT", "long", 100, 10, 1);
    stats.closeTrade("BTCUSDT", 110, "take-profit");
    
    const results = stats.getRecentTrades(1);
    expect(results[0].pnl).toBe(100); // (110 - 100) * 10
    expect(results[0].pnlPercent).toBe(10); // (10 / 100) * 100
  });

  it("should calculate PNL correctly for a short trade", () => {
    stats.startTrade("BTCUSDT", "short", 100, 10, 1);
    stats.closeTrade("BTCUSDT", 90, "take-profit");
    
    const results = stats.getRecentTrades(1);
    expect(results[0].pnl).toBe(100); // (100 - 90) * 10
  });

  it("should aggregate stats correctly for multiple trades", () => {
    // Win
    stats.startTrade("BTCUSDT", "long", 100, 1, 1);
    stats.closeTrade("BTCUSDT", 110, "win");
    
    // Loss
    stats.startTrade("ETHUSDT", "long", 100, 1, 1);
    stats.closeTrade("ETHUSDT", 95, "loss");
    
    const report = stats.getStats();
    expect(report.totalTrades).toBe(2);
    expect(report.winningTrades).toBe(1);
    expect(report.losingTrades).toBe(1);
    expect(report.totalPnL).toBe(5); // 10 - 5
    expect(report.winRate).toBe(50);
  });

  it("should calculate max drawdown correctly", () => {
    // Win 10
    stats.startTrade("T1", "long", 100, 1, 1);
    stats.closeTrade("T1", 110, "win");
    
    // Loss 5
    stats.startTrade("T2", "long", 100, 1, 1);
    stats.closeTrade("T2", 95, "loss");
    
    // Loss 10
    stats.startTrade("T3", "long", 100, 1, 1);
    stats.closeTrade("T3", 90, "loss");
    
    const report = stats.getStats();
    // Peak was 10. Current is 10 - 5 - 10 = -5. Drawdown = 10 - (-5) = 15.
    expect(report.maxDrawdown).toBe(15);
  });

  it("should calculate performance metrics by strategy", () => {
    stats.startTrade("BTCUSDT", "long", 100, 1, 1, "ema-cross");
    stats.closeTrade("BTCUSDT", 110, "win");

    stats.startTrade("ETHUSDT", "short", 100, 1, 1, "rsi-reversion");
    stats.closeTrade("ETHUSDT", 110, "loss");

    const strategyStats = stats.getStrategyStats();
    expect(strategyStats["ema-cross"].totalTrades).toBe(1);
    expect(strategyStats["ema-cross"].totalPnL).toBe(10);
    expect(strategyStats["rsi-reversion"].totalTrades).toBe(1);
    expect(strategyStats["rsi-reversion"].totalPnL).toBe(-10);
  });
});
