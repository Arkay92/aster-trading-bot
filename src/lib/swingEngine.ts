import { EMA } from "./indicators/ema";
import { RSI } from "./indicators/rsi";
import type { IndicatorSnapshot, StrategySignal, SwingConfig, TrendSnapshot } from "./types";

const DEFAULT_CONFIG: SwingConfig = {
  timeframeMs: 30_000,
  emaTrendLen: 50,
  rsiLength: 14,
  rsiDipThreshold: 35,
  rsiHighThreshold: 65,
  lookbackBars: 20,
  dipPercentFromHigh: 1.5,
  bounceConfirmPercent: 0.3,
};

export class SwingEngine {
  private readonly config: SwingConfig;
  private readonly emaTrend: EMA;
  private readonly rsi: RSI;
  private closeHistory: number[] = [];
  private pendingLongDip = false;
  private pendingShortHigh = false;
  private dipLow = Number.POSITIVE_INFINITY;
  private highPeak = Number.NEGATIVE_INFINITY;

  constructor(config?: Partial<SwingConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.emaTrend = new EMA(this.config.emaTrendLen);
    this.rsi = new RSI(this.config.rsiLength);
  }

  update(closePrice: number): StrategySignal {
    const emaTrend = this.emaTrend.update(closePrice);
    const rsi = this.rsi.update(closePrice);

    this.closeHistory.push(closePrice);
    if (this.closeHistory.length > this.config.lookbackBars) {
      this.closeHistory.shift();
    }

    const indicators: IndicatorSnapshot = {
      emaFast: emaTrend,
      emaMid: emaTrend,
      emaSlow: emaTrend,
      rsi: rsi ?? 50,
    };

    if (this.closeHistory.length < this.config.lookbackBars || rsi === null) {
      return null;
    }

    const recentHigh = Math.max(...this.closeHistory);
    const recentLow = Math.min(...this.closeHistory);
    const dipFromHighPct = ((recentHigh - closePrice) / recentHigh) * 100;
    const riseFromLowPct = ((closePrice - recentLow) / recentLow) * 100;
    const upTrend = closePrice >= emaTrend;
    const downTrend = closePrice <= emaTrend;

    const longLook = upTrend && dipFromHighPct >= this.config.dipPercentFromHigh && rsi <= this.config.rsiDipThreshold;
    const shortLook = downTrend && riseFromLowPct >= this.config.dipPercentFromHigh && rsi >= this.config.rsiHighThreshold;

    let longTrig = false;
    let shortTrig = false;

    if (longLook) {
      this.pendingLongDip = true;
      this.dipLow = Math.min(this.dipLow, closePrice);
    }
    if (shortLook) {
      this.pendingShortHigh = true;
      this.highPeak = Math.max(this.highPeak, closePrice);
    }

    if (this.pendingLongDip && Number.isFinite(this.dipLow)) {
      const bouncePct = ((closePrice - this.dipLow) / this.dipLow) * 100;
      if (bouncePct >= this.config.bounceConfirmPercent && closePrice >= emaTrend) {
        longTrig = true;
      }
    }

    if (this.pendingShortHigh && Number.isFinite(this.highPeak)) {
      const pullbackPct = ((this.highPeak - closePrice) / this.highPeak) * 100;
      if (pullbackPct >= this.config.bounceConfirmPercent && closePrice <= emaTrend) {
        shortTrig = true;
      }
    }

    if (longTrig) {
      this.pendingLongDip = false;
      this.dipLow = Number.POSITIVE_INFINITY;
      this.pendingShortHigh = false;
      this.highPeak = Number.NEGATIVE_INFINITY;
    } else if (shortTrig) {
      this.pendingShortHigh = false;
      this.highPeak = Number.NEGATIVE_INFINITY;
      this.pendingLongDip = false;
      this.dipLow = Number.POSITIVE_INFINITY;
    }

    const trend: TrendSnapshot = {
      bullStack: upTrend,
      bearStack: downTrend,
      longLook,
      shortLook,
      longTrig,
      shortTrig,
    };

    if (longTrig) return { type: "long", reason: "long-trigger", indicators, trend };
    if (shortTrig) return { type: "short", reason: "short-trigger", indicators, trend };
    return null;
  }

  get settings(): SwingConfig {
    return this.config;
  }

  getIndicatorValues(): {
    emaTrend: number | null;
    rsi: number | null;
  } {
    return {
      emaTrend: this.emaTrend.value,
      rsi: this.rsi.value,
    };
  }
}
