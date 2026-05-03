import { EMA } from "./indicators/ema";
import { RSI } from "./indicators/rsi";
import { ADX } from "./indicators/adx";
import type {
  IndicatorSnapshot,
  StrategyEngine,
  StrategySignal,
  SyntheticBar,
  TrendSnapshot,
  WatermellonConfig,
  EmaCrossConfig,
  RsiReversionConfig,
  SwingConfig,
  PeachConfig,
  StrategyType,
} from "./types";

/**
 * Watermellon Engine: 3-EMA Bull/Bear stack + RSI threshold
 */
const WATERMELLON_DEFAULT: WatermellonConfig = {
  timeframeMs: 30_000,
  emaFastLen: 8,
  emaMidLen: 21,
  emaSlowLen: 48,
  rsiLength: 14,
  rsiMinLong: 42,
  rsiMaxShort: 58,
};

export class WatermellonEngine implements StrategyEngine {
  readonly settings: WatermellonConfig;
  private readonly emaFast: EMA;
  private readonly emaMid: EMA;
  private readonly emaSlow: EMA;
  private readonly rsi: RSI;
  private lastLongLook = false;
  private lastShortLook = false;

  constructor(config?: Partial<WatermellonConfig>) {
    this.settings = { ...WATERMELLON_DEFAULT, ...config };
    this.emaFast = new EMA(this.settings.emaFastLen);
    this.emaMid = new EMA(this.settings.emaMidLen);
    this.emaSlow = new EMA(this.settings.emaSlowLen);
    this.rsi = new RSI(this.settings.rsiLength);
  }

  update(bar: SyntheticBar): StrategySignal {
    const closePrice = bar.close;
    const emaFastValue = this.emaFast.update(closePrice);
    const emaMidValue = this.emaMid.update(closePrice);
    const emaSlowValue = this.emaSlow.update(closePrice);
    const rsiValue = this.rsi.update(closePrice);

    const indicators: IndicatorSnapshot = {
      emaFast: emaFastValue,
      emaMid: emaMidValue,
      emaSlow: emaSlowValue,
      rsi: rsiValue,
    };

    const bullStack = emaFastValue > emaMidValue && emaMidValue > emaSlowValue;
    const bearStack = emaFastValue < emaMidValue && emaMidValue < emaSlowValue;

    const longLook = bullStack && rsiValue > this.settings.rsiMinLong;
    const shortLook = bearStack && rsiValue < this.settings.rsiMaxShort;

    const longTrig = longLook && !this.lastLongLook;
    const shortTrig = shortLook && !this.lastShortLook;

    this.lastLongLook = longLook;
    this.lastShortLook = shortLook;

    const trend: TrendSnapshot = {
      bullStack, bearStack, longLook, shortLook, longTrig, shortTrig,
    };

    if (longTrig) return { type: "long", reason: "long-trigger", indicators, trend };
    if (shortTrig) return { type: "short", reason: "short-trigger", indicators, trend };
    return null;
  }

  getIndicatorValues() {
    return {
      emaFast: this.emaFast.value,
      emaMid: this.emaMid.value,
      emaSlow: this.emaSlow.value,
      rsi: this.rsi.value,
    };
  }
}

/**
 * EMA Cross Engine: Fast EMA crossing over/under Slow EMA + RSI filter
 */
const EMA_CROSS_DEFAULT: EmaCrossConfig = {
  timeframeMs: 30_000,
  emaFastLen: 9,
  emaSlowLen: 26,
  rsiLength: 14,
  rsiMinLong: 45,
  rsiMaxShort: 55,
};

export class EmaCrossEngine implements StrategyEngine {
  readonly settings: EmaCrossConfig;
  private readonly emaFast: EMA;
  private readonly emaSlow: EMA;
  private readonly rsi: RSI;
  private prevFast: number | null = null;
  private prevSlow: number | null = null;

  constructor(config?: Partial<EmaCrossConfig>) {
    this.settings = { ...EMA_CROSS_DEFAULT, ...config };
    this.emaFast = new EMA(this.settings.emaFastLen);
    this.emaSlow = new EMA(this.settings.emaSlowLen);
    this.rsi = new RSI(this.settings.rsiLength);
  }

