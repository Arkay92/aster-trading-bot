export type TradeRecord = {
  id: string;
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  size: number;
  pnl: number;
  pnlPercent: number;
  reason: string;
  leverage: number;
  strategy?: string;
  volatilityRegime?: string;
};

export class TradeStatistics {
  private trades: TradeRecord[] = [];
  private currentTrades = new Map<string, Partial<TradeRecord>>();

  startTrade(symbol: string, side: "long" | "short", entryPrice: number, size: number, leverage: number, strategy?: string, context?: { volatilityRegime?: string }): void {
    this.currentTrades.set(symbol, {
      id: `trade-${Date.now()}-${symbol}`,
      symbol,
      side,
      entryPrice,
      entryTime: Date.now(),
      size,
      leverage,
      strategy,
      volatilityRegime: context?.volatilityRegime,
    });
  }

  closeTrade(symbol: string, exitPrice: number, reason: string): void {
    const currentTrade = this.currentTrades.get(symbol);
    if (!currentTrade) return;

    const trade: TradeRecord = {
      ...currentTrade,
      exitPrice,
      exitTime: Date.now(),
      pnl: this.calculatePnL(currentTrade as TradeRecord, exitPrice),
      pnlPercent: this.calculatePnLPercent(currentTrade as TradeRecord, exitPrice),
      reason,
    } as TradeRecord;

    this.trades.push(trade);
    this.currentTrades.delete(symbol);
  }

  private calculatePnL(trade: TradeRecord, exitPrice: number): number {
    const priceDiff = trade.side === "long" ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice;
    return priceDiff * trade.size;
  }

  private calculatePnLPercent(trade: TradeRecord, exitPrice: number): number {
    const priceDiff = trade.side === "long" ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice;
    return (priceDiff / trade.entryPrice) * 100 * trade.leverage;
  }

  getStats(strategy?: string) {
    return this.calculateStats(strategy ? this.trades.filter((t) => t.strategy === strategy) : this.trades);
  }

  private calculateStats(trades: TradeRecord[]) {
    if (trades.length === 0) {
      return {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        totalPnL: 0,
        avgWin: 0,
        avgLoss: 0,
        profitFactor: 0,
        expectancy: 0,
        maxDrawdown: 0,
        largestWin: 0,
        largestLoss: 0,
      };
    }

    const winningTrades = trades.filter(t => t.pnl > 0);
    const losingTrades = trades.filter(t => t.pnl < 0);

    const totalPnL = trades.reduce((sum, t) => sum + t.pnl, 0);
    const totalWin = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
    const totalLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0));
    
    const avgWin = winningTrades.length > 0 ? totalWin / winningTrades.length : 0;
    const avgLoss = losingTrades.length > 0 ? totalLoss / losingTrades.length : 0;

    const winRate = winningTrades.length / trades.length;
    const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);

    let peak = 0;
    let maxDrawdown = 0;
    let runningPnL = 0;

    for (const trade of trades) {
      runningPnL += trade.pnl;
      if (runningPnL > peak) peak = runningPnL;
      const drawdown = peak - runningPnL;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    const largestWin = winningTrades.length > 0 ? Math.max(...winningTrades.map(t => t.pnl)) : 0;
    const largestLoss = losingTrades.length > 0 ? Math.min(...losingTrades.map(t => t.pnl)) : 0;

    return {
      totalTrades: trades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: winRate * 100,
      totalPnL,
      avgWin,
      avgLoss,
      profitFactor: totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? Infinity : 0,
      expectancy,
      maxDrawdown,
      largestWin,
      largestLoss,
    };
  }

  getRecentTrades(limit = 10): TradeRecord[] {
    return this.trades.slice(-limit);
  }

  getStrategyStats(): Record<string, ReturnType<TradeStatistics["getStats"]>> {
    const strategies = new Set(this.trades.map((trade) => trade.strategy || "unknown"));
    const result: Record<string, ReturnType<TradeStatistics["getStats"]>> = {};
    for (const strategy of strategies) {
      const trades = this.trades.filter((trade) => (trade.strategy || "unknown") === strategy);
      result[strategy] = this.calculateStats(trades);
    }
    return result;
  }

  getHourStats(): Record<string, ReturnType<TradeStatistics["getStats"]>> {
    const hours = new Set(this.trades.map((trade) => new Date(trade.exitTime).getUTCHours().toString().padStart(2, "0")));
    const result: Record<string, ReturnType<TradeStatistics["getStats"]>> = {};
    for (const hour of hours) {
      result[hour] = this.calculateStats(this.trades.filter((trade) => new Date(trade.exitTime).getUTCHours().toString().padStart(2, "0") === hour));
    }
    return result;
  }

  getVolatilityRegimeStats(): Record<string, ReturnType<TradeStatistics["getStats"]>> {
    const regimes = new Set(this.trades.map((trade) => trade.volatilityRegime || "unknown"));
    const result: Record<string, ReturnType<TradeStatistics["getStats"]>> = {};
    for (const regime of regimes) {
      result[regime] = this.calculateStats(this.trades.filter((trade) => (trade.volatilityRegime || "unknown") === regime));
    }
    return result;
  }
}
