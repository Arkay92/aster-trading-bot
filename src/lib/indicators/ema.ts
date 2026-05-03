import type { Indicator } from "../types";

/**
 * Enhanced EMA with Warm-up tracking and SMA seeding.
 * Uses the standard formula: EMA = Price * (2/(n+1)) + EMA_prev * (1 - (2/(n+1)))
 */
export class EMA implements Indicator {
  private readonly alpha: number;
  private readonly length: number;
  private valueInternal: number | null = null;
  private updateCount = 0;
  private sum = 0;

  constructor(length: number) {
    if (length <= 0) {
      throw new Error("EMA length must be positive");
    }
    this.length = length;
    this.alpha = 2 / (length + 1);
  }

  update(value: number): number {
    this.updateCount++;

    if (this.updateCount < this.length) {
      this.sum += value;
      return value; // Approximate until ready
    }

    if (this.updateCount === this.length) {
      this.sum += value;
      this.valueInternal = this.sum / this.length;
      return this.valueInternal;
    }

    // Standard EMA formula
    this.valueInternal = value * this.alpha + (this.valueInternal!) * (1 - this.alpha);
    return this.valueInternal;
  }

  get value(): number | null {
    return this.valueInternal;
  }

  get isReady(): boolean {
    return this.updateCount >= this.length;
  }
}