  update(bar: SyntheticBar): StrategySignal {
    const closePrice = bar.close;
    const fast = this.emaFast.update(closePrice);
    const slow = this.emaSlow.update(closePrice);
    const rsi = this.rsi.update(closePrice);

    if (this.prevFast === null || this.prevSlow === null || rsi === null) {
      this.prevFast = fast;
      this.prevSlow = slow;
      return null;
    }

    const crossUp = this.prevFast <= this.prevSlow && fast > slow;
    const crossDown = this.prevFast >= this.prevSlow && fast < slow;
    this.prevFast = fast;
    this.prevSlow = slow;

    const longTrig = crossUp && rsi >= this.settings.rsiMinLong;
    const shortTrig = crossDown && rsi <= this.settings.rsiMaxShort;

    const indicators: IndicatorSnapshot = {
      emaFast: fast, emaMid: slow, emaSlow: slow, rsi: rsi,
    };

    const trend: TrendSnapshot = {
      bullStack: fast > slow, bearStack: fast < slow, longLook: crossUp, shortLook: crossDown, longTrig, shortTrig,
    };

    if (longTrig) return { type: "long", reason: "long-trigger", indicators, trend };
    if (shortTrig) return { type: "short", reason: "short-trigger", indicators, trend };
    return null;
  }

  getIndicatorValues() {
    return {
      emaFast: this.emaFast.value,
      emaSlow: this.emaSlow.value,
      rsi: this.rsi.value,
    };
  }
}

/**
 * RSI Reversion Engine: Overbought/Oversold reversion with trend confirmation
 */
const RSI_REVERSION_DEFAULT: RsiReversionConfig = {
  timeframeMs: 30_000,
  rsiLength: 14,
  rsiOversold: 30,
  rsiOverbought: 70,
  emaTrendLen: 50,
};

export class RsiReversionEngine implements StrategyEngine {
  readonly settings: RsiReversionConfig;
  private readonly rsi: RSI;
  private readonly emaTrend: EMA;
  private wasOversold = false;
  private wasOverbought = false;

  constructor(config?: Partial<RsiReversionConfig>) {
    this.settings = { ...RSI_REVERSION_DEFAULT, ...config };
    this.rsi = new RSI(this.settings.rsiLength);
    this.emaTrend = new EMA(this.settings.emaTrendLen);
  }

  update(bar: SyntheticBar): StrategySignal {
    const closePrice = bar.close;
    const rsi = this.rsi.update(closePrice);
    const emaTrend = this.emaTrend.update(closePrice);

    if (rsi === null) return null;

    if (rsi <= this.settings.rsiOversold) this.wasOversold = true;
    if (rsi >= this.settings.rsiOverbought) this.wasOverbought = true;

    const longTrig = this.wasOversold && rsi > this.settings.rsiOversold && closePrice >= emaTrend;
    const shortTrig = this.wasOverbought && rsi < this.settings.rsiOverbought && closePrice <= emaTrend;

    if (longTrig) this.wasOversold = false;
    if (shortTrig) this.wasOverbought = false;

    const indicators: IndicatorSnapshot = {
      emaFast: emaTrend, emaMid: emaTrend, emaSlow: emaTrend, rsi: rsi,
    };

    const trend: TrendSnapshot = {
      bullStack: closePrice >= emaTrend, bearStack: closePrice < emaTrend, longLook: this.wasOversold, shortLook: this.wasOverbought, longTrig, shortTrig,
    };

    if (longTrig) return { type: "long", reason: "long-trigger", indicators, trend };
    if (shortTrig) return { type: "short", reason: "short-trigger", indicators, trend };
    return null;
  }

  getIndicatorValues() {
    return {
      rsi: this.rsi.value,
      emaTrend: this.emaTrend.value,
    };
  }
}

/**
 * Swing Engine: Buying dips in uptrends and selling peaks in downtrends
 */
