import type { SimulatedTrade } from "./executionSimulator";

export type BacktestMetrics = {
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  totalPnl: number;
  endingBalance: number;
  returnPct: number;
  maxDrawdown: number;
  profitFactor: number;
  averageTradePnl: number;
  expectancy: number;
  bySymbol: Record<string, BucketMetrics>;
  byHour: Record<string, BucketMetrics>;
  byVolatilityRegime: Record<string, BucketMetrics>;
};

export type BucketMetrics = {
  trades: number;
  winRatePct: number;
  totalPnl: number;
  expectancy: number;
};

export function calculateMetrics(
  trades: SimulatedTrade[],
  startingBalance: number,
  endingBalance: number,
  maxDrawdown: number,
): BacktestMetrics {
  const wins = trades.filter((trade) => trade.pnl > 0);
  const losses = trades.filter((trade) => trade.pnl < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0));
  const totalPnl = endingBalance - startingBalance;

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    totalPnl,
    endingBalance,
    returnPct: startingBalance > 0 ? (totalPnl / startingBalance) * 100 : 0,
    maxDrawdown,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0,
    averageTradePnl: trades.length > 0 ? totalPnl / trades.length : 0,
    expectancy: trades.length > 0 ? totalPnl / trades.length : 0,
    bySymbol: bucket(trades, (trade) => trade.symbol),
    byHour: bucket(trades, (trade) => new Date(trade.exitTime).getUTCHours().toString().padStart(2, "0")),
    byVolatilityRegime: bucket(trades, (trade) => trade.volatilityRegime || "unknown"),
  };
}

function bucket(trades: SimulatedTrade[], keyFn: (trade: SimulatedTrade) => string): Record<string, BucketMetrics> {
  const groups = new Map<string, SimulatedTrade[]>();
  for (const trade of trades) {
    const key = keyFn(trade);
    groups.set(key, [...(groups.get(key) || []), trade]);
  }
  return Object.fromEntries(Array.from(groups.entries()).map(([key, bucketTrades]) => {
    const wins = bucketTrades.filter((trade) => trade.pnl > 0).length;
    const totalPnl = bucketTrades.reduce((sum, trade) => sum + trade.pnl, 0);
    return [key, {
      trades: bucketTrades.length,
      winRatePct: bucketTrades.length > 0 ? (wins / bucketTrades.length) * 100 : 0,
      totalPnl,
      expectancy: bucketTrades.length > 0 ? totalPnl / bucketTrades.length : 0,
    }];
  }));
}
