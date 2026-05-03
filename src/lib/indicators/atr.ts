export class ATR {
  private readonly length: number;
  private prevClose: number | null = null;
  private valueInternal: number | null = null;
  private trSeed: number[] = [];

  constructor(length = 14) {
    if (length < 1) {
      throw new Error("ATR length must be >= 1");
    }
    this.length = length;
  }

  update(high: number, low: number, close: number): number | null {
    if (this.prevClose === null) {
      this.prevClose = close;
      return null;
    }

    const tr = Math.max(high - low, Math.abs(high - this.prevClose), Math.abs(low - this.prevClose));
    this.prevClose = close;

    if (this.valueInternal === null) {
      this.trSeed.push(tr);
      if (this.trSeed.length < this.length) return null;
      const sum = this.trSeed.reduce((a, b) => a + b, 0);
      this.valueInternal = sum / this.length;
      return this.valueInternal;
    }

    const alpha = 1 / this.length;
    this.valueInternal = this.valueInternal * (1 - alpha) + tr * alpha;
    return this.valueInternal;
  }

  get value(): number | null {
    return this.valueInternal;
  }
}

