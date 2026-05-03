/**
 * ATR with Wilder's Smoothing (Industry Standard)
 */
export class ATR {
  private readonly length: number;
  private prevClose: number | null = null;
  private valueInternal: number | null = null;
  private trSum = 0;
  private updateCount = 0;

  constructor(length = 14) {
    if (length < 1) {
      throw new Error("ATR length must be >= 1");
    }
    this.length = length;
  }

  update(high: number, low: number, close: number): number | null {
    if (this.prevClose === null) {
      this.prevClose = close;
      // TR for first bar is just high - low
      const tr = high - low;
      this.trSum += tr;
      this.updateCount = 1;
      return null;
    }

    const tr = Math.max(high - low, Math.abs(high - this.prevClose), Math.abs(low - this.prevClose));
    this.prevClose = close;
    this.updateCount++;

    if (this.valueInternal === null) {
      this.trSum += tr;
      if (this.updateCount < this.length) return null;
      
      // Seed ATR with SMA of TR
      this.valueInternal = this.trSum / this.length;
      return this.valueInternal;
    }

    // Wilder's Smoothing for ATR
    this.valueInternal = (this.valueInternal * (this.length - 1) + tr) / this.length;
    return this.valueInternal;
  }

  get value(): number | null {
    return this.valueInternal;
  }
}
