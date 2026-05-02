import { EventEmitter } from "events";
import { WatermellonEngine } from "../watermellonEngine";
import { PeachHybridEngine } from "../peachHybridEngine";
import { SwingEngine } from "../swingEngine";
import { EmaCrossEngine } from "../emaCrossEngine";
import { RsiReversionEngine } from "../rsiReversionEngine";
import { VirtualBarBuilder } from "../virtualBarBuilder";
import { RestPoller } from "../rest/restPoller";
import { PositionStateManager } from "../state/positionState";
import { OrderTracker } from "../execution/orderTracker";
import { StatePersistence } from "../state/statePersistence";
import { KeyManager } from "../security/keyManager";
import type {
  AppConfig,
  EmaCrossConfig,
  ExecutionAdapter,
  PeachConfig,
  RsiReversionConfig,
  StrategyType,
  SwingConfig,
  PositionState,
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

type Engine = WatermellonEngine | PeachHybridEngine | SwingEngine | EmaCrossEngine | RsiReversionEngine;

const HOUR_MS = 60 * 60 * 1000;

type TradeRecord = {
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

class TradeStatistics {
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
  private tradingFrozen = false;
  private freezeUntil = 0;
  private processedSignals = new Set<string>();
  private symbolActionLocks = new Set<string>();
  private lastBarCloseTimes = new Map<string, number>();
  private readonly strategyTypes: StrategyType[];
  private readonly timeframeMs: number;
  private highestPrices = new Map<string, number>();
  private lowestPrices = new Map<string, number>();

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
    
    for (const symbol of config.credentials.pairSymbols) {
      this.barBuilders.set(symbol, new VirtualBarBuilder(timeframeMs));
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
      for (const symbol of this.config.credentials.pairSymbols) {
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
    await new Promise((resolve) => setTimeout(resolve, 2000));
    
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

  private startRestPolling(): void {
    this.restPoller.on("position", (position) => {
      const symbol = position.symbol;
      if (!symbol) return;

      const reconciled = this.stateManager.updateFromRest(symbol, {
        positionAmt: position.positionAmt,
        entryPrice: position.entryPrice || "0",
        unrealizedProfit: position.unRealizedProfit || "0",
      });

      if (!reconciled) {
        this.log(`State reconciliation failed for ${symbol}`, {
          shouldFreeze: this.stateManager.shouldFreezeTrading(symbol),
        });
        if (this.stateManager.shouldFreezeTrading(symbol)) {
          this.freezeTrading(60_000, symbol);
        }
      } else {
        const size = parseFloat(position.positionAmt);
        if (size !== 0) {
          const side = size > 0 ? "long" : "short";
          this.orderTracker.confirmByPositionChange(side, Math.abs(size));
        } else {
          this.stateManager.clearPendingOrder(symbol);
        }

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
      }
    });

    this.restPoller.on("error", (error) => {
      this.log("REST poller error", { error: error.message });
    });

    this.restPoller.start(2000);
  }

  private freezeTrading(durationMs: number, symbol?: string): void {
    this.tradingFrozen = true;
    this.freezeUntil = Date.now() + durationMs;
    this.log(`Trading frozen ${symbol ? `for ${symbol}` : ''}`, { durationMs, freezeUntil: this.freezeUntil });
    setTimeout(() => {
      this.tradingFrozen = false;
      if (symbol) {
        this.stateManager.resetReconciliationFailures(symbol);
      } else {
        this.config.credentials.pairSymbols.forEach(s => this.stateManager.resetReconciliationFailures(s));
      }
      this.log("Trading unfrozen");
    }, durationMs);
  }

  on<K extends keyof BotRunnerEvents>(event: K, handler: BotRunnerEvents[K]): () => void {
    this.emitter.on(event, handler);
    return () => this.emitter.off(event, handler);
  }

  private subscribe() {
    for (const stream of this.tickStreams) {
      const offTick = stream.on("tick", (tick: unknown) => {
        if (tick && typeof tick === "object" && "price" in tick && "timestamp" in tick && "symbol" in tick) {
          this.handleTick(tick as Tick);
        }
      });
      const offError = stream.on("error", (error: unknown) => {
        this.log("Tick stream error", { error: String(error) });
      });
      const offClose = stream.on("close", () => this.log("Tick stream closed"));
      this.unsubscribers.push(offTick, offError, offClose);
    }
  }

  private handleTick(tick: Tick) {
    const builder = this.barBuilders.get(tick.symbol);
    if (!builder) return;
    
    const { closedBar } = builder.pushTick(tick);
    if (closedBar) {
      this.evaluateProtectiveExits(tick.symbol, closedBar);
      this.handleBarClose(tick.symbol, closedBar);
    }
  }

  private handleBarClose(symbol: string, bar: SyntheticBar) {
    const engines = this.engines.get(symbol);
    if (!engines) return;

    const lastTime = this.lastBarCloseTimes.get(symbol) || 0;
    if (bar.endTime <= lastTime) return;
    this.lastBarCloseTimes.set(symbol, bar.endTime);

    if (this.tradingFrozen && Date.now() < this.freezeUntil) return;

    const position = this.positions.get(symbol) || { side: "flat", size: 0, symbol };

    for (const strategyType of this.strategyTypes) {
      const engine = engines.get(strategyType);
      if (!engine) continue;

      if (position.side !== "flat" && strategyType === "peach-hybrid" && position.strategy === "peach-hybrid") {
        const exitSignal = (engine as PeachHybridEngine).checkExitConditions(bar);
        if (exitSignal.shouldExit) {
          this.log(`Peach exit condition triggered on ${symbol}`, { reason: exitSignal.reason });
          this.closePosition(symbol, exitSignal.reason, exitSignal.details);
          return;
        }
      }

      let signal: StrategySignal;
      if (strategyType === "peach-hybrid") {
        signal = (engine as PeachHybridEngine).update(bar);
      } else if (strategyType === "swing") {
        signal = (engine as SwingEngine).update(bar.close);
      } else if (strategyType === "ema-cross") {
        signal = (engine as EmaCrossEngine).update(bar.close);
      } else if (strategyType === "rsi-reversion") {
        signal = (engine as RsiReversionEngine).update(bar.close);
      } else {
        signal = (engine as WatermellonEngine).update(bar.close);
      }
      
      if ((bar.endTime / 1000) % 10 === 0) {
        this.logIndicators(symbol, strategyType, engine, bar);
      }
      
      if (!signal) continue;

      const signalKey = `${symbol}-${strategyType}-${signal.type}-${bar.endTime}`;
      if (this.processedSignals.has(signalKey)) continue;
      this.processedSignals.add(signalKey);
      if (this.processedSignals.size > 500) {
        this.processedSignals.delete(this.processedSignals.values().next().value!);
      }

      this.emitter.emit("signal", signal, bar);
      if (!this.config.risk.quietSignalLogs) {
        this.log(`Signal emitted on ${symbol}`, {
          strategy: strategyType,
          type: signal.type,
          reason: signal.reason,
          close: bar.close,
        });
      }
      void this.applySignal(symbol, strategyType, signal, bar);
    }
  }

  private logIndicators(symbol: string, strategyType: StrategyType, engine: Engine, bar: SyntheticBar) {
    if (strategyType === "peach-hybrid") {
      const indicators = (engine as PeachHybridEngine).getIndicatorValues();
      this.log(`Peach indicators updated on ${symbol}`, {
        price: bar.close.toFixed(4),
        v1: { rsi: indicators.v1.rsi?.toFixed(2) },
        v2: { rsi: indicators.v2.rsi?.toFixed(2) },
        adx: indicators.adx?.toFixed(2),
      });
    } else if (strategyType === "swing") {
      const indicators = (engine as SwingEngine).getIndicatorValues();
      this.log(`Swing indicators updated on ${symbol}`, {
        price: bar.close.toFixed(4),
        emaTrend: indicators.emaTrend?.toFixed(2),
        rsi: indicators.rsi?.toFixed(2),
      });
    } else if (strategyType === "ema-cross") {
      this.log(`EMA Cross active on ${symbol}`, { price: bar.close.toFixed(4) });
    } else if (strategyType === "rsi-reversion") {
      this.log(`RSI Reversion active on ${symbol}`, { price: bar.close.toFixed(4) });
    } else {
      const indicators = (engine as WatermellonEngine).getIndicatorValues();
      this.log(`Watermellon indicators updated on ${symbol}`, {
        price: bar.close.toFixed(4),
        rsi: indicators.rsi?.toFixed(2),
      });
    }
  }

  private async applySignal(symbol: string, strategyType: StrategyType, signal: StrategySignal, bar: SyntheticBar) {
    if (!signal) return;
    if (this.symbolActionLocks.has(symbol)) return;
    this.symbolActionLocks.add(symbol);
    try {

      if (strategyType === "peach-hybrid") {
        const engine = this.engines.get(symbol)?.get("peach-hybrid") as PeachHybridEngine | undefined;
        if (!engine) return;
        if (this.config.risk.requireTrendingMarket && !engine.shouldAllowTrading(this.config.risk.adxThreshold)) {
          return;
        }
      }

      const position = this.positions.get(symbol) || { side: "flat", size: 0, symbol };
      const activeCount = this.getActiveStrategyPositionCount(strategyType);
      const maxPos = this.config.risk.perStrategyMaxPositions?.[strategyType] ?? this.config.risk.maxPositions ?? 1;

      const { maxPositionSize, maxLeverage, positionSizePct } = this.config.risk;
      let notionalUsdt = positionSizePct ? (this.usdtBalance * (positionSizePct / 100) * 0.7 * maxLeverage) : maxPositionSize;
      notionalUsdt = Math.min(notionalUsdt, maxPositionSize);
      
      const size = Number((notionalUsdt / bar.close).toFixed(4));
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
        } else if (activeCount >= maxPos) {
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
        } else if (activeCount >= maxPos) {
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
    this.stateManager.updateLocalState(symbol, { side, size: order.size, symbol, avgEntry: order.price });

    if (strategyType === "peach-hybrid") {
      const peach = this.engines.get(symbol)?.get("peach-hybrid") as PeachHybridEngine | undefined;
      peach?.setPosition(side);
    }
    this.tradeStats.startTrade(symbol, side, order.price, order.size, order.leverage);
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

    if (position.strategy === "peach-hybrid") {
      const peach = this.engines.get(symbol)?.get("peach-hybrid") as PeachHybridEngine | undefined;
      peach?.setPosition("flat");
    }
    this.logTradeStats();
    this.highestPrices.delete(symbol);
    this.lowestPrices.delete(symbol);
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
    this.log("📊 Trade Statistics", { total: stats.totalTrades, winRate: `${stats.winRate.toFixed(1)}%`, pnl: stats.totalPnL.toFixed(4) });
  }

  private evaluateProtectiveExits(symbol: string, bar: SyntheticBar) {
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

    if (position.strategy === "peach-hybrid") {
      const highest = this.highestPrices.get(symbol);
      const lowest = this.lowestPrices.get(symbol);
      const currentProfit = position.side === "long" ? ((close - position.entryPrice) / position.entryPrice) * 100 : ((position.entryPrice - close) / position.entryPrice) * 100;

      if (currentProfit > 0.5) {
        const trailingStopPrice = position.side === "long" ? highest! * 0.995 : lowest! * 1.005;
        if ((position.side === "long" && close <= trailingStopPrice) || (position.side === "short" && close >= trailingStopPrice)) {
          this.log(`Trailing stop-loss triggered on ${symbol}`, { profit: currentProfit.toFixed(2) + '%' });
          this.closePosition(symbol, "trailing-stop", { close });
          return;
        }
      }
    }

    if (emergencyStopLoss && (this.isPeachHybrid || useStopLoss)) {
      const threshold = position.side === "long" ? position.entryPrice * (1 - emergencyStopLoss / 100) : position.entryPrice * (1 + emergencyStopLoss / 100);
      if ((position.side === "long" && close <= threshold) || (position.side === "short" && close >= threshold)) {
        this.closePosition(symbol, "emergency-stop", { close });
        return;
      }
    }

    if (stopLossPct && useStopLoss) {
      const threshold = position.side === "long" ? position.entryPrice * (1 - stopLossPct / 100) : position.entryPrice * (1 + stopLossPct / 100);
      if ((position.side === "long" && close <= threshold) || (position.side === "short" && close >= threshold)) {
        this.closePosition(symbol, "stop-loss", { close });
        return;
      }
    }

    if (takeProfitPct) {
      const target = position.side === "long" ? position.entryPrice * (1 + takeProfitPct / 100) : position.entryPrice * (1 - takeProfitPct / 100);
      if ((position.side === "long" && close >= target) || (position.side === "short" && close <= target)) {
        this.closePosition(symbol, "take-profit", { close });
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

  private canTakeOverOwnership(position: PositionState, barEndTime: number): boolean {
    const timeoutBars = this.config.risk.strategyOwnershipTimeoutBars ?? 0;
    if (timeoutBars <= 0) return false;
    if (!position.openedAt) return true;
    const elapsed = barEndTime - position.openedAt;
    return elapsed >= timeoutBars * this.timeframeMs;
  }
}
