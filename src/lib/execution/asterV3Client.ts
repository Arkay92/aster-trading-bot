import { Wallet } from "ethers";
import type { Credentials } from "../types";

type ReqMethod = "GET" | "POST" | "DELETE";

export type V3OrderRequest = {
  symbol: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT";
  quantity: string;
  price?: string;
  timeInForce?: "GTC" | "IOC" | "FOK";
  priceHint?: number;
  positionSide?: "BOTH" | "LONG" | "SHORT";
  reduceOnly?: "true" | "false";
};

export type V3PositionRisk = {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
  marginType: string;
  isolatedMargin: string;
  positionSide: string;
};

export type V3Balance = {
  asset: string;
  balance: string;
  availableBalance: string;
  maxWithdrawAmount: string;
};

type V3Account = {
  positions?: Array<{ symbol: string; positionAmt: string; entryPrice?: string }>;
  assets?: Array<{ asset: string; balance?: string; walletBalance?: string; availableBalance?: string; maxWithdrawAmount?: string }>;
};

type ExchangeInfoSymbol = {
  symbol: string;
  filters?: Array<{ filterType: string; minQty?: string; maxQty?: string; stepSize?: string; notional?: string }>;
};

type SymbolLotRule = {
  minQty: number;
  maxQty: number;
  stepSize: number;
  minNotional?: number;
};

export class AsterV3Client {
  private readonly baseUrl: string;
  private readonly user: string;
  private readonly signer: string;
  private readonly wallet: Wallet;
  private lastMicros = 0n;
  private lotRuleCache = new Map<string, SymbolLotRule>();
  private exchangeInfoLoaded = false;

  constructor(credentials: Credentials) {
    this.baseUrl = credentials.rpcUrl;
    const signerPrivateKey = credentials.signerPrivateKey || credentials.privateKey;
    this.wallet = new Wallet(signerPrivateKey);
    this.signer = credentials.signerAddress || this.wallet.address;
    this.user = credentials.userAddress || this.signer;
  }

  async newOrder(order: V3OrderRequest): Promise<any> {
    const adjustedQty = await this.normalizeOrderQuantity(
      order.symbol,
      order.quantity,
      order.reduceOnly === "true",
      order.priceHint,
    );
    const payload: Record<string, string> = {
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      quantity: adjustedQty,
    };
    if (order.price) payload.price = order.price;
    if (order.timeInForce) payload.timeInForce = order.timeInForce;
    if (order.positionSide) payload.positionSide = order.positionSide;
    if (order.reduceOnly) payload.reduceOnly = order.reduceOnly;
    return this.signedRequest("POST", "/fapi/v3/order", payload);
  }

  async cancelOrder(symbol: string, orderId: string): Promise<unknown> {
    return this.signedRequest("DELETE", "/fapi/v3/order", { symbol, orderId });
  }

  async getOpenOrders(symbol: string): Promise<any[]> {
    return this.signedRequest("GET", "/fapi/v3/openOrders", { symbol }) as Promise<any[]>;
  }

  async changeLeverage(symbol: string, leverage: number): Promise<unknown> {
    return this.signedRequest("POST", "/fapi/v3/leverage", {
      symbol,
      leverage: String(leverage),
    });
  }

  async getPositionRisk(symbol: string): Promise<V3PositionRisk[]> {
    return this.signedRequest("GET", "/fapi/v3/positionRisk", { symbol }) as Promise<V3PositionRisk[]>;
  }

  async getBalance(): Promise<V3Balance[]> {
    return this.signedRequest("GET", "/fapi/v3/balance", {}) as Promise<V3Balance[]>;
  }

  async getAccount(): Promise<V3Account> {
    return this.signedRequest("GET", "/fapi/v3/accountWithJoinMargin", {}) as Promise<V3Account>;
  }