const SWING_DEFAULT: SwingConfig = {
  timeframeMs: 30_000,
  emaTrendLen: 50,
  rsiLength: 14,
  rsiDipThreshold: 35,
  rsiHighThreshold: 65,
  lookbackBars: 20,
  dipPercentFromHigh: 1.5,
  bounceConfirmPercent: 0.3,
};

export class SwingEngine implements StrategyEngine {
  readonly settings: SwingConfig;
  private readonly emaTrend: EMA;
  private readonly rsi: RSI;
  private closeHistory: number[] = [];
  private pendingLongDip = false;
  private pendingShortHigh = false;
  private dipLow = Number.POSITIVE_INFINITY;
  private highPeak = Number.NEGATIVE_INFINITY;

  constructor(config?: Partial<SwingConfig>) {
    this.settings = { ...SWING_DEFAULT, ...config };
    this.emaTrend = new EMA(this.settings.emaTrendLen);
    this.rsi = new RSI(this.settings.rsiLength);
  }

  update(bar: SyntheticBar): StrategySignal {
    const closePrice = bar.close;
    const emaTrend = this.emaTrend.update(closePrice);
    const rsi = this.rsi.update(closePrice);

    this.closeHistory.push(closePrice);
    if (this.closeHistory.length > this.settings.lookbackBars) this.closeHistory.shift();

    if (this.closeHistory.length < this.settings.lookbackBars || rsi === null) return null;

    const recentHigh = Math.max(...this.closeHistory);
    const recentLow = Math.min(...this.closeHistory);
    const dipFromHighPct = ((recentHigh - closePrice) / recentHigh) * 100;
    const riseFromLowPct = ((closePrice - recentLow) / recentLow) * 100;
    const upTrend = closePrice >= emaTrend;
    const downTrend = closePrice <= emaTrend;

    const longLook = upTrend && dipFromHighPct >= this.settings.dipPercentFromHigh && rsi <= this.settings.rsiDipThreshold;
    const shortLook = downTrend && riseFromLowPct >= this.settings.dipPercentFromHigh && rsi >= this.settings.rsiHighThreshold;

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
      if (bouncePct >= this.settings.bounceConfirmPercent && closePrice >= emaTrend) longTrig = true;
    }

    if (this.pendingShortHigh && Number.isFinite(this.highPeak)) {
      const pullbackPct = ((this.highPeak - closePrice) / this.highPeak) * 100;
      if (pullbackPct >= this.settings.bounceConfirmPercent && closePrice <= emaTrend) shortTrig = true;
    }

    if (longTrig) {
      this.pendingLongDip = false;
      this.dipLow = Number.POSITIVE_INFINITY;
    } else if (shortTrig) {
      this.pendingShortHigh = false;
      this.highPeak = Number.NEGATIVE_INFINITY;
    }

    const indicators: IndicatorSnapshot = {
      emaFast: emaTrend, emaMid: emaTrend, emaSlow: emaTrend, rsi: rsi,
    };

    const trend: TrendSnapshot = {
      bullStack: upTrend, bearStack: downTrend, longLook, shortLook, longTrig, shortTrig,
    };

    if (longTrig) return { type: "long", reason: "long-trigger", indicators, trend };
    if (shortTrig) return { type: "short", reason: "short-trigger", indicators, trend };
    return null;
  }

  getIndicatorValues() {
    return {
      emaTrend: this.emaTrend.value,
      rsi: this.rsi.value,
    };
  }
}

/**
 * Peach Hybrid Engine: Multi-system trend + momentum surge + volume confirmation
 */
export class PeachHybridEngine implements StrategyEngine {
  readonly settings: PeachConfig;
  
  private readonly v1EmaFast: EMA;
  private readonly v1EmaMid: EMA;
  private readonly v1EmaSlow: EMA;
  private readonly v1EmaMicroFast: EMA;
  private readonly v1EmaMicroSlow: EMA;
  private readonly v1Rsi: RSI;
  private v1LastLongLook = false;
  private v1LastShortLook = false;
  private v1LastLongPrice = 0;
  private v1LastShortPrice = 0;
  private v1BarsSinceLastSignal = 0;
  
