import type { Indicator } from "../types";

/**
 * Slope Indicator: Measures the rate of change (angle) of a series.
 * Useful for determining trend strength and regime detection.
 */
export class Slope implements Indicator {
  private prevValue: number | null = null;
  private currentSlope: number | null = null;

  constructor(private readonly period: number = 1) {}

  update(value: number): number | null {
    if (this.prevValue !== null) {
      // Calculate simple difference over 1 bar as the basis for slope
      // In more complex versions, this could be a linear regression slope
      this.currentSlope = (value - this.prevValue) / this.prevValue * 100;
    }
    this.prevValue = value;
    return this.currentSlope;
  }

  get value(): number | null {
    return this.currentSlope;
  }

  get isReady(): boolean {
    return this.currentSlope !== null;
  }
}
