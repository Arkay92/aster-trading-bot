import { EMA } from "./indicators/ema";
import { RSI } from "./indicators/rsi";
import type { EmaCrossConfig, IndicatorSnapshot, StrategySignal, TrendSnapshot } from "./types";

const DEFAULT_CONFIG: EmaCrossConfig = {
  timeframeMs: 30_000,
  emaFastLen: 9,
  emaSlowLen: 26,
  rsiLength: 14,
  rsiMinLong: 45,
  rsiMaxShort: 55,
};

export class EmaCrossEngine {
  private readonly config: EmaCrossConfig;
  private readonly emaFast: EMA;
  private readonly emaSlow: EMA;
  private readonly rsi: RSI;
  private prevFast: number | null = null;
  private prevSlow: number | null = null;

  constructor(config?: Partial<EmaCrossConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.emaFast = new EMA(this.config.emaFastLen);
    this.emaSlow = new EMA(this.config.emaSlowLen);
    this.rsi = new RSI(this.config.rsiLength);
  }

  update(closePrice: number): StrategySignal {
    const fast = this.emaFast.update(closePrice);
    const slow = this.emaSlow.update(closePrice);
    const rsi = this.rsi.update(closePrice);
    const indicators: IndicatorSnapshot = {
      emaFast: fast,
      emaMid: slow,
      emaSlow: slow,
      rsi: rsi ?? 50,
    };

    if (this.prevFast === null || this.prevSlow === null || rsi === null) {
      this.prevFast = fast;
      this.prevSlow = slow;
      return null;
    }

    const crossUp = this.prevFast <= this.prevSlow && fast > slow;
    const crossDown = this.prevFast >= this.prevSlow && fast < slow;
    this.prevFast = fast;
    this.prevSlow = slow;

    const longTrig = crossUp && rsi >= this.config.rsiMinLong;
    const shortTrig = crossDown && rsi <= this.config.rsiMaxShort;
    const trend: TrendSnapshot = {
      bullStack: fast > slow,
      bearStack: fast < slow,
      longLook: crossUp,
      shortLook: crossDown,
      longTrig,
      shortTrig,
    };

    if (longTrig) return { type: "long", reason: "long-trigger", indicators, trend };
    if (shortTrig) return { type: "short", reason: "short-trigger", indicators, trend };
    return null;
  }
}

