import type { Credentials, ExecutionAdapter, TradeInstruction } from "../types";
import { SignedRequestLock } from "./signedRequestLock";
import { AsterV3Client } from "./asterV3Client";

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
      const err = error instanceof Error ? error.message : String(error);
      if (err.includes("position side")) {
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
      } else if (err.includes("Signature check failed")) {
        throw new Error(
          "Signature check failed on trade endpoint. Verify Aster account-side signer authorization for this wallet, API permissions/IP whitelist, and that account and signer match expected trading auth mode.",
        );
      } else {
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
      const err = error instanceof Error ? error.message : String(error);
      if (err.includes("position side")) {
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
      } else if (err.includes("Signature check failed")) {
        throw new Error(
          "Signature check failed on trade endpoint. Verify Aster account-side signer authorization for this wallet, API permissions/IP whitelist, and that account and signer match expected trading auth mode.",
        );
      } else {
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
      console.error(`[LiveExecutor] Failed to close position on ${symbol}: ${reason}`, error);
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
