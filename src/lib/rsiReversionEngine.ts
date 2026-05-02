import { EMA } from "./indicators/ema";
import { RSI } from "./indicators/rsi";
import type { IndicatorSnapshot, RsiReversionConfig, StrategySignal, TrendSnapshot } from "./types";

const DEFAULT_CONFIG: RsiReversionConfig = {
  timeframeMs: 30_000,
  rsiLength: 14,
  rsiOversold: 30,
  rsiOverbought: 70,
  emaTrendLen: 50,
};

export class RsiReversionEngine {
  private readonly config: RsiReversionConfig;
  private readonly rsi: RSI;
  private readonly emaTrend: EMA;
  private wasOversold = false;
  private wasOverbought = false;

  constructor(config?: Partial<RsiReversionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.rsi = new RSI(this.config.rsiLength);
    this.emaTrend = new EMA(this.config.emaTrendLen);
  }

  update(closePrice: number): StrategySignal {
    const rsi = this.rsi.update(closePrice);
    const emaTrend = this.emaTrend.update(closePrice);
    const indicators: IndicatorSnapshot = {
      emaFast: emaTrend,
      emaMid: emaTrend,
      emaSlow: emaTrend,
      rsi: rsi ?? 50,
    };
    if (rsi === null) return null;

    if (rsi <= this.config.rsiOversold) this.wasOversold = true;
    if (rsi >= this.config.rsiOverbought) this.wasOverbought = true;

    const longTrig = this.wasOversold && rsi > this.config.rsiOversold && closePrice >= emaTrend;
    const shortTrig = this.wasOverbought && rsi < this.config.rsiOverbought && closePrice <= emaTrend;

    if (longTrig) this.wasOversold = false;
    if (shortTrig) this.wasOverbought = false;

    const trend: TrendSnapshot = {
      bullStack: closePrice >= emaTrend,
      bearStack: closePrice < emaTrend,
      longLook: this.wasOversold,
      shortLook: this.wasOverbought,
      longTrig,
      shortTrig,
    };

    if (longTrig) return { type: "long", reason: "long-trigger", indicators, trend };
    if (shortTrig) return { type: "short", reason: "short-trigger", indicators, trend };
    return null;
  }
}

