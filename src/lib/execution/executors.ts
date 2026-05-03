import type { TradeInstruction, ExecutionAdapter, Credentials } from "../types";
import { SignedRequestLock } from "./signedRequestLock";
import { AsterV3Client } from "./asterV3Client";

/**
 * Base Executor with common logging and history tracking
 */
export type LogEntry =
  | { type: "enter"; side: "long" | "short"; order: TradeInstruction }
  | { type: "close"; reason: string; meta?: Record<string, unknown>; timestamp: number };

export abstract class BaseExecutor {
  protected history: LogEntry[] = [];
  protected abstract readonly label: string;

  protected persist(entry: LogEntry) {
    this.history.unshift(entry);
    const typeLabel = entry.type === "enter" ? `ENTER ${entry.side.toUpperCase()}` : "CLOSE";
    const payload = entry.type === "enter" ? entry.order : entry;
    console.log(`[${this.label}] ${typeLabel}`, payload);
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
  private currentPosition: { side: "long" | "short"; size: number; entryPrice: number } | null = null;
  
  constructor(initialBalance: number) {
    super();
    this.balance = initialBalance;
    console.log(`[PaperTrading] Initialized with virtual balance: ${this.balance} USDT`);
  }

  async enterLong(order: TradeInstruction): Promise<void> {
    this.currentPosition = { side: "long", size: order.size, entryPrice: order.price };
    this.persist({ type: "enter", side: "long", order });
  }

  async enterShort(order: TradeInstruction): Promise<void> {
    this.currentPosition = { side: "short", size: order.size, entryPrice: order.price };
    this.persist({ type: "enter", side: "short", order });
  }

  async closePosition(symbol: string, reason: string, meta?: Record<string, unknown>): Promise<void> {
    if (!this.currentPosition) return;
    
    let exitPrice = this.currentPosition.entryPrice;
    if (meta) {
      if (typeof meta.close === "number") exitPrice = meta.close;
      else if (typeof meta.price === "number") exitPrice = meta.price;
    }

    const { side, size, entryPrice } = this.currentPosition;
    const pnl = side === "long" 
      ? (exitPrice - entryPrice) * size
      : (entryPrice - exitPrice) * size;
      
    this.balance += pnl;
    
    console.log(`[PaperTrading] Position closed on ${symbol}. PNL: ${pnl.toFixed(4)} USDT`);
    console.log(`[PaperTrading] Cumulative Balance: ${this.balance.toFixed(4)} USDT`);
    
    this.currentPosition = null;
    this.persist({ type: "close", reason, meta: { ...meta, symbol, pnl, newBalance: this.balance }, timestamp: Date.now() });
  }
  
  get virtualBalance(): number {
    return this.balance;
  }
}

/**
 * Live Executor: Real trade execution against Aster V3 API.
 */
export class LiveExecutor implements ExecutionAdapter {
  private readonly v3: AsterV3Client;
  private readonly shouldSetLeverage: boolean;
  private leverageSignatureBroken = false;

  constructor(credentials: Credentials) {
    this.v3 = new AsterV3Client(credentials);
    this.shouldSetLeverage = (process.env.SET_LEVERAGE_ON_ORDER || "false").toLowerCase() === "true";
  }

  private normalizeSymbol(symbol: string): string {
    return symbol.toUpperCase().replace(/-PERP$/, "");
  }

  async enterLong(order: TradeInstruction): Promise<void> {
    const symbol = this.normalizeSymbol(order.symbol);
    await this.trySetLeverage(symbol, order.leverage);
    try {
      await SignedRequestLock.run(async () =>
        this.v3.newOrder({
          symbol: symbol,
          side: "BUY",
          type: "MARKET",
          quantity: order.size.toString(),
          priceHint: order.price,
        }),
      );
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : String(error);
      if (errMessage.includes("position side")) {
        await SignedRequestLock.run(async () =>
          this.v3.newOrder({
            symbol: symbol,
            side: "BUY",
            type: "MARKET",
            quantity: order.size.toString(),
            priceHint: order.price,
            positionSide: "LONG",
          }),
        );
      } else if (errMessage.includes("Signature check failed")) {
        throw new Error(
          "Signature check failed on trade endpoint. Verify Aster account-side signer authorization for this wallet, API permissions/IP whitelist, and that account and signer match expected trading auth mode.",
        );
      } else {
        const err = error instanceof Error ? { message: error.message, stack: error.stack } : error;
        console.error(`[LiveExecutor] Failed to enter LONG on ${symbol}`, err);
        throw error;
      }
    }
    console.log(`[LiveExecutor] Entered LONG position: ${order.size} @ ${order.price} on ${symbol}`);
  }

