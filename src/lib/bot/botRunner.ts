import { EventEmitter } from "events";
import { 
  WatermellonEngine, 
  PeachHybridEngine, 
  SwingEngine, 
  EmaCrossEngine, 
  RsiReversionEngine 
} from "../engines";
import { VirtualBarBuilder } from "../virtualBarBuilder";
import { RestPoller } from "../rest/restPoller";
import { PositionStateManager } from "../state/positionState";
import { OrderTracker } from "../execution/orderTracker";
import { StatePersistence } from "../state/statePersistence";
import { KeyManager } from "../security/keyManager";
import { ADX } from "../indicators/adx";
import { ATR } from "../indicators/atr";
import { EMA } from "../indicators/ema";
import { Slope } from "../indicators/slope";
import type {
  AppConfig,
  EmaCrossConfig,
  ExecutionAdapter,
  PeachConfig,
  RsiReversionConfig,
  StrategyType,
  SwingConfig,
  PositionState,
  StrategyEngine,
  StrategySignal,
  SyntheticBar,
  TradeInstruction,
  Tick,
  WatermellonConfig,
  StrategyContext,
  MarketRegime,
  StructuralState,
} from "../types";

type BotRunnerEvents = {
  signal: (signal: StrategySignal, bar: SyntheticBar) => void;
  position: (position: PositionState) => void;
  log: (message: string, payload?: Record<string, unknown>) => void;
  stop: () => void;
};

type TickStream = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  on: <K extends "tick" | "error" | "close">(event: K, handler: (...args: unknown[]) => void) => () => void;
};

type Engine = StrategyEngine;
type SignalCandidate = { strategyType: StrategyType; signal: NonNullable<StrategySignal> };

const HOUR_MS = 60 * 60 * 1000;

import { TradeStatistics } from "./tradeStatistics";

export class BotRunner {
  private readonly emitter = new EventEmitter();
  private readonly barBuilders = new Map<string, VirtualBarBuilder>();
  private readonly engines = new Map<string, Map<StrategyType, Engine>>();
  private readonly restPoller?: RestPoller;
  private readonly stateManager: PositionStateManager;
  private readonly orderTracker: OrderTracker;
  private readonly statePersistence: StatePersistence;
  private readonly tradeStats = new TradeStatistics();
  private positions = new Map<string, PositionState>();
  private flipHistory: number[] = [];
  private unsubscribers: Array<() => void> = [];
  private processedSignals = new Set<string>();
  private symbolActionLocks = new Set<string>();
  private pendingGlobalEntries = 0;
  private pendingStrategyEntries = new Map<StrategyType, number>();
  private pendingDirectionalEntries = new Map<"long" | "short", number>();
  private lastBarCloseTimes = new Map<string, number>();
  private readonly strategyTypes: StrategyType[];
  private readonly timeframeMs: number;
  private highestPrices = new Map<string, number>();
  private lowestPrices = new Map<string, number>();
  private lastEntryAt = new Map<string, number>();
  private dailyRealizedPnl = 0;
  private dailyStartBalance = 0;
  private dailyPeakPnl = 0;
  private consecutiveLosses = 0;
  private riskHalted = false;
  private riskDayKey = "";
  private lastRiskProcessedTradeId = "";
  private initialBalanceFetched = false;
  private recentBars = new Map<string, SyntheticBar[]>();
  private adxBySymbol = new Map<string, ADX>();
  private atrBySymbol = new Map<string, ATR>();
  private dynamicStopBySymbol = new Map<string, number>();
  private pulseInterval: NodeJS.Timeout | null = null;
  private partialProfitTaken = new Set<string>();
  private htfBuilders = new Map<string, VirtualBarBuilder>();
  private htfBias = new Map<string, "bullish" | "bearish" | "neutral">();
  private symbolTradeCountInLastHour = new Map<string, number[]>();
  private cooldownUntil = new Map<string, number>();
  private slopeBySymbol = new Map<string, Slope>();
  private htfEmaBySymbol = new Map<string, EMA>();
  private htfEmaSlowBySymbol = new Map<string, EMA>();
  private lastTradeSide = new Map<string, string>();
  private lastTradeAt = new Map<string, number>();
  private entryBlockLogAt = new Map<string, number>();
  
