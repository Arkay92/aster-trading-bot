export type LocalPositionState = {
  size: number;
  side: "long" | "short" | "flat";
  symbol?: string;
  avgEntry: number;
  unrealizedPnl: number;
  lastUpdate: number;
  orderId?: string;
  pendingOrder?: {
    side: "long" | "short";
    size: number;
    timestamp: number;
  };
};

export class PositionStateManager {
  private states = new Map<string, LocalPositionState>();
  private reconciliationFailures = new Map<string, number>();
  private readonly maxReconciliationFailures = 2;

  private getOrCreateState(symbol: string): LocalPositionState {
    let state = this.states.get(symbol);
    if (!state) {
      state = {
        size: 0,
        side: "flat",
        symbol,
        avgEntry: 0,
        unrealizedPnl: 0,
        lastUpdate: Date.now(),
      };
      this.states.set(symbol, state);
    }
    return state;
  }

  updateLocalState(symbol: string, update: Partial<LocalPositionState>): void {
    const currentState = this.getOrCreateState(symbol);
    this.states.set(symbol, {
      ...currentState,
      ...update,
      lastUpdate: Date.now(),
    });
  }

  updateFromRest(symbol: string, restState: {
    positionAmt: string;
    entryPrice: string;
    unrealizedProfit: string;
  }): boolean {
    const size = parseFloat(restState.positionAmt);
    const side: "long" | "short" | "flat" = size > 0 ? "long" : size < 0 ? "short" : "flat";
    const avgEntry = parseFloat(restState.entryPrice) || 0;
    const unrealizedPnl = parseFloat(restState.unrealizedProfit) || 0;

    const restStateNormalized = {
      size: Math.abs(size),
      side,
      avgEntry,
      unrealizedPnl,
    };

    const currentState = this.getOrCreateState(symbol);
    const localStateNormalized = {
      size: currentState.size,
      side: currentState.side,
      avgEntry: currentState.avgEntry,
      unrealizedPnl: currentState.unrealizedPnl,
    };

    const now = Date.now();
    const reconciled = this.reconcile(restStateNormalized, localStateNormalized);
    const GRACE_PERIOD_MS = 10_000; // 10 seconds
    const isDust = restStateNormalized.size > 0 && restStateNormalized.size < 0.001; // Tiny residual

    if (reconciled || isDust) {
      if (isDust && restStateNormalized.side !== "flat") {
        console.log(`[PositionState] ${symbol} ignoring dust position from REST: ${restStateNormalized.size}`);
        restStateNormalized.size = 0;
        restStateNormalized.side = "flat";
        restStateNormalized.avgEntry = 0;
      }
      this.reconciliationFailures.set(symbol, 0);
      this.states.set(symbol, {
        ...currentState,
        ...restStateNormalized,
        lastUpdate: reconciled ? now : currentState.lastUpdate,
      });
      return true;
    }

    // Trust REST if local is flat but REST has a position, or vice versa.
    // ADDED: Grace period to prevent stale REST data from overwriting a recent local close.
    if (restStateNormalized.side !== localStateNormalized.side) {
      const timeSinceUpdate = now - currentState.lastUpdate;
      if (localStateNormalized.side === "flat" && timeSinceUpdate < GRACE_PERIOD_MS) {
        console.log(`[PositionState] ${symbol} ignoring potential stale REST position during grace period (${timeSinceUpdate}ms)`);
        return false;
      }

      console.log(`[PositionState] ${symbol} REST/Local mismatch (${restStateNormalized.side} vs ${localStateNormalized.side}), trusting REST`);
      this.reconciliationFailures.set(symbol, 0);
      this.states.set(symbol, {
        ...currentState,
        ...restStateNormalized,
        lastUpdate: now,
      });
      return true;
    }

    const failures = (this.reconciliationFailures.get(symbol) || 0) + 1;
    this.reconciliationFailures.set(symbol, failures);
    return false;
  }

  private reconcile(
    rest: { size: number; side: "long" | "short" | "flat"; avgEntry: number; unrealizedPnl: number },
    local: { size: number; side: "long" | "short" | "flat"; avgEntry: number; unrealizedPnl: number },
  ): boolean {
    const sizeMatch = Math.abs(rest.size - local.size) < 0.0001;
    const sideMatch = rest.side === local.side;
    
    if (rest.side === "flat" && local.side === "flat") {
      return sizeMatch && sideMatch;
    }
    
    const entryMatch = rest.avgEntry === 0 || Math.abs(rest.avgEntry - local.avgEntry) / rest.avgEntry < 0.01;

    return sizeMatch && sideMatch && entryMatch;
  }

  shouldFreezeTrading(symbol: string): boolean {
    return (this.reconciliationFailures.get(symbol) || 0) >= this.maxReconciliationFailures;
  }

  resetReconciliationFailures(symbol: string): void {
    this.reconciliationFailures.set(symbol, 0);
  }

  getState(symbol: string): LocalPositionState {
    return this.getOrCreateState(symbol);
  }

  getAllStates(): Map<string, LocalPositionState> {
    return new Map(this.states);
  }

  getActivePositionCount(): number {
    let count = 0;
    for (const state of this.states.values()) {
      if (state.side !== "flat" && state.size > 0) {
        count++;
      }
    }
    return count;
  }

  clearPendingOrder(symbol: string): void {
    const state = this.states.get(symbol);
    if (state) {
      state.pendingOrder = undefined;
    }
  }

  setPendingOrder(symbol: string, order: { side: "long" | "short"; size: number; timestamp: number }): void {
    const state = this.getOrCreateState(symbol);
    state.pendingOrder = order;
  }
}
