import type { ExecutionAdapter, TradeInstruction } from "../types";

type LogEntry =
  | { type: "enter"; side: "long" | "short"; order: TradeInstruction }
  | { type: "close"; reason: string; meta?: Record<string, unknown>; timestamp: number };

export class PaperExecutor implements ExecutionAdapter {
  private readonly history: LogEntry[] = [];
  private balance: number;
  private currentPosition: { side: "long" | "short"; size: number; entryPrice: number } | null = null;
  
  constructor(initialBalance: number) {
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
    
    // Attempt to extract exit price from meta, or default to entryPrice (0 PNL) if not found
    let exitPrice = this.currentPosition.entryPrice;
    if (meta) {
      if (typeof meta.close === "number") exitPrice = meta.close;
      else if (typeof meta.price === "number") exitPrice = meta.price;
    }

    const { side, size, entryPrice } = this.currentPosition;
    
    // Calculate PNL
    // side === 'long': pnl = (exitPrice - entryPrice) * size
    // side === 'short': pnl = (entryPrice - exitPrice) * size
    const pnl = side === "long" 
      ? (exitPrice - entryPrice) * size
      : (entryPrice - exitPrice) * size;
      
    this.balance += pnl;
    
    console.log(`[PaperTrading] Position closed on ${symbol}. PNL: ${pnl.toFixed(4)} USDT`);
    console.log(`[PaperTrading] Cumulative Balance: ${this.balance.toFixed(4)} USDT`);
    
    this.currentPosition = null;
    this.persist({ type: "close", reason, meta: { ...meta, symbol, pnl, newBalance: this.balance }, timestamp: Date.now() });
  }

  get logs(): LogEntry[] {
    return this.history;
  }
  
  get virtualBalance(): number {
    return this.balance;
  }

  private persist(entry: LogEntry) {
    this.history.unshift(entry);
    const label = entry.type === "enter" ? `ENTER ${entry.side.toUpperCase()}` : "CLOSE";
    const payload = entry.type === "enter" ? entry.order : entry;
    console.log(`[PaperTrading] ${label}`, payload);
  }
}
