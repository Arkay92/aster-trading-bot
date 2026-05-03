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
type MarketRegime = "trending" | "ranging" | "unknown";
type SignalCandidate = { strategyType: StrategyType; signal: NonNullable<StrategySignal> };

const HOUR_MS = 60 * 60 * 1000;

import { TradeStatistics } from "./tradeStatistics";

export class BotRunner {
  private readonly emitter = new EventEmitter();
  private readonly barBuilders = new Map<string, VirtualBarBuilder>();
  private readonly engines = new Map<string, Map<StrategyType, Engine>>();
  private readonly restPoller: RestPoller;
  private readonly stateManager: PositionStateManager;
  private readonly orderTracker: OrderTracker;
  private readonly statePersistence: StatePersistence;
  private readonly tradeStats = new TradeStatistics();
  private positions = new Map<string, PositionState>();
  private flipHistory: number[] = [];
  private unsubscribers: Array<() => void> = [];
  private processedSignals = new Set<string>();
  private symbolActionLocks = new Set<string>();
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
      this.recentBars.set(symbol, []);
      this.adxBySymbol.set(symbol, new ADX(this.config.risk.atrLength ?? 14));
      this.atrBySymbol.set(symbol, new ATR(this.config.risk.atrLength ?? 14));
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
    
    this.restPoller = new RestPoller(config.credentials);
    this.stateManager = new PositionStateManager();
    this.orderTracker = new OrderTracker();
    this.statePersistence = new StatePersistence();
    this.loadWarmState();
  }

  private loadWarmState(): void {
    if (this.config.mode === "live") {
      this.log("Skipping warm state load in live mode");
      return;
    }
    const saved = this.statePersistence.load();
    if (saved) {
      for (const rawSymbol of this.config.credentials.pairSymbols) {
        const symbol = this.toPerpSymbol(rawSymbol);
        this.lastBarCloseTimes.set(symbol, saved.lastBarCloseTime);
        const posState = saved.positions.get(symbol);
        if (posState) {
          this.stateManager.updateLocalState(symbol, posState);
          this.positions.set(symbol, {
            side: posState.side,
            size: posState.size,
            symbol: symbol,
            entryPrice: posState.avgEntry > 0 ? posState.avgEntry : undefined,
          });
        }
      }
      this.log("Warm state loaded", {
        activePositions: this.stateManager.getActivePositionCount(),
        lastBarClose: new Date(saved.lastBarCloseTime).toISOString(),
      });
    }
  }

  private saveState(): void {
    const states = this.stateManager.getAllStates();
    const latestTime = Math.max(...Array.from(this.lastBarCloseTimes.values()), 0);
    this.statePersistence.save({
      positions: states,
      lastBarCloseTime: latestTime,
    });
  }

  async start() {
    this.subscribe();

    if (this.config.mode === "paper") {
      this.log("Paper mode: Bypassing RestPoller");
      if (this.config.paperTrading?.enabled) {
        this.usdtBalance = this.config.paperTrading.startingBalance;
      }
    } else {
      this.startRestPolling();
    }
    
    this.log("Waiting for initial balance fetch...");
    const waitUntil = Date.now() + 15_000;
    while (!this.initialBalanceFetched && Date.now() < waitUntil) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    this.resetDailyRiskWindow();
    
    this.log("Bot started with USDT balance", {
      availableUSDT: this.usdtBalance.toFixed(4),
      maxPositions: this.config.risk.maxPositions || 1,
      maxPositionSize: this.config.risk.maxPositionSize,
      maxLeverage: this.config.risk.maxLeverage,
    });
    
    for (const stream of this.tickStreams) {
      await stream.start();
    }
    const timeframeMs = this.getPrimaryTimeframe();
    this.log("BotRunner started", { timeframeMs, strategies: this.strategyTypes });
  }

  async stop() {
    this.restPoller.stop();
    for (const stream of this.tickStreams) {
      await stream.stop();
    }
    this.unsubscribers.forEach((off) => off());
    this.unsubscribers = [];
    this.emitter.emit("stop");
  }

  private usdtBalance: number = 0;
  private lastBalanceLog: number = 0;

  private syncPositionFromState(symbol: string): void {
    const state = this.stateManager.getState(symbol);
    const pos: PositionState = {
      side: state.side,
      size: state.size,
      symbol,
      entryPrice: state.avgEntry > 0 ? state.avgEntry : undefined,
      openedAt: state.lastUpdate,
    };
    this.positions.set(symbol, pos);
  }

  private startRestPolling(): void {
    this.restPoller.on("position", (position) => {
      const symbol = this.toPerpSymbol(position.symbol);
      if (!symbol) return;

      // API is source-of-truth in live mode: sync directly from REST position snapshot.
      const size = parseFloat(position.positionAmt);
      const side: "long" | "short" | "flat" = size > 0 ? "long" : size < 0 ? "short" : "flat";
      const absSize = Math.abs(size);
      const avgEntry = parseFloat(position.entryPrice || "0") || 0;
      const unrealized = parseFloat(position.unRealizedProfit || "0") || 0;

      const existing = this.positions.get(symbol);
      this.stateManager.updateFromRest(symbol, {
        positionAmt: position.positionAmt,
        entryPrice: position.entryPrice || "0",
        unrealizedProfit: position.unRealizedProfit || "0",
      });
      this.syncPositionFromState(symbol);
      if (side !== "flat" && existing?.strategy) {
        this.positions.set(symbol, {
          ...(this.positions.get(symbol) || { side: "flat", size: 0, symbol }),
          strategy: existing.strategy,
          openedAt: existing.openedAt,
        });
      } else if (side !== "flat" && !existing?.strategy) {
        this.positions.set(symbol, {
          ...(this.positions.get(symbol) || { side: "flat", size: 0, symbol }),
          strategy: "external",
          openedAt: Date.now(),
        });
      }

      if (side !== "flat") {
        this.orderTracker.confirmByPositionChange(symbol, side, absSize);
      } else {
        this.stateManager.clearPendingOrder(symbol);
      }
    });

    this.restPoller.on("balance", (balances) => {
      if (!balances || !Array.isArray(balances) || balances.length === 0) return;
      
      const usdtBalance = balances.find((b) => (b.asset || "").toUpperCase() === "USDT");
      if (usdtBalance) {
        const availableStr = usdtBalance.availableBalance || usdtBalance.balance || "0";
        const newBalance = parseFloat(availableStr);
        const now = Date.now();
        if (Math.abs(newBalance - this.usdtBalance) > 0.01 || !this.lastBalanceLog || now - this.lastBalanceLog > 60000) {
          this.log("USDT Balance", { available: newBalance.toFixed(4) });
          this.lastBalanceLog = now;
        }
        this.usdtBalance = newBalance;
        this.initialBalanceFetched = true;
        this.ensureDailyRiskWindow();
      }
    });

    this.restPoller.on("error", (error) => {
      this.log("REST poller error", { error: error.message });
    });

    this.restPoller.start(2000);
  }



  on<K extends keyof BotRunnerEvents>(event: K, handler: BotRunnerEvents[K]): () => void {
    this.emitter.on(event, handler);
    return () => this.emitter.off(event, handler);
  }

  private subscribe() {
    for (const stream of this.tickStreams) {
      const offTick = stream.on("tick", (tick: unknown) => {
        if (tick && typeof tick === "object" && "price" in tick && "timestamp" in tick && "symbol" in tick) {
          void this.handleTick(tick as Tick);
        }
      });
      const offError = stream.on("error", (error: unknown) => {
        this.log("Tick stream error", { error: String(error) });
      });
      const offClose = stream.on("close", () => this.log("Tick stream closed"));
      this.unsubscribers.push(offTick, offError, offClose);
    }
  }

  private async handleTick(tick: Tick) {
    const symbol = this.toPerpSymbol(tick.symbol);
    const builder = this.barBuilders.get(symbol);
    if (!builder) return;
    
    const { closedBar } = builder.pushTick({ ...tick, symbol });
    if (closedBar) {
      await this.evaluateProtectiveExits(symbol, closedBar);
      await this.handleBarClose(symbol, closedBar);
    }
  }

  private async handleBarClose(symbol: string, bar: SyntheticBar) {
    this.ensureDailyRiskWindow();
    if (this.riskHalted) return;
    this.pushRecentBar(symbol, bar);
    this.adxBySymbol.get(symbol)?.update(bar.high, bar.low, bar.close);
    this.atrBySymbol.get(symbol)?.update(bar.high, bar.low, bar.close);
    const engines = this.engines.get(symbol);
    if (!engines) return;

    const lastTime = this.lastBarCloseTimes.get(symbol) || 0;
    if (bar.endTime <= lastTime) return;
    this.lastBarCloseTimes.set(symbol, bar.endTime);



    const position = this.positions.get(symbol) || { side: "flat", size: 0, symbol };
    const candidates: SignalCandidate[] = [];

    for (const strategyType of this.strategyTypes) {
      const engine = engines.get(strategyType);
      if (!engine) continue;

      // Check for custom exit conditions
      if (position.side !== "flat" && position.strategy === strategyType && engine.checkExitConditions) {
        const exitSignal = engine.checkExitConditions(bar);
        if (exitSignal.shouldExit) {
          this.log(`${strategyType} exit condition triggered on ${symbol}`, { reason: exitSignal.reason });
          await this.closePosition(symbol, exitSignal.reason, exitSignal.details);
          return;
        }
      }

      const signal = engine.update(bar);
      
      if ((bar.endTime / 1000) % 10 === 0) {
        this.logIndicators(symbol, strategyType, engine, bar);
      }
      
      if (!signal) continue;
      candidates.push({ strategyType, signal });
    }

    const selected = this.pickBestSignal(symbol, candidates, position);
    if (!selected) return;

    const signalKey = `${symbol}-${selected.strategyType}-${selected.signal.type}-${bar.endTime}`;
    if (this.processedSignals.has(signalKey)) return;
    this.processedSignals.add(signalKey);
    if (this.processedSignals.size > 500) {
      this.processedSignals.delete(this.processedSignals.values().next().value!);
    }

    this.emitter.emit("signal", selected.signal, bar);
    if (!this.config.risk.quietSignalLogs) {
      this.log(`Signal emitted on ${symbol}`, {
        strategy: selected.strategyType,
        type: selected.signal.type,
        reason: selected.signal.reason,
        close: bar.close,
        regime: this.getMarketRegime(symbol),
        confirmations: candidates.filter((c) => c.signal.type === selected.signal.type).length,
      });
    }
    await this.applySignal(symbol, selected.strategyType, selected.signal, bar);
  }

  private logIndicators(symbol: string, strategyType: StrategyType, engine: Engine, bar: SyntheticBar) {
    const indicators = engine.getIndicatorValues();
    const formatted: Record<string, string> = {};
    for (const [key, val] of Object.entries(indicators)) {
      if (typeof val === "number") formatted[key] = val.toFixed(2);
      else formatted[key] = String(val);
    }
    this.log(`${strategyType} indicators updated on ${symbol}`, {
      price: bar.close.toFixed(4),
      ...formatted,
    });
  }

  private async applySignal(symbol: string, strategyType: StrategyType, signal: StrategySignal, bar: SyntheticBar) {
    if (!signal) return;
    if (this.symbolActionLocks.has(symbol)) return;
    this.symbolActionLocks.add(symbol);
    try {
      const now = Date.now();
      const minTradeIntervalMs = this.config.risk.minTradeIntervalMs ?? 15_000;
      const lastEntryTs = this.lastEntryAt.get(symbol) || 0;
      if (now - lastEntryTs < minTradeIntervalMs) return;
      if (!this.isStrategyAllowedForRegime(symbol, strategyType)) return;
      if (!this.passesEntryConfluence(symbol, signal, bar)) return;

      const engine = this.engines.get(symbol)?.get(strategyType);
      if (engine && this.config.risk.requireTrendingMarket && engine.shouldAllowTrading) {
        if (!engine.shouldAllowTrading(this.config.risk.adxThreshold)) return;
      }

      const position = this.positions.get(symbol) || { side: "flat", size: 0, symbol };
      if (position.side !== "flat" && position.strategy === "external") {
        if (!this.config.risk.quietSignalLogs) {
          this.log(`Skipping signal on ${symbol}; position is externally owned`, {
            side: position.side,
            size: position.size,
          });
        }
        return;
      }
      const activeCount = this.getActiveStrategyPositionCount(strategyType);
      const globalActiveCount = this.getGlobalActivePositionCount();
      const maxPos = this.config.risk.perStrategyMaxPositions?.[strategyType] ?? this.config.risk.maxPositions ?? 1;
      const globalMax = this.config.risk.maxPositions ?? 1;

      const { maxPositionSize, maxLeverage, positionSizePct } = this.config.risk;
      let notionalUsdt = positionSizePct ? (this.usdtBalance * (positionSizePct / 100) * 0.7 * maxLeverage) : maxPositionSize;
      notionalUsdt = Math.min(notionalUsdt, maxPositionSize);
      const size = this.computePositionSize(symbol, bar.close, notionalUsdt);
      if (size <= 0) return;

      const order = { symbol, size, leverage: maxLeverage, price: bar.close, signalReason: signal.reason, timestamp: bar.endTime, side: signal.type };

      if (signal.type === "long") {
        if (position.side !== "flat") {
          if (position.strategy && position.strategy !== strategyType) {
            if (!this.canTakeOverOwnership(position, bar.endTime)) {
              if (!this.config.risk.quietSignalLogs) {
                return this.log(`Position on ${symbol} owned by ${position.strategy}, skipping ${strategyType} signal`);
              }
              return;
            }
            this.log(`Ownership timeout reached on ${symbol}, ${strategyType} taking over from ${position.strategy}`);
            if (!this.canFlip(bar.endTime)) {
              if (!this.config.risk.quietSignalLogs) return this.log("Flip budget exhausted");
              return;
            }
            await this.closePosition(symbol, "ownership-timeout-takeover", { price: bar.close, from: position.strategy, to: strategyType });
          }
          if (position.side === "long") return;
          if (!this.canFlip(bar.endTime)) {
            if (!this.config.risk.quietSignalLogs) return this.log("Flip budget exhausted");
            return;
          }
          await this.closePosition(symbol, "flip-long", { price: bar.close });
        } else if (activeCount >= maxPos || globalActiveCount >= globalMax) {
          if (!this.config.risk.quietSignalLogs) return this.log(`Max positions (${maxPos}) reached, skipping ${symbol}`);
          return;
        }
        const currentPosition = this.positions.get(symbol) || { side: "flat", size: 0, symbol };
        if (currentPosition.side === "long") return;
        this.log(`Action on ${symbol}`, { strategy: strategyType, type: signal.type, reason: signal.reason, close: bar.close });
        await this.enterPosition(symbol, strategyType, "long", order);
      } else {
        if (position.side !== "flat") {
          if (position.strategy && position.strategy !== strategyType) {
            if (!this.canTakeOverOwnership(position, bar.endTime)) {
              if (!this.config.risk.quietSignalLogs) {
                return this.log(`Position on ${symbol} owned by ${position.strategy}, skipping ${strategyType} signal`);
              }
              return;
            }
            this.log(`Ownership timeout reached on ${symbol}, ${strategyType} taking over from ${position.strategy}`);
            if (!this.canFlip(bar.endTime)) {
              if (!this.config.risk.quietSignalLogs) return this.log("Flip budget exhausted");
              return;
            }
            await this.closePosition(symbol, "ownership-timeout-takeover", { price: bar.close, from: position.strategy, to: strategyType });
          }
          if (position.side === "short") return;
          if (!this.canFlip(bar.endTime)) {
            if (!this.config.risk.quietSignalLogs) return this.log("Flip budget exhausted");
            return;
          }
          await this.closePosition(symbol, "flip-short", { price: bar.close });
        } else if (activeCount >= maxPos || globalActiveCount >= globalMax) {
          if (!this.config.risk.quietSignalLogs) return this.log(`Max positions (${maxPos}) reached, skipping ${symbol}`);
          return;
        }
        const currentPosition = this.positions.get(symbol) || { side: "flat", size: 0, symbol };
        if (currentPosition.side === "short") return;
        this.log(`Action on ${symbol}`, { strategy: strategyType, type: signal.type, reason: signal.reason, close: bar.close });
        await this.enterPosition(symbol, strategyType, "short", order);
      }
    } finally {
      this.symbolActionLocks.delete(symbol);
    }
  }

  private async enterPosition(symbol: string, strategyType: StrategyType, side: "long" | "short", order: TradeInstruction) {
    const requiredMargin = (order.size * order.price) / order.leverage;
    if (this.usdtBalance < requiredMargin) {
      this.log(`❌ Insufficient balance for ${symbol}`, { required: requiredMargin.toFixed(4), available: this.usdtBalance.toFixed(4) });
      return;
    }

    try {
      if (side === "long") await this.executor.enterLong(order);
      else await this.executor.enterShort(order);
    } catch (error) {
      this.log(`Order failed for ${symbol}`, { error: String(error) });
      return;
    }

    const orderId = `order-${order.timestamp}`;
    this.orderTracker.trackOrder(order, orderId);
    this.stateManager.setPendingOrder(symbol, { side, size: order.size, timestamp: order.timestamp });

    if (this.config.mode === "paper" || this.config.mode === "dry-run") {
      this.orderTracker.confirmOrder(orderId);
    }

    const pos: PositionState = { side, size: order.size, symbol, entryPrice: order.price, openedAt: order.timestamp, strategy: strategyType };
    this.positions.set(symbol, pos);
    this.highestPrices.set(symbol, order.price);
    this.lowestPrices.set(symbol, order.price);
    this.dynamicStopBySymbol.delete(symbol);
    this.stateManager.updateLocalState(symbol, { side, size: order.size, symbol, avgEntry: order.price });

    const engine = this.engines.get(symbol)?.get(strategyType);
    engine?.onPositionChange?.(side);
    this.tradeStats.startTrade(symbol, side, order.price, order.size, order.leverage);
    this.lastEntryAt.set(symbol, Date.now());
    this.recordFlip(order.timestamp);
    this.emitter.emit("position", pos);
    this.saveState();
  }

  private async closePosition(symbol: string, reason: string, meta?: Record<string, unknown>) {
    const position = this.positions.get(symbol);
    if (!position || position.side === "flat") return;

    const exitPrice = Number(meta?.close || meta?.price || position.entryPrice || 0);
    await this.executor.closePosition(symbol, reason, meta);
    this.tradeStats.closeTrade(symbol, exitPrice, reason);
    this.updateRiskFromLastTrade();

    const engine = this.engines.get(symbol)?.get(position.strategy as StrategyType);
    engine?.onPositionChange?.("flat");
    this.logTradeStats();
    this.highestPrices.delete(symbol);
    this.lowestPrices.delete(symbol);
    this.dynamicStopBySymbol.delete(symbol);
    this.positions.set(symbol, { side: "flat", size: 0, symbol });
    this.stateManager.updateLocalState(symbol, { side: "flat", size: 0, symbol, avgEntry: 0 });

    if (this.config.mode === "paper") {
       const pnl = this.tradeStats.getRecentTrades(1)[0]?.pnl || 0;
       this.usdtBalance += pnl;
    }

    this.emitter.emit("position", { side: "flat", size: 0, symbol });
    this.saveState();
  }

  private logTradeStats(): void {
    const stats = this.tradeStats.getStats();
    this.log("Trade Statistics", {
      total: stats.totalTrades,
      winRate: `${stats.winRate.toFixed(1)}%`,
      pnl: stats.totalPnL.toFixed(4),
      drawdown: stats.maxDrawdown.toFixed(4),
      consecutiveLosses: this.consecutiveLosses,
      dailyPnl: this.dailyRealizedPnl.toFixed(4),
    });
  }

  private async evaluateProtectiveExits(symbol: string, bar: SyntheticBar) {
    const position = this.positions.get(symbol);
    if (!position || position.side === "flat" || !position.entryPrice) return;
    
    const { stopLossPct, takeProfitPct, emergencyStopLoss, useStopLoss } = this.config.risk;
    const { close } = bar;

    if (position.side === "long") {
      const highest = this.highestPrices.get(symbol) || close;
      if (close > highest) this.highestPrices.set(symbol, close);
    } else {
      const lowest = this.lowestPrices.get(symbol) || close;
      if (close < lowest) this.lowestPrices.set(symbol, close);
    }

    const atr = this.atrBySymbol.get(symbol)?.value ?? null;
    const atrStopMult = this.config.risk.atrStopMultiplier ?? 1.5;
    const takeProfitR = this.config.risk.atrTakeProfitR ?? 2;
    const breakevenR = this.config.risk.moveStopToBreakevenR ?? 1;
    if (atr && atr > 0) {
      let stop = this.dynamicStopBySymbol.get(symbol);
      if (stop === undefined) {
        stop = position.side === "long" ? position.entryPrice - atr * atrStopMult : position.entryPrice + atr * atrStopMult;
        this.dynamicStopBySymbol.set(symbol, stop);
      }
      const unrealizedR =
        position.side === "long"
          ? (close - position.entryPrice) / (atr * atrStopMult)
          : (position.entryPrice - close) / (atr * atrStopMult);
      if (unrealizedR >= breakevenR) {
        this.dynamicStopBySymbol.set(symbol, position.entryPrice);
        stop = position.entryPrice;
      }

      if ((position.side === "long" && close <= stop) || (position.side === "short" && close >= stop)) {
        await this.closePosition(symbol, "atr-stop", { close, stop, atr });
        return;
      }

      const target =
        position.side === "long"
          ? position.entryPrice + atr * atrStopMult * takeProfitR
          : position.entryPrice - atr * atrStopMult * takeProfitR;
      if ((position.side === "long" && close >= target) || (position.side === "short" && close <= target)) {
        await this.closePosition(symbol, "atr-take-profit", { close, target, atr });
        return;
      }
    }

    if (position.strategy === "peach-hybrid") {
      const highest = this.highestPrices.get(symbol);
      const lowest = this.lowestPrices.get(symbol);
      const currentProfit = position.side === "long" ? ((close - position.entryPrice) / position.entryPrice) * 100 : ((position.entryPrice - close) / position.entryPrice) * 100;

      if (currentProfit > 0.5) {
        const trailingStopPrice = position.side === "long" ? highest! * 0.995 : lowest! * 1.005;
        if ((position.side === "long" && close <= trailingStopPrice) || (position.side === "short" && close >= trailingStopPrice)) {
          this.log(`Trailing stop-loss triggered on ${symbol}`, { profit: currentProfit.toFixed(2) + '%' });
          await this.closePosition(symbol, "trailing-stop", { close });
          return;
        }
      }
    }

    if (emergencyStopLoss && (position.strategy === "peach-hybrid" || useStopLoss)) {
      const threshold = position.side === "long" ? position.entryPrice * (1 - emergencyStopLoss / 100) : position.entryPrice * (1 + emergencyStopLoss / 100);
      if ((position.side === "long" && close <= threshold) || (position.side === "short" && close >= threshold)) {
        await this.closePosition(symbol, "emergency-stop", { close });
        return;
      }
    }

    if (stopLossPct && useStopLoss) {
      const threshold = position.side === "long" ? position.entryPrice * (1 - stopLossPct / 100) : position.entryPrice * (1 + stopLossPct / 100);
      if ((position.side === "long" && close <= threshold) || (position.side === "short" && close >= threshold)) {
        await this.closePosition(symbol, "stop-loss", { close });
        return;
      }
    }

    if (takeProfitPct) {
      const target = position.side === "long" ? position.entryPrice * (1 + takeProfitPct / 100) : position.entryPrice * (1 - takeProfitPct / 100);
      if ((position.side === "long" && close >= target) || (position.side === "short" && close <= target)) {
        await this.closePosition(symbol, "take-profit", { close });
      }
    }
  }

  private canFlip(timestamp: number): boolean {
    const windowStart = timestamp - HOUR_MS;
    this.flipHistory = this.flipHistory.filter((t) => t >= windowStart);
    return this.flipHistory.length < (this.config.risk.maxFlipsPerHour || 10);
  }

  private recordFlip(timestamp: number) { this.flipHistory.push(timestamp); }

  private log(message: string, payload?: Record<string, unknown>) {
    this.emitter.emit("log", message, payload);
    if (payload) KeyManager.safeLog(`[BotRunner] ${message}`, payload);
    else console.log(`[BotRunner] ${message}`);
  }

  private getPrimaryTimeframe(): number {
    const first = this.strategyTypes[0] ?? "watermellon";
    const config = this.getStrategyConfig(first);
    return this.getTimeframe(config);
  }

  private getTimeframe(config: WatermellonConfig | PeachConfig | SwingConfig | EmaCrossConfig | RsiReversionConfig): number {
    return config.timeframeMs;
  }

  private getStrategyConfig(
    strategyType: StrategyType,
  ): WatermellonConfig | PeachConfig | SwingConfig | EmaCrossConfig | RsiReversionConfig {
    const strategies = this.config.strategies;
    if (strategies?.[strategyType]) {
      return strategies[strategyType] as
        | WatermellonConfig
        | PeachConfig
        | SwingConfig
        | EmaCrossConfig
        | RsiReversionConfig;
    }
    return this.config.strategy;
  }

  private getActiveStrategyPositionCount(strategyType: StrategyType): number {
    let count = 0;
    for (const pos of this.positions.values()) {
      if (pos.side !== "flat" && pos.size > 0 && pos.strategy === strategyType) {
        count++;
      }
    }
    return count;
  }

  private getGlobalActivePositionCount(): number {
    let count = 0;
    for (const pos of this.positions.values()) {
      if (pos.side !== "flat" && pos.size > 0) count++;
    }
    return count;
  }

  private canTakeOverOwnership(position: PositionState, barEndTime: number): boolean {
    const timeoutBars = this.config.risk.strategyOwnershipTimeoutBars ?? 0;
    if (timeoutBars <= 0) return false;
    if (!position.openedAt) return true;
    const elapsed = barEndTime - position.openedAt;
    return elapsed >= timeoutBars * this.timeframeMs;
  }

  private toPerpSymbol(symbol: string | undefined): string {
    const s = (symbol || "").toUpperCase();
    if (!s) return "";
    return s.endsWith("-PERP") ? s : `${s}-PERP`;
  }

  private getRiskDayKey(ts = Date.now()): string {
    return new Date(ts).toISOString().slice(0, 10);
  }

  private resetDailyRiskWindow(): void {
    this.riskDayKey = this.getRiskDayKey();
    this.dailyStartBalance = this.usdtBalance;
    this.dailyRealizedPnl = 0;
    this.dailyPeakPnl = 0;
    this.consecutiveLosses = 0;
    this.riskHalted = false;
  }

  private ensureDailyRiskWindow(): void {
    const key = this.getRiskDayKey();
    if (key !== this.riskDayKey) this.resetDailyRiskWindow();
  }

  private updateRiskFromLastTrade(): void {
    const lastTrade = this.tradeStats.getRecentTrades(1)[0];
    if (!lastTrade) return;
    if (lastTrade.id === this.lastRiskProcessedTradeId) return;
    this.lastRiskProcessedTradeId = lastTrade.id;
    this.dailyRealizedPnl += lastTrade.pnl;
    if (this.dailyRealizedPnl > this.dailyPeakPnl) this.dailyPeakPnl = this.dailyRealizedPnl;
    if (lastTrade.pnl < 0) this.consecutiveLosses += 1;
    else this.consecutiveLosses = 0;

    const maxDailyLoss = this.config.risk.maxDailyLossUsdt;
    if (typeof maxDailyLoss === "number" && maxDailyLoss > 0 && this.dailyRealizedPnl <= -maxDailyLoss) {
      this.riskHalted = true;
      this.log("Global kill switch triggered: max daily loss reached", {
        dailyRealizedPnl: this.dailyRealizedPnl.toFixed(4),
        threshold: maxDailyLoss,
      });
    }
    const maxConsecutiveLosses = this.config.risk.maxConsecutiveLosses;
    if (
      typeof maxConsecutiveLosses === "number" &&
      maxConsecutiveLosses > 0 &&
      this.consecutiveLosses >= maxConsecutiveLosses
    ) {
      this.riskHalted = true;
      this.log("Global kill switch triggered: max consecutive losses reached", {
        consecutiveLosses: this.consecutiveLosses,
        threshold: maxConsecutiveLosses,
      });
    }
  }

  private pushRecentBar(symbol: string, bar: SyntheticBar): void {
    const list = this.recentBars.get(symbol) || [];
    list.push(bar);
    const keep = Math.max(this.config.risk.structureLookbackBars ?? 5, 20);
    while (list.length > keep) list.shift();
    this.recentBars.set(symbol, list);
  }

  private getMarketRegime(symbol: string): MarketRegime {
    const adx = this.adxBySymbol.get(symbol)?.value;
    if (adx === null || adx === undefined) return "unknown";
    return adx >= (this.config.risk.regimeAdxThreshold ?? 25) ? "trending" : "ranging";
  }

  private isStrategyAllowedForRegime(symbol: string, strategyType: StrategyType): boolean {
    if (!this.config.risk.useMarketRegimeFilter) return true;
    const regime = this.getMarketRegime(symbol);
    if (regime === "unknown") return true;
    const momentum = new Set<StrategyType>(["watermellon", "peach-hybrid", "ema-cross", "swing"]);
    const meanReversion = new Set<StrategyType>(["rsi-reversion"]);
    if (regime === "trending") return momentum.has(strategyType);
    return meanReversion.has(strategyType);
  }

  private passesEntryConfluence(symbol: string, signal: StrategySignal, bar: SyntheticBar): boolean {
    if (!signal) return false;
    const bars = this.recentBars.get(symbol) || [];
    const lookback = this.config.risk.structureLookbackBars ?? 5;
    if (this.config.risk.requireStructureBreak && bars.length >= lookback + 1) {
      const prev = bars.slice(-lookback - 1, -1);
      const maxHigh = Math.max(...prev.map((b) => b.high));
      const minLow = Math.min(...prev.map((b) => b.low));
      if (signal.type === "long" && bar.close <= maxHigh) return false;
      if (signal.type === "short" && bar.close >= minLow) return false;
    }
    if (this.config.risk.requireVolumeSpike && bars.length >= lookback + 1) {
      const prev = bars.slice(-lookback - 1, -1);
      const avgVol = prev.reduce((s, b) => s + b.volume, 0) / prev.length;
      if (bar.volume < avgVol * (this.config.risk.volumeSpikeMultiplier ?? 1.3)) return false;
    }
    return true;
  }

  private computePositionSize(symbol: string, price: number, maxNotionalUsdt: number): number {
    const atr = this.atrBySymbol.get(symbol)?.value;
    const riskPct = this.config.risk.riskPerTradePct ?? 1;
    const riskUsd = this.usdtBalance * (riskPct / 100);
    let size = maxNotionalUsdt / price;
    if (atr && atr > 0) {
      const stopDistance = atr * (this.config.risk.atrStopMultiplier ?? 1.5);
      const riskSize = riskUsd / stopDistance;
      size = Math.min(size, riskSize);
    }
    return Number(size.toFixed(4));
  }

  private pickBestSignal(
    symbol: string,
    candidates: SignalCandidate[],
    position: PositionState,
  ): SignalCandidate | null {
    if (candidates.length === 0) return null;
    const longCount = candidates.filter((c) => c.signal.type === "long").length;
    const shortCount = candidates.filter((c) => c.signal.type === "short").length;
    if (longCount > 0 && shortCount > 0) return null; // conflict filter

    const direction: "long" | "short" = longCount > 0 ? "long" : "short";
    const sameDir = candidates.filter((c) => c.signal.type === direction);
    const regime = this.getMarketRegime(symbol);

    // If position already exists, only allow same-direction reinforcement from same owner strategy.
    if (position.side !== "flat") {
      return sameDir.find((c) => c.strategyType === position.strategy && c.signal.type === position.side) ?? null;
    }

    const momentumStrategies = new Set<StrategyType>(["watermellon", "peach-hybrid", "swing", "ema-cross"]);
    const meanReversionStrategies = new Set<StrategyType>(["rsi-reversion"]);

    if (regime === "ranging") {
      const meanCandidates = sameDir.filter((c) => meanReversionStrategies.has(c.strategyType));
      if (meanCandidates.length === 0) return null;
      return meanCandidates[0] ?? null;
    }

    // trending or unknown: require confirmations unless we have a high-quality peach v2 trigger
    const strongPeach = sameDir.find(
      (c) => c.strategyType === "peach-hybrid" && (c.signal.reason === "v2-long" || c.signal.reason === "v2-short"),
    );
    const momentumCandidates = sameDir.filter((c) => momentumStrategies.has(c.strategyType));
    if (!strongPeach && momentumCandidates.length < 2) return null;

    const strategyPriority: Record<StrategyType, number> = {
      "peach-hybrid": 5,
      "watermellon": 4,
      "ema-cross": 3,
      "swing": 2,
      "rsi-reversion": 1,
    };
    momentumCandidates.sort((a, b) => strategyPriority[b.strategyType] - strategyPriority[a.strategyType]);
    return strongPeach ?? momentumCandidates[0] ?? null;
  }
}
