import { EventEmitter } from "events";
import { WatermellonEngine } from "../watermellonEngine";
import { PeachHybridEngine } from "../peachHybridEngine";
import { VirtualBarBuilder } from "../virtualBarBuilder";
import { RestPoller } from "../rest/restPoller";
import { PositionStateManager } from "../state/positionState";
import { OrderTracker } from "../execution/orderTracker";
import { StatePersistence } from "../state/statePersistence";
import { KeyManager } from "../security/keyManager";
import type {
  AppConfig,
  ExecutionAdapter,
  PeachConfig,
  PositionState,
  StrategySignal,
  SyntheticBar,
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

const HOUR_MS = 60 * 60 * 1000;

type TradeRecord = {
  id: string;
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
  private currentTrade: Partial<TradeRecord> | null = null;

  startTrade(side: "long" | "short", entryPrice: number, size: number, leverage: number): void {
    this.currentTrade = {
      id: `trade-${Date.now()}`,
      side,
      entryPrice,
      entryTime: Date.now(),
      size,
      leverage,
    };
  }

  closeTrade(exitPrice: number, reason: string): void {
    if (!this.currentTrade) return;

    const trade: TradeRecord = {
      ...this.currentTrade,
      exitPrice,
      exitTime: Date.now(),
      pnl: this.calculatePnL(this.currentTrade as TradeRecord, exitPrice),
      pnlPercent: this.calculatePnLPercent(this.currentTrade as TradeRecord, exitPrice),
      reason,
    } as TradeRecord;

    this.trades.push(trade);
    this.currentTrade = null;
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

    // Calculate drawdown
    let peak = 0;
    let maxDrawdown = 0;
    let runningPnL = 0;

    for (const trade of this.trades) {
      runningPnL += trade.pnl;
      if (runningPnL > peak) {
        peak = runningPnL;
      }
      const drawdown = peak - runningPnL;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
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
  private readonly engines = new Map<string, WatermellonEngine | PeachHybridEngine>();
  private readonly restPoller: RestPoller;
  private readonly stateManager: PositionStateManager;
  private readonly orderTracker: OrderTracker;
  private readonly statePersistence: StatePersistence;
  private readonly tradeStats = new TradeStatistics();
  private position: PositionState = { side: "flat", size: 0 };
  private flipHistory: number[] = [];
  private unsubscribers: Array<() => void> = [];
  private tradingFrozen = false;
  private freezeUntil = 0;
  private processedSignals = new Set<string>(); // Event deduplication
  private lastBarCloseTimes = new Map<string, number>();
  private readonly isPeachHybrid: boolean;
  // Trailing stop loss tracking
  private highestPrice: number | null = null; // For long positions
  private lowestPrice: number | null = null; // For short positions

  constructor(
    private readonly config: AppConfig,
    private readonly tickStreams: TickStream[],
    private readonly executor: ExecutionAdapter,
  ) {
    this.isPeachHybrid = config.strategyType === "peach-hybrid";
    const timeframeMs = this.isPeachHybrid 
      ? (config.strategy as PeachConfig).timeframeMs 
      : (config.strategy as WatermellonConfig).timeframeMs;
    
    // Initialize engines and builders for each symbol
    for (const symbol of config.credentials.pairSymbols) {
      this.barBuilders.set(symbol, new VirtualBarBuilder(timeframeMs));
      if (this.isPeachHybrid) {
        this.engines.set(symbol, new PeachHybridEngine(config.strategy as PeachConfig));
      } else {
        this.engines.set(symbol, new WatermellonEngine(config.strategy as WatermellonConfig));
      }
    }
    
    this.restPoller = new RestPoller(config.credentials);
    this.stateManager = new PositionStateManager();
    this.orderTracker = new OrderTracker();
    this.statePersistence = new StatePersistence();
    this.loadWarmState();
  }

  private loadWarmState(): void {
    const saved = this.statePersistence.load();
    if (saved) {
      // Warm state is tricky with multiple pairs, so we just use the global close time for all
      for (const symbol of this.config.credentials.pairSymbols) {
        this.lastBarCloseTimes.set(symbol, saved.lastBarCloseTime);
      }
      this.stateManager.updateLocalState(saved.position);
      this.position = {
        side: saved.position.side,
        size: saved.position.size,
        symbol: saved.position.symbol,
        entryPrice: saved.position.avgEntry > 0 ? saved.position.avgEntry : undefined,
      };
      this.log("Warm state loaded", {
        position: saved.position.side,
        size: saved.position.size,
        lastBarClose: new Date(saved.lastBarCloseTime).toISOString(),
      });
    }
  }

  private saveState(): void {
    const state = this.stateManager.getState();
    const latestTime = Math.max(...Array.from(this.lastBarCloseTimes.values()), 0);
    this.statePersistence.save({
      position: state,
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
    
    // Wait a moment for initial balance fetch
    this.log("Waiting for initial balance fetch...");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    
    // Log initial balance status - make it very visible
    if (this.usdtBalance > 0) {
      this.log(" Bot started with USDT balance", {
        availableUSDT: this.usdtBalance.toFixed(4),
        maxPositionSize: this.config.risk.maxPositionSize,
        maxLeverage: this.config.risk.maxLeverage,
      });
    } else {
      this.log(" Bot started but USDT balance is 0 or not yet loaded", {
        currentBalance: this.usdtBalance.toFixed(4),
        maxPositionSize: this.config.risk.maxPositionSize,
        maxLeverage: this.config.risk.maxLeverage,
        note: "Balance will update when REST poller receives data",
      });
    }
    
    for (const stream of this.tickStreams) {
      await stream.start();
    }
    const timeframeMs = this.isPeachHybrid 
      ? (this.config.strategy as PeachConfig).timeframeMs 
      : (this.config.strategy as WatermellonConfig).timeframeMs;
    this.log("BotRunner started", { timeframeMs });
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
      const reconciled = this.stateManager.updateFromRest({
        positionAmt: position.positionAmt,
        entryPrice: position.entryPrice || "0",
        unrealizedProfit: position.unRealizedProfit || "0",
      });

      if (!reconciled) {
        this.log("State reconciliation failed", {
          shouldFreeze: this.stateManager.shouldFreezeTrading(),
        });
        if (this.stateManager.shouldFreezeTrading()) {
          this.freezeTrading(60_000); // Freeze for 60 seconds
        }
      } else {
        // Confirm orders based on position changes
        const size = parseFloat(position.positionAmt);
        if (size !== 0) {
          const side = size > 0 ? "long" : "short";
          this.orderTracker.confirmByPositionChange(side, Math.abs(size));
        } else {
          // If position is flat, clear any pending orders
          this.stateManager.clearPendingOrder();
        }

        // Update local position state
        const state = this.stateManager.getState();
        this.position = {
          side: state.side,
          size: state.size,
          entryPrice: state.avgEntry > 0 ? state.avgEntry : undefined,
          openedAt: state.lastUpdate,
        };
      }
    });

    this.restPoller.on("balance", (balances) => {
      if (!balances || !Array.isArray(balances) || balances.length === 0) {
        this.log("⚠️ WARNING: Empty or invalid balance response", { balances });
        return;
      }
      
      // Try multiple variations of USDT asset name (case-insensitive)
      const usdtBalance = balances.find((b) => {
        const asset = (b.asset || "").toUpperCase();
        return asset === "USDT";
      });
      
      if (usdtBalance) {
        const availableStr = usdtBalance.availableBalance || usdtBalance.balance || "0";
        const totalStr = usdtBalance.balance || usdtBalance.availableBalance || "0";
        const newBalance = parseFloat(availableStr);
        const totalBalance = parseFloat(totalStr);
        
        // Only log if balance changed significantly or periodically (every 60 seconds)
        const now = Date.now();
        const balanceChanged = Math.abs(newBalance - this.usdtBalance) > 0.01;
        
        if (balanceChanged || !this.lastBalanceLog || now - this.lastBalanceLog > 60000) {
          this.log("USDT Balance", {
            available: newBalance.toFixed(4),
            total: totalBalance.toFixed(4),
            changed: balanceChanged,
          });
          this.lastBalanceLog = now;
        }
        
        this.usdtBalance = newBalance;
      } else {
        // Log warning if USDT balance not found
        this.log("⚠️ WARNING: USDT balance not found", {
          assetsFound: balances.map((b) => b.asset).slice(0, 5),
        });
      }
    });

    this.restPoller.on("error", (error) => {
      this.log("REST poller error", { error: error.message });
    });

    // Poll every 2 seconds (1-3s range as per requirements)
    this.log("Starting REST polling for position/balance reconciliation", { 
      intervalMs: 2000,
      endpoint: `${this.config.credentials.rpcUrl}/fapi/v2/account`
    });
    this.restPoller.start(2000);
  }

  private freezeTrading(durationMs: number): void {
    this.tradingFrozen = true;
    this.freezeUntil = Date.now() + durationMs;
    this.log("Trading frozen due to reconciliation failures", { durationMs, freezeUntil: this.freezeUntil });
    setTimeout(() => {
      this.tradingFrozen = false;
      this.stateManager.resetReconciliationFailures();
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
        const err = error instanceof Error ? error : new Error(String(error));
        this.log("Tick stream error", { error: err });
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
    const engine = this.engines.get(symbol);
    if (!engine) return;

    // Deduplication: prevent processing same bar multiple times
    const lastTime = this.lastBarCloseTimes.get(symbol) || 0;
    if (bar.endTime <= lastTime) {
      return;
    }
    this.lastBarCloseTimes.set(symbol, bar.endTime);

    // Check if trading is frozen
    if (this.tradingFrozen) {
      if (Date.now() < this.freezeUntil) {
        this.log(`Skipping signal on ${symbol} - trading frozen`, { freezeUntil: this.freezeUntil });
        return;
      }
      this.tradingFrozen = false;
    }

    // Check Peach exit conditions first (before checking for new signals)
    if (this.position.side !== "flat" && this.isPeachHybrid && this.position.symbol === symbol) {
      const exitSignal = (engine as PeachHybridEngine).checkExitConditions(bar);
      if (exitSignal.shouldExit) {
        this.log(`Peach exit condition triggered on ${symbol}`, { reason: exitSignal.reason, details: exitSignal.details });
        this.closePosition(symbol, exitSignal.reason, exitSignal.details);
        return;
      }
    }

    // Update engine with bar (Peach needs full bar, Watermellon just needs close)
    const signal = this.isPeachHybrid
      ? (engine as PeachHybridEngine).update(bar)
      : (engine as WatermellonEngine).update(bar.close);
    
    // Log indicator values less frequently (every 10 bars) to reduce noise
    if (this.isPeachHybrid && (bar.endTime / 1000) % 10 === 0) {
      const indicators = (engine as PeachHybridEngine).getIndicatorValues();
      const { requireTrendingMarket, adxThreshold } = this.config.risk;
      const adxReady = indicators.adx !== null;
      const marketRegimeOk = !requireTrendingMarket || (adxReady && (engine as PeachHybridEngine).shouldAllowTrading(adxThreshold));

      this.log(`Peach indicators updated on ${symbol}`, {
        price: bar.close.toFixed(4),
        volume: bar.volume.toFixed(2),
        v1: {
          emaFast: indicators.v1.emaFast?.toFixed(4),
          emaMid: indicators.v1.emaMid?.toFixed(4),
          emaSlow: indicators.v1.emaSlow?.toFixed(4),
          rsi: indicators.v1.rsi?.toFixed(2),
        },
        v2: {
          emaFast: indicators.v2.emaFast?.toFixed(4),
          emaMid: indicators.v2.emaMid?.toFixed(4),
          emaSlow: indicators.v2.emaSlow?.toFixed(4),
          rsi: indicators.v2.rsi?.toFixed(2),
        },
        adx: adxReady ? indicators.adx?.toFixed(2) : 'warming up...',
        marketRegime: requireTrendingMarket ? (adxReady ? (marketRegimeOk ? 'trending' : 'ranging') : 'warming up') : 'ignored',
      });
    } else if (!this.isPeachHybrid && (bar.endTime / 1000) % 10 === 0) {
      // Watermellon strategy logging
      const indicators = (engine as WatermellonEngine).getIndicatorValues();
      if (indicators.emaFast !== null && indicators.emaMid !== null && indicators.emaSlow !== null && indicators.rsi !== null) {
        const bullStack = indicators.emaFast > indicators.emaMid && indicators.emaMid > indicators.emaSlow;
        const bearStack = indicators.emaFast < indicators.emaMid && indicators.emaMid < indicators.emaSlow;

        this.log(`Watermellon indicators updated on ${symbol}`, {
          price: bar.close.toFixed(4),
          emaFast: indicators.emaFast.toFixed(4),
          emaMid: indicators.emaMid.toFixed(4),
          emaSlow: indicators.emaSlow.toFixed(4),
          rsi: indicators.rsi.toFixed(2),
          bullStack,
          bearStack,
        });
      }
    }
    
    if (!signal) {
      return;
    }

    // Event deduplication: create unique key for signal
    const signalKey = `${symbol}-${signal.type}-${bar.endTime}`;
    if (this.processedSignals.has(signalKey)) {
      return;
    }
    this.processedSignals.add(signalKey);
    // Clean old signals (keep last 100)
    if (this.processedSignals.size > 100) {
      const first = this.processedSignals.values().next().value;
      if (first) {
        this.processedSignals.delete(first);
      }
    }

    this.emitter.emit("signal", signal, bar);
    this.log(`Signal emitted on ${symbol}`, { type: signal.type, reason: signal.reason, close: bar.close });
    this.applySignal(symbol, signal, bar);
  }

  private applySignal(symbol: string, signal: StrategySignal, bar: SyntheticBar) {
    if (!signal) return;

    // Check market regime filter for Peach Hybrid
    if (this.isPeachHybrid) {
      const engine = this.engines.get(symbol) as PeachHybridEngine;
      const { requireTrendingMarket, adxThreshold } = this.config.risk;
      if (requireTrendingMarket && !engine.shouldAllowTrading(adxThreshold)) {
        this.log(`Skipping signal on ${symbol} - market not trending`, {
          adx: engine.getIndicatorValues().adx?.toFixed(2),
          threshold: adxThreshold,
        });
        return;
      }
    }

    const timestamp = bar.endTime;
    const { maxPositionSize, maxLeverage, positionSizePct } = this.config.risk;

    // Calculate position size: use percentage of balance if configured, otherwise fixed amount
    let notionalUsdt: number;
    if (positionSizePct && positionSizePct > 0) {
      // Use percentage of available balance, considering leverage
      // Add safety buffer: use 70% of calculated amount to account for fees, slippage, and margin requirements
      const availableForPosition = this.usdtBalance * (positionSizePct / 100) * 0.7;
      notionalUsdt = Math.min(availableForPosition * maxLeverage, maxPositionSize);
    } else {
      notionalUsdt = maxPositionSize;
    }
    
    // Convert notional USDT to base currency size, rounded to 4 decimals
    const size = Number((notionalUsdt / bar.close).toFixed(4));
    
    if (size <= 0) {
      this.log("Calculated position size is 0, skipping signal");
      return;
    }
    const order = {
      symbol,
      size,
      leverage: maxLeverage,
      price: bar.close,
      signalReason: signal.reason,
      timestamp,
      side: signal.type,
    } as const;

    if (signal.type === "long") {
      if (this.position.side !== "flat") {
        if (this.position.symbol !== symbol) return;
        if (this.position.side === "long") return;
        if (!this.canFlip(timestamp)) {
          return this.log("Flip budget exhausted, ignoring long signal");
        }
        this.closePosition(symbol, "flip-long", { price: bar.close });
      }
      this.enterPosition(symbol, "long", order);
      return;
    }

    if (signal.type === "short") {
      if (this.position.side !== "flat") {
        if (this.position.symbol !== symbol) return;
        if (this.position.side === "short") return;
        if (!this.canFlip(timestamp)) {
          return this.log("Flip budget exhausted, ignoring short signal");
        }
        this.closePosition(symbol, "flip-short", { price: bar.close });
      }
      this.enterPosition(symbol, "short", order);
    }
  }

  private async enterPosition(symbol: string, side: "long" | "short", order: Parameters<ExecutionAdapter["enterLong"]>[0]) {
    // Check balance before placing order (with leverage consideration)
    // order.size is in base asset, so we calculate notional USDT first
    const notionalUsdt = order.size * order.price;
    const requiredMargin = notionalUsdt / order.leverage;
    
    // Log balance check for debugging
    this.log("Checking balance before entering position", {
      side,
      requiredMargin: requiredMargin.toFixed(4),
      availableBalance: this.usdtBalance.toFixed(4),
      orderSize: order.size,
      leverage: order.leverage,
      sufficient: this.usdtBalance >= requiredMargin,
    });
    
    if (this.usdtBalance < requiredMargin) {
      this.log("❌ Insufficient balance to enter position", {
        required: requiredMargin.toFixed(4),
        available: this.usdtBalance.toFixed(4),
        shortfall: (requiredMargin - this.usdtBalance).toFixed(4),
        orderSize: order.size,
        leverage: order.leverage,
      });
      return;
    }

    try {
      if (side === "long") {
        await this.executor.enterLong(order);
      } else {
        await this.executor.enterShort(order);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      // Handle insufficient balance errors gracefully
      if (err.message.includes("balance") || err.message.includes("insufficient") || err.message.includes("-2019")) {
        this.log("Order failed: Insufficient balance", {
          error: err.message,
          required: requiredMargin,
          available: this.usdtBalance,
        });
        return; // Don't throw, just log and skip
      }
      // Re-throw other errors
      throw error;
    }

    // Track order for confirmation
    const orderId = `order-${order.timestamp}`;
    this.orderTracker.trackOrder(order, orderId);
    this.stateManager.setPendingOrder({
      side,
      size: order.size,
      timestamp: order.timestamp,
    });

    // Update local state optimistically
    this.position = {
      side,
      size: order.size,
      symbol,
      entryPrice: order.price,
      openedAt: order.timestamp,
    };
    // Reset trailing stop tracking
    this.highestPrice = side === "long" ? order.price : null;
    this.lowestPrice = side === "short" ? order.price : null;
    this.stateManager.updateLocalState({
      side,
      size: order.size,
      symbol,
      avgEntry: order.price,
    });

    // Update engine position state for exit logic
    if (this.isPeachHybrid) {
      const engine = this.engines.get(symbol) as PeachHybridEngine;
      engine.setPosition(side);
    }

    // Start tracking trade statistics
    this.tradeStats.startTrade(side, order.price, order.size, order.leverage);

    this.recordFlip(order.timestamp);
    this.emitter.emit("position", this.position);
  }

  private async closePosition(symbol: string, reason: string, meta?: Record<string, unknown>) {
    if (this.position.side === "flat" || this.position.symbol !== symbol) {
      return;
    }

    // Record trade exit price before closing
    const exitPrice = meta && typeof meta === 'object' && 'close' in meta
      ? Number(meta.close)
      : meta && typeof meta === 'object' && 'price' in meta
      ? Number(meta.price)
      : this.position.entryPrice || 0;

    await this.executor.closePosition(symbol, reason, meta);

    // Complete trade statistics
    this.tradeStats.closeTrade(exitPrice, reason);

    // Update engine position state
    if (this.isPeachHybrid) {
      const engine = this.engines.get(symbol) as PeachHybridEngine;
      engine.setPosition("flat");
    }

    // Log trade statistics periodically
    this.logTradeStats();

    // Reset trailing stop tracking
    this.highestPrice = null;
    this.lowestPrice = null;
    this.position = { side: "flat", size: 0 };
    
    // In paper mode, we should update our usdtBalance to match the executor's virtual balance.
    // However, BotRunner doesn't hold a direct reference to PaperExecutor's methods.
    // The executor logs its PNL, but to keep the internal BotRunner balance accurate,
    // we can calculate the local PNL and apply it to usdtBalance.
    if (this.config.mode === "paper") {
       const pnl = this.tradeStats.getRecentTrades(1)[0]?.pnl || 0;
       this.usdtBalance += pnl;
       this.log(`Virtual balance updated after trade: ${this.usdtBalance.toFixed(4)} USDT`);
    }

    this.emitter.emit("position", this.position);
  }

  private logTradeStats(): void {
    const stats = this.tradeStats.getStats();
    if (stats.totalTrades > 0) {
      this.log("📊 Trade Statistics", {
        totalTrades: stats.totalTrades,
        winRate: `${stats.winRate.toFixed(1)}%`,
        totalPnL: stats.totalPnL.toFixed(4),
        profitFactor: stats.profitFactor.toFixed(2),
        maxDrawdown: stats.maxDrawdown.toFixed(4),
        avgWin: stats.avgWin.toFixed(4),
        avgLoss: stats.avgLoss.toFixed(4),
      });
    }
  }

  private evaluateProtectiveExits(symbol: string, bar: SyntheticBar) {
    if (this.position.side === "flat" || !this.position.entryPrice || this.position.symbol !== symbol) {
      return;
    }
    const { stopLossPct, takeProfitPct, emergencyStopLoss, useStopLoss } = this.config.risk;
    const { close } = bar;

    // Update trailing stop prices
    if (this.position.side === "long") {
      if (this.highestPrice === null || close > this.highestPrice) {
        this.highestPrice = close;
      }
    } else if (this.position.side === "short") {
      if (this.lowestPrice === null || close < this.lowestPrice) {
        this.lowestPrice = close;
      }
    }

    // Trailing Stop Loss (for Peach Hybrid with profit > 0.5%)
    if (this.isPeachHybrid) {
      const trailingStopPct = 0.5; // 0.5% trailing stop
      if (this.position.side === "long" && this.highestPrice !== null) {
        const currentProfit = ((close - this.position.entryPrice) / this.position.entryPrice) * 100;
        if (currentProfit > 0.5) {
          // Only activate trailing stop after 0.5% profit
          const trailingStopPrice = this.highestPrice * (1 - trailingStopPct / 100);
          if (close <= trailingStopPrice) {
            this.log(`Trailing stop-loss triggered on ${symbol}`, { 
              trailingStopPrice: trailingStopPrice.toFixed(4), 
              highestPrice: this.highestPrice.toFixed(4),
              currentProfit: currentProfit.toFixed(2) + '%',
              close 
            });
            this.closePosition(symbol, "trailing-stop", { close, trailingStopPrice, highestPrice: this.highestPrice });
            return;
          }
        }
      } else if (this.position.side === "short" && this.lowestPrice !== null) {
        const currentProfit = ((this.position.entryPrice - close) / this.position.entryPrice) * 100;
        if (currentProfit > 0.5) {
          // Only activate trailing stop after 0.5% profit
          const trailingStopPrice = this.lowestPrice * (1 + trailingStopPct / 100);
          if (close >= trailingStopPrice) {
            this.log(`Trailing stop-loss triggered on ${symbol}`, { 
              trailingStopPrice: trailingStopPrice.toFixed(4), 
              lowestPrice: this.lowestPrice.toFixed(4),
              currentProfit: currentProfit.toFixed(2) + '%',
              close 
            });
            this.closePosition(symbol, "trailing-stop", { close, trailingStopPrice, lowestPrice: this.lowestPrice });
            return;
          }
        }
      }
    }

    // Emergency Stop Loss (always active for Peach Hybrid, or if useStopLoss is true)
    if (emergencyStopLoss && emergencyStopLoss > 0 && (this.isPeachHybrid || useStopLoss)) {
      const emergencyThreshold =
        this.position.side === "long"
          ? this.position.entryPrice * (1 - emergencyStopLoss / 100)
          : this.position.entryPrice * (1 + emergencyStopLoss / 100);

      if ((this.position.side === "long" && close <= emergencyThreshold) || (this.position.side === "short" && close >= emergencyThreshold)) {
        this.log(`Emergency stop-loss triggered on ${symbol}`, { threshold: emergencyThreshold, close, entryPrice: this.position.entryPrice });
        this.closePosition(symbol, "emergency-stop", { close, threshold: emergencyThreshold });
        return;
      }
    }

    // Regular Stop Loss (if enabled)
    if (stopLossPct && stopLossPct > 0 && useStopLoss) {
      const threshold =
        this.position.side === "long"
          ? this.position.entryPrice * (1 - stopLossPct / 100)
          : this.position.entryPrice * (1 + stopLossPct / 100);

      if ((this.position.side === "long" && close <= threshold) || (this.position.side === "short" && close >= threshold)) {
        this.log(`Stop-loss triggered on ${symbol}`, { threshold, close });
        this.closePosition(symbol, "stop-loss", { close, threshold });
        return;
      }
    }

    // Take Profit (scaled exits: take 50% at 1%, 30% at 2%, rest at 3%)
    if (takeProfitPct && takeProfitPct > 0) {
      const profitPct = this.position.side === "long"
        ? ((close - this.position.entryPrice) / this.position.entryPrice) * 100
        : ((this.position.entryPrice - close) / this.position.entryPrice) * 100;

      // For now, use simple take profit (can be enhanced with partial exits later)
      const target =
        this.position.side === "long"
          ? this.position.entryPrice * (1 + takeProfitPct / 100)
          : this.position.entryPrice * (1 - takeProfitPct / 100);

      if ((this.position.side === "long" && close >= target) || (this.position.side === "short" && close <= target)) {
        this.log(`Take-profit triggered on ${symbol}`, { target, close, profitPct: profitPct.toFixed(2) + '%' });
        this.closePosition(symbol, "take-profit", { close, target });
      }
    }
  }

  private canFlip(timestamp: number): boolean {
    const windowStart = timestamp - HOUR_MS;
    this.flipHistory = this.flipHistory.filter((t) => t >= windowStart);
    if (this.flipHistory.length >= this.config.risk.maxFlipsPerHour) {
      return false;
    }
    return true;
  }

  private recordFlip(timestamp: number) {
    this.flipHistory.push(timestamp);
  }

  private log(message: string, payload?: Record<string, unknown>) {
    this.emitter.emit("log", message, payload);
    // Save state periodically on important events
    if (message.includes("position") || message.includes("signal") || message.includes("reconciliation")) {
      this.saveState();
    }
    // Use KeyManager to ensure keys are never logged
    if (payload) {
      KeyManager.safeLog(`[BotRunner] ${message}`, payload);
    } else {
      console.log(`[BotRunner] ${message}`);
    }
  }
}

