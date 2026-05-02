import type { Credentials } from "../types";
import { SignedRequestLock } from "../execution/signedRequestLock";
import { AsterV3Client } from "../execution/asterV3Client";

type AsterPositionResponse = {
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
  marginType: string;
  isolatedMargin: string;
  positionSide: string;
  symbol: string;
};

type AsterBalanceResponse = {
  asset: string;
  balance: string;
  availableBalance: string;
  maxWithdrawAmount: string;
};

type PositionLike = {
  symbol: string;
  positionAmt: string;
  entryPrice?: string;
  markPrice?: string;
  unRealizedProfit?: string;
  liquidationPrice?: string;
  leverage?: string;
  marginType?: string;
  isolatedMargin?: string;
  positionSide?: string;
};

export class RestPoller {
  private readonly symbols: string[];
  private intervalId: NodeJS.Timeout | null = null;
  private onPositionUpdate?: (position: AsterPositionResponse) => void;
  private onBalanceUpdate?: (balance: AsterBalanceResponse[]) => void;
  private onError?: (error: Error) => void;
  private lastSuccessLog: number = 0;
  private readonly v3: AsterV3Client;

  constructor(credentials: Credentials) {
    this.symbols = credentials.pairSymbols.map((s) => this.normalizeSymbol(s));
    this.v3 = new AsterV3Client(credentials);
  }

  private normalizeSymbol(symbol: string): string {
    return symbol.toUpperCase().replace(/-PERP$/, "");
  }

  start(intervalMs: number = 2000): void {
    this.stop();
    this.intervalId = setInterval(() => {
      this.poll();
    }, intervalMs);
    this.poll();
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  on(event: "position", handler: (position: AsterPositionResponse) => void): void;
  on(event: "balance", handler: (balance: AsterBalanceResponse[]) => void): void;
  on(event: "error", handler: (error: Error) => void): void;
  on(event: string, handler: unknown): void {
    if (event === "position") {
      this.onPositionUpdate = handler as (position: AsterPositionResponse) => void;
    } else if (event === "balance") {
      this.onBalanceUpdate = handler as (balance: AsterBalanceResponse[]) => void;
    } else if (event === "error") {
      this.onError = handler as (error: Error) => void;
    }
  }

  private async poll(): Promise<void> {
    try {
      await Promise.all([
        this.fetchPosition().catch((err) => {
          console.error(`[RestPoller] Position fetch error:`, err);
          throw err;
        }),
        this.fetchBalance().catch((err) => {
          console.error(`[RestPoller] Balance fetch error:`, err.message);
          throw err;
        }),
      ]);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error(`[RestPoller] Poll error:`, err);
      this.onError?.(err);
    }
  }

  private async fetchPosition(): Promise<void> {
    try {
      const account = await SignedRequestLock.run(async () => this.v3.getAccount());
      // Find any open position in our symbols
      let pos = account.positions?.find((p: PositionLike) => this.symbols.includes(p.symbol) && p.positionAmt !== "0");
      // If none open, default to the first symbol to report flat
      if (!pos && this.symbols.length > 0) {
        pos = account.positions?.find((p: PositionLike) => p.symbol === this.symbols[0]);
      }
      
      if (pos) {
        this.onPositionUpdate?.(pos as AsterPositionResponse);
      } else {
        this.onPositionUpdate?.({
          positionAmt: "0",
          entryPrice: "0",
          markPrice: "0",
          unRealizedProfit: "0",
          liquidationPrice: "0",
          leverage: "1",
          marginType: "cross",
          isolatedMargin: "0",
          positionSide: "BOTH",
          symbol: this.symbols[0] || "UNKNOWN",
        });
      }

      const now = Date.now();
      if (!this.lastSuccessLog || now - this.lastSuccessLog > 60000) {
        console.log(`[RestPoller] Position poll successful (symbol: ${pos?.symbol || this.symbols[0]}, position: ${pos?.positionAmt || "0"})`);
        this.lastSuccessLog = now;
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.warn(`[RestPoller] Account endpoint failed, trying fallback: ${err.message}`);
      try {
        const position = await SignedRequestLock.run(async () => this.v3.getPositionRisk(this.symbols[0]));
        let pos = position.find((p: PositionLike) => this.symbols.includes(p.symbol) && p.positionAmt !== "0");
        if (!pos && this.symbols.length > 0) {
          pos = position.find((p: PositionLike) => p.symbol === this.symbols[0]);
        }
        if (pos) {
          this.onPositionUpdate?.(pos as AsterPositionResponse);
        } else {
          this.onPositionUpdate?.({
            positionAmt: "0",
            entryPrice: "0",
            markPrice: "0",
            unRealizedProfit: "0",
            liquidationPrice: "0",
            leverage: "1",
            marginType: "cross",
            isolatedMargin: "0",
            positionSide: "BOTH",
            symbol: this.symbols[0] || "UNKNOWN",
          });
        }
      } catch (fallbackError) {
        const fallbackErr = fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError));
        console.error(`[RestPoller] Both endpoints failed: ${fallbackErr.message}`);
        this.onError?.(fallbackErr);
      }
    }
  }

  private async fetchBalance(): Promise<void> {
    try {
      const balance = await SignedRequestLock.run(async () => this.v3.getBalance());
      
      if (!Array.isArray(balance)) {
        console.error(`[RestPoller] Balance response is not an array:`, typeof balance);
        throw new Error("Balance response is not an array");
      }
      
      if (!Array.isArray(balance) || balance.length === 0) {
        console.warn(`[RestPoller] Balance response is empty or invalid`);
        return;
      }
      
      if (this.onBalanceUpdate) {
        this.onBalanceUpdate(balance as AsterBalanceResponse[]);
      } else {
        console.error(`[RestPoller] onBalanceUpdate handler is not set!`);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.warn(`[RestPoller] Balance endpoint failed: ${err.message}`);
      
      try {
        const account = await SignedRequestLock.run(async () => this.v3.getAccount());
        
        if (account.assets && Array.isArray(account.assets)) {
          type AccountAsset = { asset: string; availableBalance?: string; balance?: string; walletBalance?: string; maxWithdrawAmount?: string };
          const balances: AsterBalanceResponse[] = account.assets.map((asset: AccountAsset) => ({
            asset: asset.asset,
            balance: asset.balance || asset.walletBalance || "0",
            availableBalance: asset.availableBalance || asset.balance || asset.walletBalance || "0",
            maxWithdrawAmount: asset.maxWithdrawAmount || asset.availableBalance || asset.balance || asset.walletBalance || "0",
          }));
          this.onBalanceUpdate?.(balances);
        }
      } catch (fallbackError) {
        const fallbackErr = fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError));
        console.error(`[RestPoller] Both balance endpoints failed:`);
        this.onError?.(fallbackErr);
      }
    }
  }
}
