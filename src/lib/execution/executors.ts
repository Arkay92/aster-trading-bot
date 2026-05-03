import type { TradeInstruction, ExecutionAdapter, Credentials, Tick } from "../types";
import { SignedRequestLock } from "./signedRequestLock";
import { AsterV3Client } from "./asterV3Client";

/**
 * Base Executor with common logging and history tracking
 */
export type LogEntry =
  | { type: "enter"; side: "long" | "short"; order: TradeInstruction }
  | { type: "close"; reason: string; meta?: Record<string, unknown>; timestamp: number }
  | { type: "info"; message: string; payload?: any };

export abstract class BaseExecutor {
  protected history: LogEntry[] = [];
  protected abstract readonly label: string;

  protected persist(entry: LogEntry) {
    this.history.unshift(entry);
    const typeLabel = entry.type === "enter" ? `ENTER ${entry.side.toUpperCase()}` : entry.type.toUpperCase();
    const payload = entry.type === "enter" ? entry.order : (entry.type === "info" ? entry.payload : entry);
    console.log(`[${this.label}] ${typeLabel}${entry.type === "info" ? ": " + entry.message : ""}`, payload);
  }

  get logs(): LogEntry[] {
    return this.history;
  }
}

/**
 * Dry Run Executor: Only logs actions, no real or virtual balance tracking.
 */
export class DryRunExecutor extends BaseExecutor implements ExecutionAdapter {
  protected readonly label = "DryRun";
  private lastTicks = new Map<string, Tick>();

  updateTick(tick: Tick) {
    this.lastTicks.set(tick.symbol, tick);
  }

  getCurrentTick(symbol: string): Tick | null {
    return this.lastTicks.get(symbol) || null;
  }

  async enterLong(order: TradeInstruction): Promise<void> {
    this.persist({ type: "enter", side: "long", order });
  }

  async enterShort(order: TradeInstruction): Promise<void> {
    this.persist({ type: "enter", side: "short", order });
  }

  async closePosition(symbol: string, reason: string, meta?: Record<string, unknown>): Promise<void> {
    this.persist({ type: "close", reason, meta, timestamp: Date.now() });
  }
}

/**
 * Paper Executor: Virtual balance and PNL tracking without hitting exchange API.
 */
export class PaperExecutor extends BaseExecutor implements ExecutionAdapter {
  protected readonly label = "PaperTrading";
  private balance: number;
  private positions = new Map<string, { side: "long" | "short"; size: number; entryPrice: number }>();
  private lastTicks = new Map<string, Tick>();
  
  constructor(initialBalance: number) {
    super();
    this.balance = initialBalance;
    console.log(`[PaperTrading] Initialized with virtual balance: ${this.balance} USDT`);
  }

  updateTick(tick: Tick) {
    this.lastTicks.set(tick.symbol, tick);
  }

  getCurrentTick(symbol: string): Tick | null {
    return this.lastTicks.get(symbol) || null;
  }

  async enterLong(order: TradeInstruction): Promise<void> {
    this.positions.set(this.normalizeSymbol(order.symbol), { side: "long", size: order.size, entryPrice: order.price });
    this.persist({ type: "enter", side: "long", order });
  }

  async enterShort(order: TradeInstruction): Promise<void> {
    this.positions.set(this.normalizeSymbol(order.symbol), { side: "short", size: order.size, entryPrice: order.price });
    this.persist({ type: "enter", side: "short", order });
  }

