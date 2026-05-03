import {
  EmaCrossEngine,
  PeachHybridEngine,
  RsiReversionEngine,
  SwingEngine,
  WatermellonEngine,
} from "../engines";
import type {
  AppConfig,
  MarketRegime,
  StrategyContext,
  StrategyEngine,
  StrategyType,
  StructuralState,
  SyntheticBar,
} from "../types";
import type { HistoricalBar } from "./dataLoader";
import { ExecutionSimulator, type ExecutionSimulatorOptions, type SimulatedTrade } from "./executionSimulator";
import { calculateMetrics, type BacktestMetrics } from "./metrics";

export type BacktestOptions = Partial<ExecutionSimulatorOptions>;

export type BacktestResult = {
  metrics: BacktestMetrics;
  trades: SimulatedTrade[];
};

export class SimulationEngine {
  private readonly engines = new Map<string, StrategyEngine>();
  private readonly executor: ExecutionSimulator;
  private readonly recentBars = new Map<string, SyntheticBar[]>();
  private readonly startingBalance: number;
  private readonly options: BacktestOptions;

  constructor(
    private readonly config: AppConfig,
    options: BacktestOptions = {},
  ) {
    this.options = options;
    this.startingBalance = options.startingBalance ?? config.paperTrading?.startingBalance ?? 10_000;
    this.executor = new ExecutionSimulator({
      startingBalance: this.startingBalance,
      positionSizeUsdt: options.positionSizeUsdt ?? config.risk.maxPositionSize,
      feeRatePct: options.feeRatePct ?? 0.04,
      slippagePct: options.slippagePct ?? 0.02,
      pessimisticMode: options.pessimisticMode,
      tickSize: options.tickSize,
      worseEntryTicks: options.worseEntryTicks,
      worseExitTicks: options.worseExitTicks,
      missedFillPct: options.missedFillPct,
      latencyBars: options.latencyBars,
      randomSeed: options.randomSeed,
    });
  }

  run(bars: HistoricalBar[]): BacktestResult {
    let lastBar: HistoricalBar | undefined;

    for (const bar of bars) {
      this.executor.onBar();
      const symbol = this.toPerpSymbol(bar.symbol);
      const engine = this.getEngine(symbol);
      const context = this.getContext(symbol, bar);
      const signal = engine.update(bar, context);
      this.pushRecentBar(symbol, bar);

      if (signal) {
        this.executor.onSignal(symbol, signal, bar, this.getVolatilityRegime(symbol, bar.close));
        engine.onPositionChange?.(signal.type);
      }

      const exit = engine.checkExitConditions?.(bar);
      if (exit?.shouldExit) {
        this.executor.close(symbol, bar, exit.reason);
        engine.onPositionChange?.("flat");
      }

      lastBar = bar;
    }

    if (lastBar) this.executor.closeAll(lastBar, "end-of-data");

    const trades = this.executor.getTrades();
    const endingBalance = this.executor.getBalance();
    return {
      trades,
      metrics: calculateMetrics(trades, this.startingBalance, endingBalance, this.executor.getMaxDrawdown()),
    };
  }

  private getEngine(symbol: string): StrategyEngine {
    const existing = this.engines.get(symbol);
    if (existing) return existing;

    const strategyType = this.config.strategyType ?? this.config.strategyTypes?.[0] ?? "watermellon";
    const strategyConfig = this.config.strategies?.[strategyType] ?? this.config.strategy;
    const engine = createStrategyEngine(strategyType, strategyConfig);
    this.engines.set(symbol, engine);
    return engine;
  }

  private getContext(symbol: string, bar: SyntheticBar): StrategyContext {
    const recent = this.recentBars.get(symbol) ?? [];
    const recentHigh = recent.length > 0 ? Math.max(...recent.map((b) => b.high), bar.high) : bar.high;
    const recentLow = recent.length > 0 ? Math.min(...recent.map((b) => b.low), bar.low) : bar.low;
    const structure: StructuralState = {
      recentHigh,
      recentLow,
      lastBreakout: bar.close > recentHigh ? "up" : bar.close < recentLow ? "down" : "none",
      isWickRejection: this.isWickRejection(bar),
    };
    const regime: MarketRegime = recent.length < 10 ? "quiet" : this.getSimpleRegime(recent, bar);

    return {
      regime,
      htfBias: "neutral",
      structure,
    };
  }

  private getSimpleRegime(recent: SyntheticBar[], bar: SyntheticBar): MarketRegime {
    const closes = [...recent.slice(-10).map((b) => b.close), bar.close];
    const first = closes[0];
    const last = closes[closes.length - 1];
    const movePct = first > 0 ? Math.abs((last - first) / first) * 100 : 0;
    const avgRangePct = recent.slice(-10).reduce((sum, b) => sum + ((b.high - b.low) / b.close) * 100, 0) / Math.min(recent.length, 10);
    if (movePct > 1) return "trending";
    if (avgRangePct > 1) return "volatile";
    return "ranging";
  }

  private getVolatilityRegime(symbol: string, price: number): string {
    const recent = this.recentBars.get(symbol) ?? [];
    if (recent.length < 10 || price <= 0) return "unknown";
    const ranges = recent.slice(-20).map((bar) => ((bar.high - bar.low) / bar.close) * 100);
    const avgRangePct = ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
    if (avgRangePct < 0.05) return "too-low";
    if (avgRangePct > 3) return "extreme";
    if (avgRangePct > 1.5) return "elevated";
    return "normal";
  }

  private isWickRejection(bar: SyntheticBar): boolean {
    const range = bar.high - bar.low;
    if (range <= 0) return false;
    const upperWick = bar.high - Math.max(bar.open, bar.close);
    const lowerWick = Math.min(bar.open, bar.close) - bar.low;
    return upperWick > range * 0.4 || lowerWick > range * 0.4;
  }

  private pushRecentBar(symbol: string, bar: SyntheticBar): void {
    const bars = this.recentBars.get(symbol) ?? [];
    bars.push(bar);
    while (bars.length > 50) bars.shift();
    this.recentBars.set(symbol, bars);
  }

  private toPerpSymbol(symbol: string): string {
    const up = symbol.toUpperCase();
    return up.endsWith("-PERP") ? up : `${up}-PERP`;
  }
}

function createStrategyEngine(strategyType: StrategyType, config: unknown): StrategyEngine {
  if (strategyType === "peach-hybrid") return new PeachHybridEngine(config as never);
  if (strategyType === "swing") return new SwingEngine(config as never);
  if (strategyType === "ema-cross") return new EmaCrossEngine(config as never);
  if (strategyType === "rsi-reversion") return new RsiReversionEngine(config as never);
  return new WatermellonEngine(config as never);
}