  async getPremiumIndex(symbol?: string): Promise<any> {
    const qs = symbol ? `?symbol=${encodeURIComponent(symbol)}` : "";
    const res = await fetch(`${this.baseUrl}/fapi/v3/premiumIndex${qs}`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async get24hTickers(): Promise<any[]> {
    const res = await fetch(`${this.baseUrl}/fapi/v3/ticker/24hr`);
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as any[];
  }

  private async normalizeOrderQuantity(
    symbol: string,
    rawQty: string,
    reduceOnly = false,
    priceHint?: number,
  ): Promise<string> {
    const rule = await this.getLotRule(symbol);
    if (!rule) return rawQty;

    const qty = Number(rawQty);
    if (!Number.isFinite(qty) || qty <= 0) return rawQty;

    const decimals = this.decimalPlaces(rule.stepSize);
    const scale = 10 ** decimals;

    let effectiveMinQty = rule.minQty;
    if (!reduceOnly && rule.minNotional && priceHint && priceHint > 0) {
      const minQtyByNotional = rule.minNotional / priceHint;
      effectiveMinQty = Math.max(effectiveMinQty, minQtyByNotional);
    }

    const minScaled = Math.ceil(effectiveMinQty * scale);
    const maxScaled = Math.round(rule.maxQty * scale);
    const stepScaled = Math.max(1, Math.round(rule.stepSize * scale));
    const qtyScaled = Math.round(qty * scale);

    const bounded = Math.max(minScaled, Math.min(maxScaled, qtyScaled));
    const stepsFromMin = Math.floor((bounded - minScaled) / stepScaled);
    const adjustedScaled = minScaled + stepsFromMin * stepScaled;
    const adjusted = adjustedScaled / scale;

    return adjusted.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
  }

  private decimalPlaces(step: number): number {
    const s = step.toString();
    if (!s.includes(".")) return 0;
    return s.split(".")[1].replace(/0+$/, "").length;
  }

  private async getLotRule(symbol: string): Promise<SymbolLotRule | null> {
    if (this.lotRuleCache.has(symbol)) return this.lotRuleCache.get(symbol) || null;
    if (!this.exchangeInfoLoaded) {
      await this.loadExchangeInfo();
    }
    return this.lotRuleCache.get(symbol) || null;
  }

  private async loadExchangeInfo(): Promise<void> {
    this.exchangeInfoLoaded = true;
    try {
      const res = await fetch(`${this.baseUrl}/fapi/v3/exchangeInfo`);
      if (!res.ok) return;
      const json = (await res.json()) as { symbols?: ExchangeInfoSymbol[] };
      const symbols = json.symbols || [];
      for (const s of symbols) {
      const marketLot = s.filters?.find((f) => f.filterType === "MARKET_LOT_SIZE");
      const lot = s.filters?.find((f) => f.filterType === "LOT_SIZE");
      const minNotional = s.filters?.find((f) => f.filterType === "MIN_NOTIONAL");
      const selected = marketLot || lot;
      if (!selected?.stepSize || !selected.minQty || !selected.maxQty) continue;
      this.lotRuleCache.set(s.symbol, {
        minQty: Number(selected.minQty),
        maxQty: Number(selected.maxQty),
        stepSize: Number(selected.stepSize),
        minNotional: minNotional?.notional ? Number(minNotional.notional) : undefined,
      });
    }
    } catch {
      // Best-effort cache load only; order call will proceed with raw quantity if unavailable.
    }
  }

  private nextNonceMicros(): string {
    const now = BigInt(Date.now()) * 1000n;
    if (now <= this.lastMicros) this.lastMicros += 1n;
    else this.lastMicros = now;
    return this.lastMicros.toString();
  }

  private buildQuery(params: Record<string, string>): string {
    return Object.keys(params)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
      .join("&");
  }

  private async signQueryString(query: string): Promise<string> {
    const domain = {
      name: "AsterSignTransaction",
      version: "1",
      chainId: 1666,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    };
    const types = {
      Message: [{ name: "msg", type: "string" }],
    };
    return this.wallet.signTypedData(domain, types, { msg: query });
  }

  private async signedRequest(method: ReqMethod, path: string, business: Record<string, string>): Promise<unknown> {
    const params: Record<string, string> = {
      ...business,
      nonce: this.nextNonceMicros(),
      signer: this.signer,
      user: this.user,
    };
    const qs = this.buildQuery(params);
    const signature = await this.signQueryString(qs);
    const url = `${this.baseUrl}${path}?${qs}&signature=${encodeURIComponent(signature)}`;
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "aster-bot-v3",
      },
    });
    const text = await res.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {}
    if (!res.ok) {
      throw new Error(typeof json === "string" ? json : JSON.stringify(json));
    }
    return json;
  }
}