  async closePosition(symbol: string, reason: string, meta?: Record<string, unknown>): Promise<void> {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    const position = this.positions.get(normalizedSymbol);
    if (!position) return;
    
    let exitPrice = position.entryPrice;
    if (meta) {
      if (typeof meta.close === "number") exitPrice = meta.close;
      else if (typeof meta.price === "number") exitPrice = meta.price;
    }

    const { side, entryPrice } = position;
    const closeSize = meta?.size ? Math.min(Math.abs(Number(meta.size)), position.size) : position.size;
    const pnl = side === "long" 
      ? (exitPrice - entryPrice) * closeSize
      : (entryPrice - exitPrice) * closeSize;
      
    this.balance += pnl;
    
    console.log(`[PaperTrading] Position closed on ${normalizedSymbol}. PNL: ${pnl.toFixed(4)} USDT`);
    console.log(`[PaperTrading] Cumulative Balance: ${this.balance.toFixed(4)} USDT`);
    
    const remainingSize = position.size - closeSize;
    if (remainingSize > 0) this.positions.set(normalizedSymbol, { ...position, size: remainingSize });
    else this.positions.delete(normalizedSymbol);
    this.persist({ type: "close", reason, meta: { ...meta, symbol: normalizedSymbol, pnl, newBalance: this.balance, closedSize: closeSize }, timestamp: Date.now() });
  }
  
  get virtualBalance(): number {
    return this.balance;
  }

  private normalizeSymbol(symbol: string): string {
    return symbol.toUpperCase().replace(/-PERP$/, "");
  }
}

/**
 * Live Executor: Real trade execution against Aster V3 API.
 * Features: Slippage Guard & Limit-with-Market Fallback
 */
export class LiveExecutor extends BaseExecutor implements ExecutionAdapter {
  protected readonly label = "LiveExecutor";
  private readonly v3: AsterV3Client;
  private readonly shouldSetLeverage: boolean;
  private hedgeMode = false;
  private leverageSignatureBroken = false;
  private lastTicks = new Map<string, Tick>();
  private symbolMaxLeverage = new Map<string, number>();
  private symbolBlacklist = new Map<string, number>();

  constructor(credentials: Credentials, private readonly config?: any) {
    super();
    this.v3 = new AsterV3Client(credentials);
    this.shouldSetLeverage = (process.env.SET_LEVERAGE_ON_ORDER || "false").toLowerCase() === "true";
    this.hedgeMode = (process.env.HEDGE_MODE || "false").toLowerCase() === "true";
  }

  updateTick(tick: Tick) {
    this.lastTicks.set(tick.symbol, tick);
  }

  getCurrentTick(symbol: string): Tick | null {
    return this.lastTicks.get(symbol) || null;
  }

  private normalizeSymbol(symbol: string): string {
    return symbol.toUpperCase().replace(/-PERP$/, "");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isRetryableOrderError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    const lower = msg.toLowerCase();
    if (msg.includes("-5018") || msg.includes("-2019") || msg.includes("-2027")) return false;
    if (lower.includes("insufficient") || lower.includes("notional") || lower.includes("margin")) return false;
    return (
      lower.includes("timeout") ||
      lower.includes("temporar") ||
      lower.includes("network") ||
      lower.includes("socket") ||
      lower.includes("econnreset") ||
      lower.includes("rate limit") ||
      lower.includes("429") ||
      /\b5\d\d\b/.test(lower)
    );
  }

  private async withOrderRetry<T>(label: string, operation: () => Promise<T>): Promise<T> {
    const executionConfig = this.config?.risk?.execution;
    const maxRetries = Math.max(0, executionConfig?.maxOrderRetries ?? 2);
    const baseDelay = executionConfig?.orderRetryBaseDelayMs ?? 250;
    const maxDelay = executionConfig?.orderRetryMaxDelayMs ?? 5_000;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt >= maxRetries || !this.isRetryableOrderError(error)) break;
        const delay = Math.min(maxDelay, baseDelay * Math.pow(2, attempt));
        this.persist({ type: "info", message: `${label} failed; retrying`, payload: { attempt: attempt + 1, nextAttempt: attempt + 2, delayMs: delay, error: String(error) } });
        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  async enterLong(order: TradeInstruction): Promise<void> {
    await this.smartExecute(order, "BUY");
  }

  async enterShort(order: TradeInstruction): Promise<void> {
    await this.smartExecute(order, "SELL");
  }

