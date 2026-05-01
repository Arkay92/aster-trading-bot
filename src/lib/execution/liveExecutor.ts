import { AsterDEX } from "asterdex-sdk";
import { ethers } from "ethers";
import type { Credentials, ExecutionAdapter, TradeInstruction } from "../types";

export class LiveExecutor implements ExecutionAdapter {
  private readonly futuresClient: ReturnType<AsterDEX["createFuturesClient"]>;

  constructor(credentials: Credentials) {

    const isTestnet = credentials.rpcUrl.includes("test") || credentials.wsUrl.includes("test");
    const sdk = new AsterDEX({
      baseUrl: {
        spot: credentials.rpcUrl.replace("fapi", "api"),
        futures: credentials.rpcUrl,
        websocket: credentials.wsUrl,
      },
    });

    const wallet = new ethers.Wallet(credentials.privateKey);
    const signerAddress = wallet.address;
    
    // User address is API_KEY if it's an address, else assume same as signer
    const userAddress =
      credentials.apiKey && credentials.apiKey.startsWith("0x") && credentials.apiKey.length === 42
        ? credentials.apiKey
        : signerAddress;

    this.futuresClient = sdk.createFuturesClient(userAddress, signerAddress, credentials.privateKey);
  }

  private normalizeSymbol(symbol: string): string {
    return symbol.toUpperCase().replace(/-PERP$/, "");
  }

  async enterLong(order: TradeInstruction): Promise<void> {
    const symbol = this.normalizeSymbol(order.symbol);
    await this.setLeverage(symbol, order.leverage);
    try {
      await this.futuresClient.newOrder({
        symbol: symbol,
        side: "BUY",
        type: "MARKET",
        quantity: order.size.toString(),
      });
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      if (err.includes("position side")) {
        await this.futuresClient.newOrder({
          symbol: symbol,
          side: "BUY",
          type: "MARKET",
          quantity: order.size.toString(),
          positionSide: "LONG",
        });
      } else {
        throw error;
      }
    }
    console.log(`[LiveExecutor] Entered LONG position: ${order.size} @ ${order.price} on ${symbol}`);
  }

  async enterShort(order: TradeInstruction): Promise<void> {
    const symbol = this.normalizeSymbol(order.symbol);
    await this.setLeverage(symbol, order.leverage);
    try {
      await this.futuresClient.newOrder({
        symbol: symbol,
        side: "SELL",
        type: "MARKET",
        quantity: order.size.toString(),
      });
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      if (err.includes("position side")) {
        await this.futuresClient.newOrder({
          symbol: symbol,
          side: "SELL",
          type: "MARKET",
          quantity: order.size.toString(),
          positionSide: "SHORT",
        });
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
        await this.futuresClient.newOrder({
          symbol: symbol,
          side,
          type: "MARKET",
          quantity,
          reduceOnly: "true",
        } as any);
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        if (err.includes("position side")) {
          const positionSide = positionAmt > 0 ? "LONG" : "SHORT";
          await this.futuresClient.newOrder({
            symbol: symbol,
            side,
            type: "MARKET",
            quantity,
            positionSide,
            reduceOnly: "true",
          } as any);
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
    await this.futuresClient.changeLeverage({
      symbol: symbol,
      leverage,
    });
  }

  private async getCurrentPosition(symbol: string): Promise<{ positionAmt: string; symbol: string; entryPrice?: string } | null> {
    try {
      const account = await this.futuresClient.getAccount();
      const position = account.positions?.find((p: any) => p.symbol === symbol);
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
        const positions = await this.futuresClient.getPositionRisk(symbol);
        const position = positions.find((p: any) => p.symbol === symbol);
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