  private fundingBySymbol = new Map<string, number>();
  private premiumBySymbol = new Map<string, number>();
  private invalidPerpSignalSymbols = new Set<string>();
  private pendingBreakouts = new Map<string, {
    direction: "long" | "short";
    level: number;
    expiresAt: number;
    strategyType: StrategyType;
    signal: NonNullable<StrategySignal>;
  }>();
  private fundingPollInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly tickStreams: TickStream[],
    private readonly executor: ExecutionAdapter,
  ) {
    this.strategyTypes = config.strategyTypes && config.strategyTypes.length > 0
      ? config.strategyTypes
      : [config.strategyType ?? "watermellon"];
    const timeframeMs = this.getPrimaryTimeframe();
    this.timeframeMs = timeframeMs;
    
    for (const rawSymbol of config.credentials.pairSymbols) {
      const symbol = this.toPerpSymbol(rawSymbol);
      this.barBuilders.set(symbol, new VirtualBarBuilder(timeframeMs));
      if (this.config.risk.htfBiasEnabled) {
        this.htfBuilders.set(symbol, new VirtualBarBuilder(this.config.risk.htfTimeframeMs || 3600000));
      }
      this.recentBars.set(symbol, []);
      this.adxBySymbol.set(symbol, new ADX(this.config.risk.atrLength ?? 14));
      this.atrBySymbol.set(symbol, new ATR(this.config.risk.atrLength ?? 14));
      this.slopeBySymbol.set(symbol, new Slope(3));
      this.htfEmaBySymbol.set(symbol, new EMA(50));
      this.htfEmaSlowBySymbol.set(symbol, new EMA(200));
      const enginesByStrategy = new Map<StrategyType, Engine>();
      for (const strategyType of this.strategyTypes) {
        const strategyConfig = this.getStrategyConfig(strategyType);
        if (strategyType === "peach-hybrid") {
          enginesByStrategy.set(strategyType, new PeachHybridEngine(strategyConfig as PeachConfig));
        } else if (strategyType === "swing") {
          enginesByStrategy.set(strategyType, new SwingEngine(strategyConfig as SwingConfig));
        } else if (strategyType === "ema-cross") {
          enginesByStrategy.set(strategyType, new EmaCrossEngine(strategyConfig as EmaCrossConfig));
        } else if (strategyType === "rsi-reversion") {
          enginesByStrategy.set(strategyType, new RsiReversionEngine(strategyConfig as RsiReversionConfig));
        } else {
          enginesByStrategy.set(strategyType, new WatermellonEngine(strategyConfig as WatermellonConfig));
        }
      }
      this.engines.set(symbol, enginesByStrategy);
      this.positions.set(symbol, { side: "flat", size: 0, symbol });
    }
    
    this.restPoller = config.mode === "live" ? new RestPoller(config.credentials) : undefined;
    this.stateManager = new PositionStateManager();
    this.orderTracker = new OrderTracker();
    this.statePersistence = new StatePersistence();
    this.loadWarmState();
  }

  private loadWarmState(): void {
    if (this.config.mode !== "live" && this.config.mode !== "paper") return;
    const saved = this.statePersistence.load();
    if (saved) {
      for (const rawSymbol of this.config.credentials.pairSymbols) {
        const symbol = this.toPerpSymbol(rawSymbol);
        this.lastBarCloseTimes.set(symbol, saved.lastBarCloseTime);
        const posState = saved.positions.get(symbol);
        if (posState) {
          this.stateManager.updateLocalState(symbol, posState);
          this.positions.set(symbol, { side: posState.side, size: posState.size, symbol, entryPrice: posState.avgEntry > 0 ? posState.avgEntry : undefined });
        }
      }
      this.log("Warm state loaded", { activePositions: this.stateManager.getActivePositionCount(), lastBarClose: new Date(saved.lastBarCloseTime).toISOString() });
    }
  }

  private saveState(): void {
    if (this.config.mode !== "live" && this.config.mode !== "paper") return;
    const states = this.stateManager.getAllStates();
    const latestTime = Math.max(...Array.from(this.lastBarCloseTimes.values()), 0);
    this.statePersistence.save({ positions: states, lastBarCloseTime: latestTime });
  }

  async start() {
    this.subscribe();
    if (this.config.mode === "paper") {
      this.usdtBalance = this.config.paperTrading?.startingBalance ?? 10000;
      this.initialBalanceFetched = true;
    } else if (this.config.mode === "dry-run") {
      this.usdtBalance = this.config.risk.maxPositionSize;
      this.initialBalanceFetched = true;
    } else {
      this.startRestPolling();
    }
    if (!this.initialBalanceFetched) {
      this.log("Waiting for initial balance fetch...");
      const waitUntil = Date.now() + 15_000;
      while (!this.initialBalanceFetched && Date.now() < waitUntil) await new Promise(r => setTimeout(r, 250));
    }
    this.resetDailyRiskWindow();
    for (const stream of this.tickStreams) await stream.start();
    this.startPulse();
    this.startFundingPoll();
  }

  private startFundingPoll() {
    this.stopFundingPoll();
    const poll = async () => {
      for (const symbol of this.barBuilders.keys()) {
        await this.refreshPerpSignals(symbol);
        await new Promise(r => setTimeout(r, 200)); // stagger requests
      }
    };
    void poll();
    this.fundingPollInterval = setInterval(poll, 60000 * 3); // Every 3 minutes
  }

  private stopFundingPoll() {
    if (this.fundingPollInterval) { clearInterval(this.fundingPollInterval); this.fundingPollInterval = null; }
  }

  private async refreshPerpSignals(symbol: string) {
    if (this.config.mode !== "live") return;
    if (this.invalidPerpSignalSymbols.has(symbol)) return;
    try {
      const raw = symbol.replace("-PERP", "");
      const data = await (this.executor as any).v3?.getPremiumIndex?.(raw);
      if (!data) return;

      const mark = Number(data.markPrice);
      const index = Number(data.indexPrice);
      const funding = Number(data.lastFundingRate);

      this.fundingBySymbol.set(symbol, funding);
      this.premiumBySymbol.set(symbol, ((mark - index) / index) * 100);
    } catch (e) {
      if (String(e).includes("-1121")) {
        this.invalidPerpSignalSymbols.add(symbol);
        this.log(`Skipping premium polling for invalid symbol ${symbol}`, { error: String(e) });
        return;
      }
      this.log(`Failed to refresh premium data for ${symbol}`, { error: String(e) });
    }
  }

  private startPulse() {
    this.stopPulse();
    this.pulseInterval = setInterval(() => {
      const now = Date.now();
      for (const [symbol, builder] of this.barBuilders.entries()) {
        const closedBar = builder.checkTime(now);
        if (closedBar) void this.handleBarClose(symbol, closedBar).catch((error) => this.log("Bar close handler failed", { symbol, error: String(error) }));

        const htfBuilder = this.htfBuilders.get(symbol);
        if (htfBuilder) {
          const htfBar = htfBuilder.checkTime(now);
          if (htfBar) this.updateHtfBias(symbol, htfBar);
        }
      }
    }, 1000);
    if (this.pulseInterval.unref) this.pulseInterval.unref();
  }

  private stopPulse() {
    if (this.pulseInterval) { clearInterval(this.pulseInterval); this.pulseInterval = null; }
  }

  async stop() {
    this.stopPulse();
    this.stopFundingPoll();
    this.restPoller?.stop();
    for (const stream of this.tickStreams) await stream.stop();
    this.unsubscribers.forEach(off => off());
    this.unsubscribers = [];
    this.emitter.emit("stop");
  }

  private usdtBalance = 0;
  private lastBalanceLog = 0;

  private syncPositionFromState(symbol: string): void {
    const state = this.stateManager.getState(symbol);
    this.positions.set(symbol, { side: state.side, size: state.size, symbol, entryPrice: state.avgEntry > 0 ? state.avgEntry : undefined, openedAt: state.lastUpdate });
  }

  private startRestPolling(): void {
    if (!this.restPoller) return;
    this.restPoller.on("position", (position) => {
      const symbol = this.toPerpSymbol(position.symbol);
      if (!symbol) return;
      const size = parseFloat(position.positionAmt);
      const side: "long" | "short" | "flat" = size > 0 ? "long" : size < 0 ? "short" : "flat";
      const existing = this.positions.get(symbol);
      this.stateManager.updateFromRest(symbol, { positionAmt: position.positionAmt, entryPrice: position.entryPrice || "0", unrealizedProfit: position.unRealizedProfit || "0" });
      this.syncPositionFromState(symbol);
      if (side !== "flat" && existing?.strategy) this.positions.set(symbol, { ...(this.positions.get(symbol)!), strategy: existing.strategy });
      if (side !== "flat") this.orderTracker.confirmByPositionChange(symbol, side, Math.abs(size));
      else { this.stateManager.clearPendingOrder(symbol); this.partialProfitTaken.delete(symbol); }
    });

    this.restPoller.on("balance", (balances) => {
      const usdt = balances.find(b => (b.asset || "").toUpperCase() === "USDT");
      if (usdt) {
        this.usdtBalance = parseFloat(usdt.availableBalance || usdt.balance || "0");
        this.initialBalanceFetched = true;
        this.ensureDailyRiskWindow();
      }
    });

    this.restPoller.on("error", (e) => this.log("REST poller error", { error: e.message }));
    this.restPoller.start(2000);
  }

  on<K extends keyof BotRunnerEvents>(event: K, handler: BotRunnerEvents[K]): () => void {
    this.emitter.on(event, handler);
    return () => this.emitter.off(event, handler);
  }

  private subscribe() {
    for (const stream of this.tickStreams) {
      this.unsubscribers.push(stream.on("tick", (t: any) => {
        // Feed tick to executor for slippage tracking
        if ((this.executor as any).updateTick) (this.executor as any).updateTick(t);
        void this.handleTick(t).catch((error) => this.log("Tick handler failed", { symbol: t?.symbol, error: String(error) }));
      }));
      this.unsubscribers.push(stream.on("error", (e: any) => this.log("Tick stream error", { error: String(e) })));
    }
  }

  private async handleTick(tick: Tick) {
    const symbol = this.toPerpSymbol(tick.symbol);
    const builder = this.barBuilders.get(symbol);
    const htfBuilder = this.htfBuilders.get(symbol);
    if (!builder) return;

    if (htfBuilder) htfBuilder.pushTick({ ...tick, symbol });
    
    const { closedBar, currentBar } = builder.pushTick({ ...tick, symbol });
    if (closedBar) await this.handleBarClose(symbol, closedBar);
    await this.evaluateProtectiveExits(symbol, currentBar);
  }

  private updateHtfBias(symbol: string, htfBar: SyntheticBar) {
    const emaFast = this.htfEmaBySymbol.get(symbol);
    const emaSlow = this.htfEmaSlowBySymbol.get(symbol);
    if (!emaFast || !emaSlow) return;
    
    const fastVal = emaFast.update(htfBar.close);
    const slowVal = emaSlow.update(htfBar.close);
    
    let bias: "bullish" | "bearish" | "neutral" = "neutral";
    if (fastVal > slowVal && htfBar.close > fastVal) bias = "bullish";
    else if (fastVal < slowVal && htfBar.close < fastVal) bias = "bearish";
    
    this.htfBias.set(symbol, bias);
    this.log(`HTF Bias Updated for ${symbol}: ${bias} (Close: ${htfBar.close.toFixed(2)}, EMA50: ${fastVal.toFixed(2)}, EMA200: ${slowVal.toFixed(2)})`);
  }

  private getMarketContext(symbol: string, bar: SyntheticBar): StrategyContext {
    const adx = this.adxBySymbol.get(symbol)?.value || 0;
    const slope = this.slopeBySymbol.get(symbol)?.value || 0;
    
    let regime: MarketRegime = "quiet";
    if (adx > 25) regime = Math.abs(slope) > 0.05 ? "trending" : "volatile";
    else if (adx > 15) regime = "ranging";

    const recent = this.recentBars.get(symbol) || [];
    const highs = recent.map(b => b.high);
    const lows = recent.map(b => b.low);
    const recentHigh = Math.max(...highs, bar.high);
    const recentLow = Math.min(...lows, bar.low);

    // Wick rejection detection
    const barRange = bar.high - bar.low;
    const upperWick = bar.high - Math.max(bar.open, bar.close);
    const lowerWick = Math.min(bar.open, bar.close) - bar.low;
    const isWickRejection = (upperWick > barRange * 0.4) || (lowerWick > barRange * 0.4);

    return {
      regime,
      htfBias: this.htfBias.get(symbol) || "neutral",
      structure: {
        recentHigh,
        recentLow,
        lastBreakout: bar.close > recentHigh ? "up" : bar.close < recentLow ? "down" : "none",
        isWickRejection
      }
    };
  }

  private async handleBarClose(symbol: string, bar: SyntheticBar) {
    this.ensureDailyRiskWindow();
    if (this.riskHalted) return;
    const lastTime = this.lastBarCloseTimes.get(symbol) || 0;
    if (bar.endTime <= lastTime) return;
    this.lastBarCloseTimes.set(symbol, bar.endTime);
    this.pushRecentBar(symbol, bar);
    this.adxBySymbol.get(symbol)?.update(bar.high, bar.low, bar.close);
    this.atrBySymbol.get(symbol)?.update(bar.high, bar.low, bar.close);
    this.slopeBySymbol.get(symbol)?.update(bar.close);
    
    // Check pending breakouts for a pullback retest entry
    const retestCandidate = this.getRetestSignal(symbol, bar);
    if (retestCandidate) {
      this.log(`Pullback retest confirmed for ${symbol} ${retestCandidate.signal.type}`);
      await this.applySignal(symbol, retestCandidate.strategyType, retestCandidate.signal, bar, true);
    }
    
    const engines = this.engines.get(symbol);
    if (!engines) return;
    const position = this.positions.get(symbol) || { side: "flat", size: 0, symbol };
    const context = this.getMarketContext(symbol, bar);
    const candidates: SignalCandidate[] = [];

    for (const strategyType of this.strategyTypes) {
      const engine = engines.get(strategyType);
      if (!engine) continue;
      if (position.side !== "flat" && position.strategy === strategyType && engine.checkExitConditions) {
        const atr = this.atrBySymbol.get(symbol)?.value || 0;
        const stopMult = this.config.risk.atrStopMultiplier || 1.3;
        const unrealizedR = position.side === "long" ? (bar.close - (position.entryPrice ?? 0)) / (atr * stopMult) : ((position.entryPrice ?? 0) - bar.close) / (atr * stopMult);

        const exit = engine.checkExitConditions(bar);
        if (exit.shouldExit) {
           // V3.2: Only allow strategy exits (like RSI cooldown) before 1R. After 1R, let trailing stop handle it.
           if (unrealizedR < 1.0) {
              await this.closePosition(symbol, exit.reason, exit.details); return; 
           } else {
              this.log(`Ignoring strategy exit for ${symbol} because profit is > 1.0R`);
           }
        }
      }
      const signal = engine.update(bar, context);
      if (signal) candidates.push({ strategyType, signal });
    }

    const selected = this.pickBestSignal(symbol, candidates, position);
    if (!selected) return;
    const signalKey = `${symbol}-${selected.strategyType}-${selected.signal.type}-${bar.endTime}`;
    if (this.processedSignals.has(signalKey)) return;
    this.processedSignals.add(signalKey);
    if (this.processedSignals.size > 500) this.processedSignals.delete(this.processedSignals.values().next().value!);
    this.emitter.emit("signal", selected.signal, bar);
    await this.applySignal(symbol, selected.strategyType, selected.signal, bar, false);
  }

  private getRetestSignal(symbol: string, bar: SyntheticBar): SignalCandidate | null {
    const pending = this.pendingBreakouts.get(symbol);
    if (!pending) return null;

    if (Date.now() > pending.expiresAt) {
      this.pendingBreakouts.delete(symbol);
      return null;
    }

    if (
      pending.direction === "long" &&
      bar.low <= pending.level &&
      bar.close > pending.level &&
      bar.buyVolume > bar.sellVolume * 1.15
    ) {
      this.pendingBreakouts.delete(symbol);
      return { strategyType: pending.strategyType, signal: pending.signal };
    }

    if (
      pending.direction === "short" &&
      bar.high >= pending.level &&
      bar.close < pending.level &&
      bar.sellVolume > bar.buyVolume * 1.15
    ) {
      this.pendingBreakouts.delete(symbol);
      return { strategyType: pending.strategyType, signal: pending.signal };
    }

    return null;
  }

  private async applySignal(symbol: string, strategyType: StrategyType, signal: StrategySignal, bar: SyntheticBar, isRetest: boolean) {
    if (!signal || this.symbolActionLocks.has(symbol)) return;
    this.symbolActionLocks.add(symbol);
    try {
      const now = Date.now();
      const cooldownUntil = this.cooldownUntil.get(symbol) || 0;
      if (now < cooldownUntil) {
        this.logEntryBlock(symbol, "cooldown-active", { until: new Date(cooldownUntil).toISOString(), strategyType, signal: signal.type });
        return;
      }
      if (this.isOverTradeLimit(symbol)) {
        this.logEntryBlock(symbol, "max-trades-per-hour", { maxTradesPerHour: this.config.risk.maxTradesPerHour, strategyType, signal: signal.type });
        return;
      }
      const minTradeIntervalMs = this.config.risk.minTradeIntervalMs || 15000;
      const lastEntryAt = this.lastEntryAt.get(symbol) || 0;
      if (now - lastEntryAt < minTradeIntervalMs) {
        this.logEntryBlock(symbol, "min-trade-interval", { nextAllowedAt: new Date(lastEntryAt + minTradeIntervalMs).toISOString(), strategyType, signal: signal.type });
        return;
      }
      // Check executor-level symbol blacklist (e.g. -5018 notional limit)
      if ((this.executor as any).isSymbolBlacklisted?.(this.toPerpSymbol(symbol).replace("-PERP", ""))) {
        this.logEntryBlock(symbol, "executor-symbol-blacklist", { strategyType, signal: signal.type });
        return;
      }
      
      // Same-direction cooldown
      if (this.config.risk.sameDirectionCooldownMinutes && this.lastTradeSide.get(symbol) === signal.type) {
        const lastAt = this.lastTradeAt.get(symbol) || 0;
        const sameDirectionCooldownMs = this.config.risk.sameDirectionCooldownMinutes * 60000;
        if (now - lastAt < sameDirectionCooldownMs) {
          this.logEntryBlock(symbol, "same-direction-cooldown", { nextAllowedAt: new Date(lastAt + sameDirectionCooldownMs).toISOString(), strategyType, signal: signal.type });
          return;
        }
      }

      const context = this.getMarketContext(symbol, bar);
      if (this.config.risk.requireRegimeMatching && !this.isStrategyAllowedForRegime(symbol, strategyType)) {
        this.logEntryBlock(symbol, "regime-mismatch", { strategyType, signal: signal.type, regime: context.regime });
        return;
      }

      // Breakout Retest Intercept
      if (!isRetest && this.config.risk.requireStructureBreak) {
        const bars = this.recentBars.get(symbol) || [];
        const lookback = this.config.risk.structureLookbackBars || 8;
        const recent = bars.slice(-lookback - 1, -1);
        
        if (recent.length >= lookback) {
          const recentHigh = Math.max(...recent.map(b => b.high));
          const recentLow = Math.min(...recent.map(b => b.low));
          
          if (signal.type === "long" && bar.close > recentHigh) {
            this.log(`Breakout detected for ${symbol}. Waiting for pullback retest of ${recentHigh}...`);
            this.pendingBreakouts.set(symbol, {
              direction: "long",
              level: recentHigh,
              expiresAt: Date.now() + 5 * this.timeframeMs,
              strategyType,
              signal,
            });
            return;
          }
          
          if (signal.type === "short" && bar.close < recentLow) {
            this.log(`Breakdown detected for ${symbol}. Waiting for pullback retest of ${recentLow}...`);
            this.pendingBreakouts.set(symbol, {
              direction: "short",
              level: recentLow,
              expiresAt: Date.now() + 5 * this.timeframeMs,
              strategyType,
              signal,
            });
            return;
          }
        }
      }
      
      const position = this.positions.get(symbol) || { side: "flat", size: 0, symbol };
      const isNewEntry = position.side === "flat";
      const sameDirectionCount = Array.from(this.positions.values()).filter(p => p.side === signal.type).length + this.getPendingDirectionalEntryCount(signal.type);
      if (isNewEntry && sameDirectionCount >= (this.config.risk.maxDirectionalPositions || 3)) {
        this.logEntryBlock(symbol, "max-directional-positions", { sameDirectionCount, maxDirectionalPositions: this.config.risk.maxDirectionalPositions || 3, pendingDirectionalEntries: this.getPendingDirectionalEntryCount(signal.type), strategyType, signal: signal.type });
        return;
      }

      const activeCount = this.getActiveStrategyPositionCount(strategyType) + this.getPendingStrategyEntryCount(strategyType);
      const globalActiveCount = this.getGlobalActivePositionCount() + this.pendingGlobalEntries;
      const strategyMax = this.config.risk.perStrategyMaxPositions?.[strategyType] || this.config.risk.maxPositions || 1;
      const globalMax = this.config.risk.maxPositions || 1;
      if (activeCount >= strategyMax) {
        this.logEntryBlock(symbol, "max-strategy-positions", { activeCount, strategyMax, pendingStrategyEntries: this.getPendingStrategyEntryCount(strategyType), strategyType, signal: signal.type });
        return;
      }
      if (globalActiveCount >= globalMax) {
        this.logEntryBlock(symbol, "max-global-positions", { globalActiveCount, globalMax, pendingGlobalEntries: this.pendingGlobalEntries, activePositions: Array.from(this.positions.values()).filter(p => p.side !== "flat") });
        return;
      }

      const size = this.computePositionSize(symbol, bar.close);
      if (size <= 0) {
        this.logEntryBlock(symbol, "position-size-zero", { usdtBalance: this.usdtBalance, maxPositionSize: this.config.risk.maxPositionSize, strategyType, signal: signal.type });
        return;
      }

      const order: TradeInstruction = { symbol, size, leverage: this.config.risk.maxLeverage, price: bar.close, signalReason: signal.reason, timestamp: bar.endTime, side: signal.type };
      if (position.side !== "flat") {
        if (position.side === signal.type) return;
        if (position.strategy && position.strategy !== strategyType && !this.canTakeOverOwnership(position, bar.endTime)) return;
        if (!this.canFlip(bar.endTime)) return;
        await this.closePosition(symbol, `flip-${signal.type}`, { price: bar.close });
      }
      if (isNewEntry) this.reserveEntry(strategyType, signal.type);
      try {
        await this.enterPosition(symbol, strategyType, signal.type, order);
      } finally {
        if (isNewEntry) this.releaseEntryReservation(strategyType, signal.type);
      }
    } finally { this.symbolActionLocks.delete(symbol); }
  }

  private reserveEntry(strategyType: StrategyType, side: "long" | "short") {
    this.pendingGlobalEntries++;
    this.pendingStrategyEntries.set(strategyType, this.getPendingStrategyEntryCount(strategyType) + 1);
    this.pendingDirectionalEntries.set(side, this.getPendingDirectionalEntryCount(side) + 1);
  }

  private releaseEntryReservation(strategyType: StrategyType, side: "long" | "short") {
    this.pendingGlobalEntries = Math.max(0, this.pendingGlobalEntries - 1);
    this.pendingStrategyEntries.set(strategyType, Math.max(0, this.getPendingStrategyEntryCount(strategyType) - 1));
    this.pendingDirectionalEntries.set(side, Math.max(0, this.getPendingDirectionalEntryCount(side) - 1));
  }

  private getPendingStrategyEntryCount(strategyType: StrategyType) {
    return this.pendingStrategyEntries.get(strategyType) || 0;
  }

  private getPendingDirectionalEntryCount(side: "long" | "short") {
    return this.pendingDirectionalEntries.get(side) || 0;
  }

  private async enterPosition(symbol: string, strategyType: StrategyType, side: "long" | "short", order: TradeInstruction) {
    try {
      if (side === "long") await this.executor.enterLong(order); else await this.executor.enterShort(order);
      const pos: PositionState = { side, size: order.size, symbol, entryPrice: order.price, openedAt: order.timestamp, strategy: strategyType };
      this.positions.set(symbol, pos);
      this.dynamicStopBySymbol.delete(symbol);
      this.partialProfitTaken.delete(symbol);
      this.stateManager.updateLocalState(symbol, { side, size: order.size, symbol, avgEntry: order.price });
      this.tradeStats.startTrade(symbol, side, order.price, order.size, order.leverage, strategyType);
      this.lastEntryAt.set(symbol, Date.now());
      this.lastTradeSide.set(symbol, side);
      this.lastTradeAt.set(symbol, Date.now());
      this.recordTradeTimestamp(symbol);
      this.recordFlip(order.timestamp);
      this.saveState();
      this.emitter.emit("position", pos);
    } catch (e) { this.log(`Entry failed on ${symbol}`, { error: String(e) }); }
  }

  private async closePosition(symbol: string, reason: string, meta?: Record<string, unknown>) {
    const position = this.positions.get(symbol);
    if (!position || position.side === "flat") return;
    try {
      await this.executor.closePosition(symbol, reason, meta);
    } catch (error) {
      this.log(`Close failed on ${symbol}`, { reason, error: String(error) });
      return;
    }
    this.tradeStats.closeTrade(symbol, Number(meta?.price || position.entryPrice), reason);
    this.updateRiskFromLastTrade();
    this.positions.set(symbol, { side: "flat", size: 0, symbol });
    const last = this.tradeStats.getRecentTrades(1)[0];
    if (last?.pnl < 0) {
      if (this.consecutiveLosses >= 2) {
        this.cooldownUntil.set(symbol, Date.now() + 30 * 60000); // Hard 30m pause on streak
        this.log(`Hard 30m pause for ${symbol} due to 2 consecutive losses.`);
      } else if (this.config.risk.cooldownMinutesAfterLoss) {
        this.cooldownUntil.set(symbol, Date.now() + this.config.risk.cooldownMinutesAfterLoss * 60000);
        this.log(`Cooldown active for ${symbol} due to loss.`);
      }
    }
    this.partialProfitTaken.delete(symbol);
    this.saveState();
    this.emitter.emit("position", { side: "flat", size: 0, symbol });
  }

  private isOverTradeLimit(symbol: string): boolean {
    const now = Date.now();
    const hourAgo = now - HOUR_MS;
    const history = this.symbolTradeCountInLastHour.get(symbol) || [];
    const recent = history.filter(ts => ts > hourAgo);
    this.symbolTradeCountInLastHour.set(symbol, recent);
    
    if (this.config.risk.maxTradesPerHour && recent.length >= this.config.risk.maxTradesPerHour) return true;
    return false;
  }

  private recordTradeTimestamp(symbol: string) {
    const history = this.symbolTradeCountInLastHour.get(symbol) || [];
    history.push(Date.now());
    this.symbolTradeCountInLastHour.set(symbol, history);
  }

  private logEntryBlock(symbol: string, reason: string, payload?: Record<string, unknown>) {
    const key = `${symbol}:${reason}`;
    const now = Date.now();
    const last = this.entryBlockLogAt.get(key) || 0;
    if (now - last < 60_000) return;
    this.entryBlockLogAt.set(key, now);
    this.log(`Entry blocked on ${symbol}: ${reason}`, payload);
  }

  private async evaluateProtectiveExits(symbol: string, bar: SyntheticBar) {
    const position = this.positions.get(symbol);
    if (!position || position.side === "flat" || !position.entryPrice) return;
    const close = bar.close;
    const atr = this.atrBySymbol.get(symbol)?.value;
    const adx = this.adxBySymbol.get(symbol)?.value;

    if (atr && atr > 0) {
      // Risk Enhancement: Dynamic Stop Multiplier based on ADX (Wilder's Smoothing)
      // Strong trend (ADX > 30) -> Tighten stops to lock in trend. 
      // Weak trend (ADX < 20) -> Widen stops to avoid chop.
      let stopMult = this.config.risk.atrStopMultiplier || 1.5;
      if (adx && adx > 30) stopMult *= 0.8; // Tighten
      else if (adx && adx < 20) stopMult *= 1.2; // Widen

      const unrealizedR = position.side === "long" ? (close - position.entryPrice) / (atr * stopMult) : (position.entryPrice - close) / (atr * stopMult);
      
      const moveBEAtR = this.config.risk.moveSlToBeAtR || 0.7;
      const partialTPAtR = this.config.risk.atrTakeProfitR || 1.3;

      if (unrealizedR >= partialTPAtR && !this.partialProfitTaken.has(symbol)) {
        this.log(`Partial TP (50%) on ${symbol} at ${partialTPAtR}R`);
        await this.executor.closePosition(symbol, `partial-tp-${partialTPAtR}r`, { size: position.size * 0.5, price: close });
        this.partialProfitTaken.add(symbol);
        this.dynamicStopBySymbol.set(symbol, position.entryPrice); // Breakeven
      } else if (unrealizedR >= moveBEAtR && !this.dynamicStopBySymbol.has(symbol)) {
        this.log(`Moving SL to BE for ${symbol} at ${moveBEAtR}R`);
        this.dynamicStopBySymbol.set(symbol, position.entryPrice);
      }

      const stop = this.dynamicStopBySymbol.get(symbol) ?? (position.side === "long" ? (position.entryPrice ?? 0) - atr * stopMult : (position.entryPrice ?? 0) + atr * stopMult);
      if ((position.side === "long" && close <= stop) || (position.side === "short" && close >= stop)) { await this.closePosition(symbol, "atr-stop", { price: close }); return; }
      if (unrealizedR >= (this.config.risk.atrTakeProfitR || 2)) { await this.closePosition(symbol, "atr-target-hit", { price: close }); return; }
    }
  }

  private computePositionSize(symbol: string, price: number): number {
    const atr = this.atrBySymbol.get(symbol)?.value;
    const riskUsd = this.usdtBalance * ((this.config.risk.riskPerTradePct || 1) / 100);
    const maxNotional = this.config.risk.maxPositionSize;
    
    // Risk Enhancement: Volatility-Adjusted Sizing
    // If ATR is high relative to price, scale down.
    let volatilityFactor = 1.0;
    if (atr && price > 0) {
      const atrPct = (atr / price) * 100;
      if (atrPct > 2.0) volatilityFactor = 0.5; // High volatility, half size
      else if (atrPct > 1.0) volatilityFactor = 0.75;
    }

    let size = (maxNotional * volatilityFactor) / price;
    if (atr && atr > 0) {
       const stopDistance = atr * (this.config.risk.atrStopMultiplier || 1.5);
       size = Math.min(size, riskUsd / stopDistance);
    }
    return Number(size.toFixed(4));
  }

  private isStrategyAllowedForRegime(symbol: string, type: StrategyType): boolean {
    if (!this.config.risk.useMarketRegimeFilter) return true;
    const adx = this.adxBySymbol.get(symbol)?.value;
    if (adx === null || adx === undefined) return true;
    const trending = adx >= (this.config.risk.regimeAdxThreshold || 25);
    const momentum = new Set(["peach-hybrid", "watermellon", "ema-cross", "swing"]);
    return trending ? momentum.has(type) : type === "rsi-reversion";
  }

  private passesEntryConfluence(symbol: string, signal: StrategySignal, bar: SyntheticBar): boolean {
    if (!signal) return false;

    // 1. Strict Directional Volume Confirmation (1.2x Delta)
    if (signal.type === "long" && bar.buyVolume <= bar.sellVolume * 1.2) return false;
    if (signal.type === "short" && bar.sellVolume <= bar.buyVolume * 1.2) return false;

    // HTF Bias Check (only when enabled)
    if (this.config.risk.htfBiasEnabled) {
      const bias = this.htfBias.get(symbol) || "neutral";
      if (signal.type === "long" && bias !== "bullish") return false;
      if (signal.type === "short" && bias !== "bearish") return false;
    }
    
    // Funding Rate Filter (only in live mode with populated data)
    const funding = this.fundingBySymbol.get(symbol);
    if (funding !== undefined) {
      if (signal.type === "long" && funding > 0.0005) return false;
      if (signal.type === "short" && funding < -0.0005) return false;
    }

    // Premium Filter (only in live mode with populated data)
    const premium = this.premiumBySymbol.get(symbol);
    if (premium !== undefined) {
      if (signal.type === "long" && premium > 0.08) return false;
      if (signal.type === "short" && premium < -0.08) return false;
    }

    const bars = this.recentBars.get(symbol) || [];
    const avgVol = bars.length > 0
      ? bars.reduce((sum, b) => sum + b.volume, 0) / bars.length
      : bar.volume;

    // 2. Volume Spike Requirement
    if (this.config.risk.requireVolumeSpike) {
      if (bar.volume < avgVol * (this.config.risk.volumeSpikeMultiplier || 1.4)) {
        return false;
      }
    }

    // 3. Structural Break Confirmation
    if (this.config.risk.requireStructureBreak) {
      const lookback = this.config.risk.structureLookbackBars || 8;
      const recent = bars.slice(-lookback - 1, -1);
      if (recent.length >= lookback) {
        const recentHigh = Math.max(...recent.map(b => b.high));
        const recentLow = Math.min(...recent.map(b => b.low));
        if (signal.type === "long" && bar.close <= recentHigh) return false;
        if (signal.type === "short" && bar.close >= recentLow) return false;
      }
    }

    // 4. Exhaustion Candle Filter (ATR Expansion)
    const atr = this.atrBySymbol.get(symbol)?.value || 0;
    if (atr > 0) {
       const range = bar.high - bar.low;
       const body = Math.abs(bar.close - bar.open);
       
       if (range > atr * 2.2) return false;
       if (body > atr * 1.6) return false;
    }

    return true;
  }

  private pickBestSignal(symbol: string, candidates: SignalCandidate[], position: PositionState): SignalCandidate | null {
    if (candidates.length === 0) return null;
    const longs = candidates.filter(c => c.signal.type === "long");
    const shorts = candidates.filter(c => c.signal.type === "short");
    if (longs.length > 0 && shorts.length > 0) return null;
    const dir = longs.length > 0 ? "long" : "short";
    const sameDir = candidates.filter(c => c.signal.type === dir);
    if (position.side !== "flat") return sameDir.find(c => c.strategyType === position.strategy) || null;
    const priority: any = { "peach-hybrid": 5, "watermellon": 4, "ema-cross": 3, "swing": 2, "rsi-reversion": 1 };
    return sameDir.sort((a, b) => priority[b.strategyType] - priority[a.strategyType])[0];
  }

  private pushRecentBar(symbol: string, bar: SyntheticBar) {
    const list = this.recentBars.get(symbol) || [];
    list.push(bar);
    while (list.length > 20) list.shift();
    this.recentBars.set(symbol, list);
  }

  private toPerpSymbol(s: string | undefined) { const up = (s || "").toUpperCase(); return up.endsWith("-PERP") ? up : `${up}-PERP`; }
  private recordFlip(ts: number) { this.flipHistory.push(ts); }
  private canFlip(ts: number): boolean {
    const start = ts - HOUR_MS;
    this.flipHistory = this.flipHistory.filter(t => t >= start);
    return this.flipHistory.length < (this.config.risk.maxFlipsPerHour || 10);
  }
  private canTakeOverOwnership(pos: PositionState, now: number) {
    return now - (pos.openedAt || 0) >= (this.config.risk.strategyOwnershipTimeoutBars || 6) * this.timeframeMs;
  }
  private getPrimaryTimeframe() { return (this.config.strategies?.[this.strategyTypes[0] || "watermellon"] as any || this.config.strategy).timeframeMs; }
  private getStrategyConfig(type: StrategyType) { return (this.config.strategies?.[type] || this.config.strategy) as any; }
  private getActiveStrategyPositionCount(type: StrategyType) { return Array.from(this.positions.values()).filter(p => p.side !== "flat" && p.strategy === type).length; }
  private getGlobalActivePositionCount() { return Array.from(this.positions.values()).filter(p => p.side !== "flat").length; }
  private getRiskDayKey(ts = Date.now()) { return new Date(ts).toISOString().slice(0, 10); }
  private resetDailyRiskWindow() {
    this.riskDayKey = this.getRiskDayKey();
    this.dailyStartBalance = this.usdtBalance;
    this.dailyRealizedPnl = 0;
    this.dailyPeakPnl = 0;
    this.consecutiveLosses = 0;
    this.riskHalted = false;
  }
  private ensureDailyRiskWindow() { if (this.getRiskDayKey() !== this.riskDayKey) this.resetDailyRiskWindow(); }
  private updateRiskFromLastTrade() {
    const last = this.tradeStats.getRecentTrades(1)[0];
    if (!last || last.id === this.lastRiskProcessedTradeId) return;
    this.lastRiskProcessedTradeId = last.id;
    this.dailyRealizedPnl += last.pnl;
    if (last.pnl < 0) this.consecutiveLosses++; else this.consecutiveLosses = 0;
    this.dailyPeakPnl = Math.max(this.dailyPeakPnl, this.dailyRealizedPnl);
    const currentDrawdown = Math.max(0, this.dailyPeakPnl - this.dailyRealizedPnl);
    
    let maxDailyLossUsdt = this.config.risk.maxDailyLossUsdt || 999999;
    if (this.config.risk.maxDailyLossPct && this.dailyStartBalance > 0) {
      const impliedMaxLoss = this.dailyStartBalance * (this.config.risk.maxDailyLossPct / 100);
      if (impliedMaxLoss < maxDailyLossUsdt) maxDailyLossUsdt = impliedMaxLoss;
    }

    let maxDrawdownUsdt = this.config.risk.maxDrawdownUsdt || 999999;
    if (this.config.risk.maxDrawdownPct && this.dailyStartBalance > 0) {
      const impliedMaxDrawdown = this.dailyStartBalance * (this.config.risk.maxDrawdownPct / 100);
      if (impliedMaxDrawdown < maxDrawdownUsdt) maxDrawdownUsdt = impliedMaxDrawdown;
    }
    
    if (
      this.dailyRealizedPnl <= -maxDailyLossUsdt ||
      currentDrawdown >= maxDrawdownUsdt ||
      this.consecutiveLosses >= (this.config.risk.maxConsecutiveLosses || 999)
    ) {
      this.riskHalted = true;
      this.log(`Trading halted for the day. Daily PnL: ${this.dailyRealizedPnl}, Drawdown: ${currentDrawdown}, Consec Losses: ${this.consecutiveLosses}`);
    }
  }
  getPerformanceMetrics() {
    return {
      overall: this.tradeStats.getStats(),
      byStrategy: this.tradeStats.getStrategyStats(),
      daily: {
        day: this.riskDayKey,
        realizedPnl: this.dailyRealizedPnl,
        peakPnl: this.dailyPeakPnl,
        drawdown: Math.max(0, this.dailyPeakPnl - this.dailyRealizedPnl),
        halted: this.riskHalted,
      },
    };
  }
  private log(msg: string, payload?: any) { KeyManager.safeLog(`[BotRunner] ${msg}`, payload); }
}
