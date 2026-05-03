import type { TradeInstruction } from "../types";

type OrderConfirmation = {
  orderId: string;
  symbol: string;
  side: "long" | "short";
  size: number;
  price: number;
  timestamp: number;
  confirmed: boolean;
  confirmedAt?: number;
};

export class OrderTracker {
  private pendingOrders = new Map<string, OrderConfirmation>();
  private readonly confirmationTimeoutMs = 30_000; // 30 seconds

  trackOrder(order: TradeInstruction, orderId: string): void {
    this.pendingOrders.set(orderId, {
      orderId,
      symbol: order.symbol,
      side: order.side,
      size: order.size,
      price: order.price,
      timestamp: order.timestamp,
      confirmed: false,
    });

    // Auto-expire unconfirmed orders
    setTimeout(() => {
      const pending = this.pendingOrders.get(orderId);
      if (pending && !pending.confirmed) {
        console.warn(`[OrderTracker] Order ${orderId} not confirmed within timeout`);
        this.pendingOrders.delete(orderId);
      }
    }, this.confirmationTimeoutMs);
  }

  confirmOrder(orderId: string): boolean {
    const order = this.pendingOrders.get(orderId);
    if (order) {
      order.confirmed = true;
      order.confirmedAt = Date.now();
      console.log(`[OrderTracker] Order ${orderId} confirmed`);
      return true;
    }
    return false;
  }

  confirmByPositionChange(symbol: string, side: "long" | "short", size: number): void {
    const normalizedSymbol = symbol.toUpperCase();
    // Find matching pending order
    for (const [orderId, order] of this.pendingOrders.entries()) {
      const sizeDelta = Math.abs(order.size - size);
      const ratioDelta = order.size > 0 ? sizeDelta / order.size : sizeDelta;
      if (
        !order.confirmed &&
        order.symbol.toUpperCase() === normalizedSymbol &&
        order.side === side &&
        (sizeDelta < 0.001 || ratioDelta < 0.35)
      ) {
        this.confirmOrder(orderId);
        break;
      }
    }
  }

  hasPendingOrders(): boolean {
    return this.pendingOrders.size > 0;
  }

  getPendingOrders(): OrderConfirmation[] {
    return Array.from(this.pendingOrders.values());
  }

  clearOrder(orderId: string): void {
    this.pendingOrders.delete(orderId);
  }

  clearAll(): void {
    this.pendingOrders.clear();
  }

  async retryOrder(orderId: string, retryFn: () => Promise<void>, maxRetries = 3): Promise<void> {
    let attempts = 0;
    while (attempts < maxRetries) {
      try {
        await retryFn();
        console.log(`[OrderTracker] Order ${orderId} succeeded after ${attempts + 1} attempt(s)`);
        return;
      } catch (error) {
        attempts++;
        console.warn(`[OrderTracker] Retry ${attempts} for order ${orderId} failed:`, error);
        if (attempts >= maxRetries) {
          console.error(`[OrderTracker] Order ${orderId} failed after ${maxRetries} retries`);
          throw error;
        }
      }
    }
  }
}