  async enterShort(order: TradeInstruction): Promise<void> {
    const symbol = this.normalizeSymbol(order.symbol);
    await this.trySetLeverage(symbol, order.leverage);
    try {
      await SignedRequestLock.run(async () =>
        this.v3.newOrder({
          symbol: symbol,
          side: "SELL",
          type: "MARKET",
          quantity: order.size.toString(),
          priceHint: order.price,
        }),
      );
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : String(error);
      if (errMessage.includes("position side")) {
        await SignedRequestLock.run(async () =>
          this.v3.newOrder({
            symbol: symbol,
            side: "SELL",
            type: "MARKET",
            quantity: order.size.toString(),
            priceHint: order.price,
            positionSide: "SHORT",
          }),
        );
      } else if (errMessage.includes("Signature check failed")) {
        throw new Error(
          "Signature check failed on trade endpoint. Verify Aster account-side signer authorization for this wallet, API permissions/IP whitelist, and that account and signer match expected trading auth mode.",
        );
      } else {
        const err = error instanceof Error ? { message: error.message, stack: error.stack } : error;
        console.error(`[LiveExecutor] Failed to enter SHORT on ${symbol}`, err);
        throw error;
      }
    }
    console.log(`[LiveExecutor] Entered SHORT position: ${order.size} @ ${order.price} on ${symbol}`);
  }

  async closePosition(symbolArg: string, reason: string, meta?: Record<string, unknown>): Promise<void> {
    const symbol = this.normalizeSymbol(symbolArg);
    try {
      const position = await this.getCurrentPosition(symbol);
      if (!position || position.positionAmt === "0") {
        console.log("[LiveExecutor] No position to close");
        return;
      }

      const positionAmt = parseFloat(position.positionAmt);
      if (positionAmt === 0) {
        console.log("[LiveExecutor] Position amount is zero");
        return;
      }

      const side = positionAmt > 0 ? "SELL" : "BUY";
      const quantity = Math.abs(positionAmt).toString();

      try {
        await SignedRequestLock.run(async () =>
          this.v3.newOrder({
            symbol: symbol,
            side,
            type: "MARKET",
            quantity,
            priceHint: Number(meta?.price || 0),
            reduceOnly: "true"
          }),
        );
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        if (err.includes("position side")) {
          const positionSide = positionAmt > 0 ? "LONG" : "SHORT";
          await SignedRequestLock.run(async () =>
            this.v3.newOrder({
              symbol: symbol,
              side,
              type: "MARKET",
              quantity,
              priceHint: Number(meta?.price || 0),
              positionSide,
              reduceOnly: "true",
            }),
          );
        } else {
          throw error;
        }
      }

      console.log(`[LiveExecutor] Closed position on ${symbol}: ${reason}`, { positionAmt, side, quantity, ...meta });
    } catch (error) {
      const err = error instanceof Error ? { message: error.message, stack: error.stack } : error;
      console.error(`[LiveExecutor] Failed to close position on ${symbol}: ${reason}`, err);
      throw error;
    }
  }

  private async setLeverage(symbol: string, leverage: number): Promise<void> {
    await SignedRequestLock.run(async () => this.v3.changeLeverage(symbol, leverage));
  }

  private async trySetLeverage(symbol: string, leverage: number): Promise<void> {
    if (!this.shouldSetLeverage || this.leverageSignatureBroken) return;
    try {
      await this.setLeverage(symbol, leverage);
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      if (err.includes("Signature check failed")) {
        this.leverageSignatureBroken = true;
        console.warn("[LiveExecutor] changeLeverage signature check failed; disabling leverage updates and continuing with order flow");
        return;
      }
      console.warn(`[LiveExecutor] changeLeverage failed on ${symbol}: ${err}; continuing with order flow`);
    }
  }

  private async getCurrentPosition(symbol: string): Promise<{ positionAmt: string; symbol: string; entryPrice?: string } | null> {
    try {
      const account = await SignedRequestLock.run(async () => this.v3.getAccount());
      const position = account.positions?.find((p: { symbol: string; positionAmt: string; entryPrice?: string }) => p.symbol === symbol);
      if (position && position.positionAmt !== "0") {
        return {
          positionAmt: position.positionAmt.toString(),
          symbol: position.symbol,
          entryPrice: position.entryPrice?.toString()
        };
      }
      return null;
    } catch {
      try {
        const positions = await SignedRequestLock.run(async () => this.v3.getPositionRisk(symbol));
        const position = positions.find((p: { symbol: string; positionAmt: string }) => p.symbol === symbol);
        if (position && position.positionAmt !== "0") {
          return {
            positionAmt: position.positionAmt.toString(),
            symbol: position.symbol,
          };
        }
      } catch (fallbackError) {
        console.error("[LiveExecutor] Failed to get position", fallbackError);
      }
      return null;
    }
  }
}
