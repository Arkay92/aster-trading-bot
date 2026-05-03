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
};

export class TradeStatistics {
  private trades: TradeRecord[] = [];
  private currentTrades = new Map<string, Partial<TradeRecord>>();

  startTrade(symbol: string, side: "long" | "short", entryPrice: number, size: number, leverage: number): void {
    this.currentTrades.set(symbol, {
      id: `trade-${Date.now()}-${symbol}`,
      symbol,
      side,
      entryPrice,
      entryTime: Date.now(),
      size,
      leverage,
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

  getStats(): {
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    totalPnL: number;
    avgWin: number;
    avgLoss: number;
    profitFactor: number;
    maxDrawdown: number;
    largestWin: number;
    largestLoss: number;
  } {
    if (this.trades.length === 0) {
      return {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        totalPnL: 0,
        avgWin: 0,
        avgLoss: 0,
        profitFactor: 0,
        maxDrawdown: 0,
        largestWin: 0,
        largestLoss: 0,
      };
    }

    const winningTrades = this.trades.filter(t => t.pnl > 0);
    const losingTrades = this.trades.filter(t => t.pnl < 0);

    const totalPnL = this.trades.reduce((sum, t) => sum + t.pnl, 0);
    const avgWin = winningTrades.length > 0 ? winningTrades.reduce((sum, t) => sum + t.pnl, 0) / winningTrades.length : 0;
    const avgLoss = losingTrades.length > 0 ? Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0) / losingTrades.length) : 0;

    let peak = 0;
    let maxDrawdown = 0;
    let runningPnL = 0;

    for (const trade of this.trades) {
      runningPnL += trade.pnl;
      if (runningPnL > peak) peak = runningPnL;
      const drawdown = peak - runningPnL;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    const largestWin = winningTrades.length > 0 ? Math.max(...winningTrades.map(t => t.pnl)) : 0;
    const largestLoss = losingTrades.length > 0 ? Math.min(...losingTrades.map(t => t.pnl)) : 0;

    return {
      totalTrades: this.trades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: (winningTrades.length / this.trades.length) * 100,
      totalPnL,
      avgWin,
      avgLoss,
      profitFactor: avgLoss > 0 ? (avgWin * winningTrades.length) / (avgLoss * losingTrades.length) : avgWin > 0 ? Infinity : 0,
      maxDrawdown,
      largestWin,
      largestLoss,
    };
  }

  getRecentTrades(limit = 10): TradeRecord[] {
    return this.trades.slice(-limit);
  }
}
