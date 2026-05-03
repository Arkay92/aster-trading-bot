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
  };
}
