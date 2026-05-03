import type { Indicator } from "../types";

/**
 * Standard ADX (Average Directional Index) with Wilder's Smoothing.
 * Measures trend strength regardless of direction.
 */
export class ADX implements Indicator {
  private readonly length: number;
  private prevHigh: number | null = null;
  private prevLow: number | null = null;
  private prevClose: number | null = null;

  private trSum = 0;
  private plusDMSum = 0;
  private minusDMSum = 0;

  private smoothTR = 0;
  private smoothPlusDM = 0;
  private smoothMinusDM = 0;

  private dxSum = 0;
  private adxValue: number | null = null;
  private updateCount = 0;

  constructor(length: number = 14) {
    if (length < 2) throw new Error("ADX length must be at least 2");
    this.length = length;
  }

  update(high: number, low: number, close: number): number | null {
    if (this.prevHigh === null) {
      this.prevHigh = high; this.prevLow = low; this.prevClose = close;
      return null;
    }

    const tr = Math.max(high - low, Math.abs(high - this.prevClose!), Math.abs(low - this.prevClose!));

    let plusDM = 0;
    let minusDM = 0;
    const upMove = high - this.prevHigh!;
    const downMove = this.prevLow! - low;

    if (upMove > downMove && upMove > 0) plusDM = upMove;
    if (downMove > upMove && downMove > 0) minusDM = downMove;

    this.updateCount++;

    if (this.updateCount < this.length) {
      this.trSum += tr;
      this.plusDMSum += plusDM;
      this.minusDMSum += minusDM;
    } else if (this.updateCount === this.length) {
      this.trSum += tr;
      this.plusDMSum += plusDM;
      this.minusDMSum += minusDM;

      this.smoothTR = this.trSum;
      this.smoothPlusDM = this.plusDMSum;
      this.smoothMinusDM = this.minusDMSum;
    } else {
      // Wilder's Smoothing
      this.smoothTR = this.smoothTR - (this.smoothTR / this.length) + tr;
      this.smoothPlusDM = this.smoothPlusDM - (this.smoothPlusDM / this.length) + plusDM;
      this.smoothMinusDM = this.smoothMinusDM - (this.smoothMinusDM / this.length) + minusDM;
    }

    this.prevHigh = high; this.prevLow = low; this.prevClose = close;

    if (this.updateCount < this.length) return null;

    const plusDI = 100 * (this.smoothPlusDM / this.smoothTR);
    const minusDI = 100 * (this.smoothMinusDM / this.smoothTR);
    const dx = 100 * Math.abs(plusDI - minusDI) / (plusDI + minusDI || 1);

    if (this.updateCount < this.length * 2 - 1) {
      this.dxSum += dx;
      return null;
    }

    if (this.updateCount === this.length * 2 - 1) {
      this.dxSum += dx;
      this.adxValue = this.dxSum / this.length;
    } else {
      // Wilder's Smoothing for ADX
      this.adxValue = ((this.adxValue! * (this.length - 1)) + dx) / this.length;
    }

    return this.adxValue;
  }

  get value(): number | null { return this.adxValue; }
  get isReady(): boolean { return this.adxValue !== null; }

  isTrending(threshold: number = 25): boolean {
    return this.adxValue !== null && this.adxValue > threshold;
  }
}