  private readonly v2EmaFast: EMA;
  private readonly v2EmaMid: EMA;
  private readonly v2EmaSlow: EMA;
  private readonly v2Rsi: RSI;
  private v2RsiHistory: number[] = [];
  private volumeHistory: number[] = [];
  private readonly adx: ADX;
  private position: { side: "long" | "short" | "flat" } | null = null;
  
  constructor(config: PeachConfig) {
    this.settings = config;
    this.v1EmaFast = new EMA(config.v1.emaFastLen);
    this.v1EmaMid = new EMA(config.v1.emaMidLen);
    this.v1EmaSlow = new EMA(config.v1.emaSlowLen);
    this.v1EmaMicroFast = new EMA(config.v1.emaMicroFastLen);
    this.v1EmaMicroSlow = new EMA(config.v1.emaMicroSlowLen);
    this.v1Rsi = new RSI(config.v1.rsiLength);
    
    this.v2EmaFast = new EMA(config.v2.emaFastLen);
    this.v2EmaMid = new EMA(config.v2.emaMidLen);
    this.v2EmaSlow = new EMA(config.v2.emaSlowLen);
    this.v2Rsi = new RSI(14);
    this.adx = new ADX(14);
  }
  
  update(bar: SyntheticBar): StrategySignal | null {
    const closePrice = bar.close;
    const volume = bar.volume;
    
    const v1EmaFast = this.v1EmaFast.update(closePrice);
    const v1EmaMid = this.v1EmaMid.update(closePrice);
    const v1EmaSlow = this.v1EmaSlow.update(closePrice);
    const v1EmaMicroFast = this.v1EmaMicroFast.update(closePrice);
    const v1EmaMicroSlow = this.v1EmaMicroSlow.update(closePrice);
    const v1Rsi = this.v1Rsi.update(closePrice);
    
    const v2EmaFast = this.v2EmaFast.update(closePrice);
    const v2EmaMid = this.v2EmaMid.update(closePrice);
    const v2EmaSlow = this.v2EmaSlow.update(closePrice);
    const v2Rsi = this.v2Rsi.update(closePrice);
    this.adx.update(bar.high, bar.low, closePrice);
    
    if (v2Rsi !== null) {
      this.v2RsiHistory.push(v2Rsi);
      if (this.v2RsiHistory.length > 2) this.v2RsiHistory.shift();
    }
    
    this.volumeHistory.push(volume);
    if (this.volumeHistory.length > Math.max(this.settings.v2.volumeLookback, 10)) this.volumeHistory.shift();
    
    this.v1BarsSinceLastSignal++;
    
    const v1Signal = this.checkV1System(closePrice, v1EmaFast, v1EmaMid, v1EmaSlow, v1EmaMicroFast, v1EmaMicroSlow, v1Rsi);
    if (v1Signal) return v1Signal;
    
    const v2Signal = this.checkV2System(closePrice, v2EmaFast, v2EmaMid, v2EmaSlow, v2Rsi, volume, bar.open, bar.close);
    if (v2Signal) return v2Signal;
    
    return null;
  }
  
  private checkV1System(price: number, emaFast: number, emaMid: number, emaSlow: number, microFast: number, microSlow: number, rsi: number | null): StrategySignal | null {
    if (rsi === null) return null;
    const bullStack = emaFast > emaMid && emaMid > emaSlow;
    const bearStack = emaFast < emaMid && emaMid < emaSlow;
    const microBull = microFast > microSlow;
    const microBear = microFast < microSlow;
    const longLook = bullStack && microBull && rsi > this.settings.v1.rsiMinLong;
    const shortLook = bearStack && microBear && rsi < this.settings.v1.rsiMaxShort;
    
    if (this.v1BarsSinceLastSignal < this.settings.v1.minBarsBetween) return null;
    
    let moveMet = true;
    if (this.v1LastLongPrice > 0) moveMet = Math.abs((price - this.v1LastLongPrice) / this.v1LastLongPrice) * 100 >= this.settings.v1.minMovePercent;
    if (this.v1LastShortPrice > 0) moveMet = moveMet && Math.abs((price - this.v1LastShortPrice) / this.v1LastShortPrice) * 100 >= this.settings.v1.minMovePercent;
    if (!moveMet) return null;
    
    const longTrig = longLook && !this.v1LastLongLook;
    const shortTrig = shortLook && !this.v1LastShortLook;
    this.v1LastLongLook = longLook; this.v1LastShortLook = shortLook;
    
    if (longTrig) {
      this.v1LastLongPrice = price; this.v1BarsSinceLastSignal = 0;
      return { type: "long", reason: "v1-long", indicators: { emaFast, emaMid, emaSlow, rsi }, trend: { bullStack, bearStack, longLook, shortLook, longTrig, shortTrig } };
    }
    if (shortTrig) {
      this.v1LastShortPrice = price; this.v1BarsSinceLastSignal = 0;
      return { type: "short", reason: "v1-short", indicators: { emaFast, emaMid, emaSlow, rsi }, trend: { bullStack, bearStack, longLook, shortLook, longTrig, shortTrig } };
    }
    return null;
  }
  
