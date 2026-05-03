import type { Indicator } from "../types";

/**
 * RSI with Wilder's Smoothing (Industry Standard)
 * Wilder's Smoothing is essentially an EMA with alpha = 1 / length
 */
export class RSI implements Indicator {
  private avgGain = 0;
  private avgLoss = 0;
  private prevValue: number | null = null;
  private readonly length: number;
  private readonly alpha: number;
  private ready = false;
  private rsiValue: number | null = null;
  private updateCount = 0;

  constructor(length: number) {
    if (length < 2) {
      throw new Error("RSI length must be at least 2");
    }
    this.length = length;
    this.alpha = 1 / length;
  }

  update(value: number): number {
    if (this.prevValue === null) {
      this.prevValue = value;
      this.rsiValue = 50;
      this.updateCount = 1;
      return 50;
    }

    const delta = value - this.prevValue;
    const gain = Math.max(delta, 0);
    const loss = Math.max(-delta, 0);

    this.updateCount++;

    if (this.updateCount <= this.length) {
      // First 'length' periods use simple average for seeding
      this.avgGain += gain;
      this.avgLoss += loss;
      
      if (this.updateCount === this.length) {
        this.avgGain /= this.length;
        this.avgLoss /= this.length;
        this.ready = true;
      }
    } else {
      // Wilder's Smoothing / MMA formula
      this.avgGain = (this.avgGain * (this.length - 1) + gain) / this.length;
      this.avgLoss = (this.avgLoss * (this.length - 1) + loss) / this.length;
    }

    this.prevValue = value;

    if (this.avgLoss === 0) {
      this.rsiValue = this.avgGain > 0 ? 100 : 50;
    } else {
      const rs = this.avgGain / this.avgLoss;
      this.rsiValue = 100 - 100 / (1 + rs);
    }

    return this.rsiValue;
  }

  get isReady(): boolean {
    return this.ready;
  }

  get value(): number | null {
    return this.rsiValue;
  }
}
