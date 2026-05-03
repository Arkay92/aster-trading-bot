import type { PositionSide, StrategySignal, SyntheticBar } from "../types";

export type SimulatedTrade = {
  symbol: string;
  side: Exclude<PositionSide, "flat">;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  size: number;
  grossPnl: number;
  fees: number;
  pnl: number;
  returnPct: number;
  entryReason: string;
  exitReason: string;
  volatilityRegime?: string;
};

type OpenPosition = {
  symbol: string;
  side: Exclude<PositionSide, "flat">;
  entryTime: number;
  entryPrice: number;
  size: number;
  entryReason: string;
  volatilityRegime?: string;
};

export type ExecutionSimulatorOptions = {
  startingBalance: number;
  positionSizeUsdt: number;
  feeRatePct?: number;
  slippagePct?: number;
  pessimisticMode?: boolean;
  tickSize?: number;
  worseEntryTicks?: number;
  worseExitTicks?: number;
  missedFillPct?: number;
  latencyBars?: number;
  randomSeed?: number;
};

export class ExecutionSimulator {
  private balance: number;
  private readonly positions = new Map<string, OpenPosition>();
  private readonly trades: SimulatedTrade[] = [];
  private readonly pendingSignals: Array<{ symbol: string; signal: NonNullable<StrategySignal>; bar: SyntheticBar; executeAtBar: number; volatilityRegime?: string }> = [];
  private equityPeak: number;
  private maxDrawdown = 0;
  private barIndex = 0;
  private randomState: number;

  constructor(private readonly options: ExecutionSimulatorOptions) {
    this.balance = options.startingBalance;
    this.equityPeak = options.startingBalance;
    this.randomState = options.randomSeed ?? 1;
  }

  onBar(): void {
    this.barIndex++;
    const due = this.pendingSignals.filter((pending) => pending.executeAtBar <= this.barIndex);
    this.pendingSignals.splice(0, this.pendingSignals.length, ...this.pendingSignals.filter((pending) => pending.executeAtBar > this.barIndex));
    for (const pending of due) {
      this.executeSignal(pending.symbol, pending.signal, pending.bar, pending.volatilityRegime);
    }
  }

  onSignal(symbol: string, signal: NonNullable<StrategySignal>, bar: SyntheticBar, volatilityRegime?: string): void {
    if (this.shouldMissFill()) return;
    const latencyBars = this.options.pessimisticMode ? Math.max(0, this.options.latencyBars ?? 1) : 0;
    if (latencyBars > 0) {
      this.pendingSignals.push({ symbol, signal, bar, executeAtBar: this.barIndex + latencyBars, volatilityRegime });
      return;
    }
    this.executeSignal(symbol, signal, bar, volatilityRegime);
  }

  private executeSignal(symbol: string, signal: NonNullable<StrategySignal>, bar: SyntheticBar, volatilityRegime?: string): void {
    const current = this.positions.get(symbol);
    if (current?.side === signal.type) return;

    if (current) {
      this.close(symbol, bar, `flip-${signal.type}`);
    }

    this.open(symbol, signal.type, bar, signal.reason, volatilityRegime);
  }

  close(symbol: string, bar: SyntheticBar, reason: string): void {
    const position = this.positions.get(symbol);
    if (!position) return;

    const exitPrice = this.applySlippage(bar.close, position.side === "long" ? "sell" : "buy");
    const grossPnl = position.side === "long"
      ? (exitPrice - position.entryPrice) * position.size
      : (position.entryPrice - exitPrice) * position.size;
    const notionalIn = position.entryPrice * position.size;
    const notionalOut = exitPrice * position.size;
    const fees = (notionalIn + notionalOut) * ((this.options.feeRatePct ?? 0) / 100);
    const pnl = grossPnl - fees;
    this.balance += pnl;
    this.positions.delete(symbol);
    this.updateDrawdown();

    this.trades.push({
      symbol,
      side: position.side,
      entryTime: position.entryTime,
      exitTime: bar.endTime,
      entryPrice: position.entryPrice,
      exitPrice,
      size: position.size,
      grossPnl,
      fees,
      pnl,
      returnPct: notionalIn > 0 ? (pnl / notionalIn) * 100 : 0,
      entryReason: position.entryReason,
      exitReason: reason,
      volatilityRegime: position.volatilityRegime,
    });
  }

  closeAll(bar: SyntheticBar, reason: string): void {
    for (const symbol of Array.from(this.positions.keys())) {
      this.close(symbol, bar, reason);
    }
  }

  getTrades(): SimulatedTrade[] {
    return [...this.trades];
  }

  getBalance(): number {
    return this.balance;
  }

  getMaxDrawdown(): number {
    return this.maxDrawdown;
  }

  private open(symbol: string, side: Exclude<PositionSide, "flat">, bar: SyntheticBar, reason: string, volatilityRegime?: string): void {
    const entryPrice = this.applySlippage(bar.close, side === "long" ? "buy" : "sell");
    const size = this.options.positionSizeUsdt / entryPrice;
    this.positions.set(symbol, {
      symbol,
      side,
      entryTime: bar.endTime,
      entryPrice,
      size,
      entryReason: reason,
      volatilityRegime,
    });
  }

  private applySlippage(price: number, action: "buy" | "sell"): number {
    const slippage = (this.options.slippagePct ?? 0) / 100;
    const slipped = action === "buy" ? price * (1 + slippage) : price * (1 - slippage);
    const ticks = this.options.pessimisticMode ? (action === "buy" ? this.options.worseEntryTicks : this.options.worseExitTicks) ?? 1 : 0;
    const tickValue = (this.options.tickSize ?? 0) * ticks;
    return action === "buy" ? slipped + tickValue : slipped - tickValue;
  }

  private updateDrawdown(): void {
    this.equityPeak = Math.max(this.equityPeak, this.balance);
    this.maxDrawdown = Math.max(this.maxDrawdown, this.equityPeak - this.balance);
  }

  private shouldMissFill(): boolean {
    const missedFillPct = this.options.pessimisticMode ? this.options.missedFillPct ?? 10 : this.options.missedFillPct ?? 0;
    if (missedFillPct <= 0) return false;
    return this.nextRandom() < missedFillPct / 100;
  }

  private nextRandom(): number {
    this.randomState = (1664525 * this.randomState + 1013904223) >>> 0;
    return this.randomState / 0x100000000;
  }
}