  private checkV2System(price: number, emaFast: number, emaMid: number, emaSlow: number, rsi: number | null, volume: number, open: number, close: number): StrategySignal | null {
    if (rsi === null || this.v2RsiHistory.length < 2) return null;
    const rsiMom = this.v2RsiHistory[this.v2RsiHistory.length - 1] - this.v2RsiHistory[0];
    const avgVol = this.volumeHistory.reduce((s, v) => s + v, 0) / this.volumeHistory.length;
    const spike = volume >= avgVol * this.settings.v2.volumeMultiplier;
    const bull = close > open;
    const emaBull = emaFast > emaMid && emaMid > emaSlow;
    const emaBear = emaFast < emaMid && emaMid < emaSlow;
    
    if (Math.abs(rsiMom) >= this.settings.v2.rsiMomentumThreshold && rsiMom > 0 && spike && bull && emaBull) {
      return { type: "long", reason: "v2-long", indicators: { emaFast, emaMid, emaSlow, rsi }, trend: { bullStack: true, bearStack: false, longLook: true, shortLook: false, longTrig: true, shortTrig: false } };
    }
    if (Math.abs(rsiMom) >= this.settings.v2.rsiMomentumThreshold && rsiMom < 0 && spike && !bull && emaBear) {
      return { type: "short", reason: "v2-short", indicators: { emaFast, emaMid, emaSlow, rsi }, trend: { bullStack: false, bearStack: true, longLook: false, shortLook: true, longTrig: false, shortTrig: true } };
    }
    return null;
  }
  
  onPositionChange(side: "long" | "short" | "flat"): void { this.position = { side }; }

  checkExitConditions(bar: SyntheticBar) {
    if (!this.position || this.position.side === "flat") return { shouldExit: false, reason: "" };
    const avgVol = this.volumeHistory.reduce((s, v) => s + v, 0) / this.volumeHistory.length;
    if (this.v2RsiHistory.length >= 3) {
      const recent = this.v2RsiHistory.slice(-3);
      const rsiMom = Math.abs(recent[recent.length - 1] - recent[0]);
      const volMult = bar.volume / avgVol;
      const flat = rsiMom < 2.0 && volMult < this.settings.v2.exitVolumeMultiplier;
      const adverse = (this.position.side === "long" && recent[recent.length - 1] < recent[0]) || (this.position.side === "short" && recent[recent.length - 1] > recent[0]);
      if (flat || adverse) return { shouldExit: true, reason: adverse ? "rsi-reversal" : "rsi-flattening", details: { rsiMom, volMult } };
    }
    return { shouldExit: false, reason: "" };
  }

  getIndicatorValues() {
    return { v1: { emaFast: this.v1EmaFast.value, emaMid: this.v1EmaMid.value, emaSlow: this.v1EmaSlow.value, rsi: this.v1Rsi.value }, v2: { emaFast: this.v2EmaFast.value, emaMid: this.v2EmaMid.value, emaSlow: this.v2EmaSlow.value, rsi: this.v2Rsi.value }, adx: this.adx.value };
  }
  shouldAllowTrading(adxThreshold = 25): boolean { return !this.adx.isReady || this.adx.isTrending(adxThreshold); }
}