  isSymbolBlacklisted(symbol: string): boolean {
    const until = this.symbolBlacklist.get(symbol);
    if (!until) return false;
    if (Date.now() > until) { this.symbolBlacklist.delete(symbol); return false; }
    return true;
  }

  private async smartExecute(order: TradeInstruction, side: "BUY" | "SELL"): Promise<void> {
    const symbol = this.normalizeSymbol(order.symbol);
    
    // 1. Slippage Guard
    const tick = this.getCurrentTick(order.symbol);
    const executionConfig = this.config?.risk?.execution;
    if (tick && executionConfig?.maxEntrySlippagePct) {
      const slippage = Math.abs((tick.price - order.price) / order.price) * 100;
      if (slippage > executionConfig.maxEntrySlippagePct) {
        this.persist({ type: "info", message: `Entry blocked by slippage guard`, payload: { slippage: slippage.toFixed(4) + "%", max: executionConfig.maxEntrySlippagePct + "%" } });
        throw new Error(`Slippage too high: ${slippage.toFixed(4)}%`);
      }
    }

    await this.trySetLeverage(symbol, order.leverage);

    // 2. Limit-or-Market Fallback
    if (executionConfig?.useLimitOrders) {
      try {
        this.persist({ type: "info", message: `Attempting LIMIT entry on ${symbol}` });
        const res = await this.withOrderRetry(`LIMIT entry ${symbol}`, () =>
          SignedRequestLock.run(async () => 
            this.v3.newOrder({
              symbol,
              side,
              type: "LIMIT",
              quantity: order.size.toString(),
              price: order.price.toString(),
              timeInForce: "GTC",
              ...(this.hedgeMode ? { positionSide: side === "BUY" ? "LONG" : "SHORT" } : {}),
            })
          )
        );
        
        const orderId = (res as any).orderId;
        if (!orderId) throw new Error("No orderId returned from LIMIT order");

        // Wait for fill
        const timeout = executionConfig.limitOrderTimeoutMs || 500;
        await new Promise(r => setTimeout(r, timeout));

        // Check if filled
        const openOrders = await SignedRequestLock.run(() => this.v3.getOpenOrders(symbol));
        const isStillOpen = openOrders.some((o: any) => o.orderId === orderId);

        if (isStillOpen) {
          this.persist({ type: "info", message: `LIMIT order timed out, falling back to MARKET` });
          await this.withOrderRetry(`Cancel stale LIMIT ${symbol}`, () => SignedRequestLock.run(() => this.v3.cancelOrder(symbol, orderId)));
          // Fall through to MARKET
        } else {
          this.persist({ type: "info", message: `LIMIT order FILLED on ${symbol}` });
          return;
        }
      } catch (error) {
        this.persist({ type: "info", message: `LIMIT entry failed, falling back to MARKET`, payload: String(error) });
      }
    }

    // 3. Market Order
    try {
      await this.withOrderRetry(`MARKET entry ${symbol}`, () =>
        SignedRequestLock.run(async () =>
          this.v3.newOrder({
            symbol: symbol,
            side: side,
            type: "MARKET",
            quantity: order.size.toString(),
            priceHint: order.price,
            ...(this.hedgeMode ? { positionSide: side === "BUY" ? "LONG" : "SHORT" } : {}),
          }),
        )
      );
      this.persist({ type: "enter", side: side === "BUY" ? "long" : "short", order });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("-5018")) {
        const blacklistUntil = Date.now() + 4 * 60 * 60 * 1000;
        this.symbolBlacklist.set(symbol, blacklistUntil);
        console.warn(`[LiveExecutor] ${symbol} blacklisted for 4h — notional limit reached (-5018)`);
      }
      console.error(`[LiveExecutor] Failed to enter ${side} on ${symbol}`, error);
      throw error;
    }
  }

  async closePosition(symbolArg: string, reason: string, meta?: Record<string, unknown>): Promise<void> {
    const symbol = this.normalizeSymbol(symbolArg);
    try {
      const position = await this.getCurrentPosition(symbol);
      if (!position || position.positionAmt === "0") return;

      const positionAmt = parseFloat(position.positionAmt);
      const side = positionAmt > 0 ? "SELL" : "BUY";
      const quantity = meta?.size ? Math.abs(Number(meta.size)).toString() : Math.abs(positionAmt).toString();

      const closeOrder = {
        symbol: symbol,
        side: side as "BUY" | "SELL",
        type: "MARKET" as const,
        quantity,
        priceHint: Number(meta?.price || 0),
        ...(this.hedgeMode ? { positionSide: positionAmt > 0 ? "LONG" as const : "SHORT" as const } : {}),
      };

      try {
        await this.withOrderRetry(`MARKET close ${symbol}`, () =>
          SignedRequestLock.run(async () =>
            this.v3.newOrder({
              ...closeOrder,
              reduceOnly: "true",
            }),
          )
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (!msg.includes("-2022")) throw error;

        const refreshed = await this.getCurrentPosition(symbol);
        if (!refreshed || refreshed.positionAmt === "0") {
          this.persist({ type: "info", message: `Close treated as complete; ${symbol} is already flat after reduceOnly rejection`, payload: { reason, error: msg } });
        } else {
          const refreshedAmt = parseFloat(refreshed.positionAmt);
          const refreshedSide: "BUY" | "SELL" = refreshedAmt > 0 ? "SELL" : "BUY";
          const refreshedQuantity = meta?.size ? Math.min(Math.abs(Number(meta.size)), Math.abs(refreshedAmt)).toString() : Math.abs(refreshedAmt).toString();
          this.persist({ type: "info", message: `Retrying ${symbol} close without reduceOnly after -2022`, payload: { reason, side: refreshedSide, quantity: refreshedQuantity } });
          await this.withOrderRetry(`MARKET close ${symbol} without reduceOnly`, () =>
            SignedRequestLock.run(async () =>
              this.v3.newOrder({
                ...closeOrder,
                side: refreshedSide,
                quantity: refreshedQuantity,
              }),
            )
          );
        }
      }

      this.persist({ type: "close", reason, meta, timestamp: Date.now() });
    } catch (error) {
      console.error(`[LiveExecutor] Failed to close position on ${symbol}: ${reason}`, error);
      throw error;
    }
  }

  private async trySetLeverage(symbol: string, desiredLeverage: number): Promise<void> {
    if (!this.shouldSetLeverage || this.leverageSignatureBroken) return;
    const cachedMax = this.symbolMaxLeverage.get(symbol);
    let leverage = cachedMax ? Math.min(desiredLeverage, cachedMax) : desiredLeverage;
    while (leverage >= 1) {
      try {
        await SignedRequestLock.run(async () => this.v3.changeLeverage(symbol, leverage));
        if (leverage < desiredLeverage) {
          this.symbolMaxLeverage.set(symbol, leverage);
          console.warn(`[LiveExecutor] ${symbol} leverage capped at ${leverage}x (wanted ${desiredLeverage}x)`);
        }
        return;
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        if (err.includes("Signature check failed")) { this.leverageSignatureBroken = true; return; }
        if (err.includes("-2027") || err.includes("exceeds the maximum")) {
          leverage = Math.floor(leverage / 2);
          if (leverage < 1) { console.error(`[LiveExecutor] Could not set leverage on ${symbol}`); return; }
          console.warn(`[LiveExecutor] Leverage too high on ${symbol}, retrying at ${leverage}x`);
          continue;
        }
        console.warn(`[LiveExecutor] changeLeverage failed on ${symbol}: ${err}`);
        return;
      }
    }
  }

  private async getCurrentPosition(symbol: string): Promise<{ positionAmt: string; symbol: string; entryPrice?: string } | null> {
    try {
      const account = await SignedRequestLock.run(async () => this.v3.getAccount());
      const position = account.positions?.find((p: any) => p.symbol === symbol);
      if (position && position.positionAmt !== "0") return position;
      return null;
    } catch {
      return null;
    }
  }
}
