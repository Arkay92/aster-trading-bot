import type { SyntheticBar, Tick } from "./types";

export class VirtualBarBuilder {
  private bar: SyntheticBar | null = null;
  private readonly timeframeMs: number;

  constructor(timeframeMs: number) {
    if (timeframeMs <= 0) {
      throw new Error("Timeframe must be positive");
    }
    this.timeframeMs = timeframeMs;
  }

  /**
   * External pulse to check if the current bar should be closed based on system time.
   * Useful when no ticks are arriving but we need to update indicators or close positions.
   */
  checkTime(now: number = Date.now()): SyntheticBar | null {
    if (!this.bar) return null;

    const elapsed = now - this.bar.startTime;
    if (elapsed >= this.timeframeMs) {
      const closedBar = this.bar;
      this.bar = null; // Next tick or pulse will start a new one
      return closedBar;
    }
    return null;
  }

  pushTick(tick: Tick): { closedBar: SyntheticBar | null; currentBar: SyntheticBar } {
    if (!this.bar) {
      this.bar = this.createBar(tick);
      return { closedBar: null, currentBar: this.bar };
    }

    const elapsed = tick.timestamp - this.bar.startTime;
    if (elapsed >= this.timeframeMs) {
      const closedBar = this.bar;
      this.bar = this.createBar(tick);
      return { closedBar, currentBar: this.bar };
    }

    this.bar.high = Math.max(this.bar.high, tick.price);
    this.bar.low = Math.min(this.bar.low, tick.price);
    this.bar.close = tick.price;
    this.bar.endTime = tick.timestamp;

    if (tick.size) {
      this.bar.volume += tick.size;
      if (tick.side === "buy") {
        this.bar.buyVolume += tick.size;
      } else if (tick.side === "sell") {
        this.bar.sellVolume += tick.size;
      }
    }

    return { closedBar: null, currentBar: this.bar };
  }

  private createBar(tick: Tick): SyntheticBar {
    const buyVol = tick.side === "buy" ? (tick.size ?? 0) : 0;
    const sellVol = tick.side === "sell" ? (tick.size ?? 0) : 0;
    
    return {
      startTime: tick.timestamp,
      endTime: tick.timestamp,
      open: tick.price,
      high: tick.price,
      low: tick.price,
      close: tick.price,
      volume: tick.size ?? 0,
      buyVolume: buyVol,
      sellVolume: sellVol,
    };
  }
}
