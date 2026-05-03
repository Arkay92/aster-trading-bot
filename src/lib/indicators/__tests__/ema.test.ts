import { EMA } from "../ema";

describe("EMA Indicator", () => {
  it("should initialize with the first value", () => {
    const ema = new EMA(5);
    const result = ema.update(100);
    expect(result).toBe(100);
    expect(ema.value).toBe(100);
    expect(ema.isReady).toBe(true);
  });

  it("should calculate EMA correctly after multiple updates", () => {
    const length = 5;
    const ema = new EMA(length);
    const smoothing = 2 / (length + 1); // 1/3 for length 5
    
    ema.update(100); // init: 100
    const result = ema.update(110);
    
    // 110 * (1/3) + 100 * (2/3) = 36.666... + 66.666... = 103.333...
    expect(result).toBeCloseTo(103.333, 3);
  });

  it("should throw error for invalid length", () => {
    expect(() => new EMA(0)).toThrow("EMA length must be positive");
    expect(() => new EMA(-1)).toThrow("EMA length must be positive");
  });

  it("should throw error if value is accessed before initialization", () => {
    const ema = new EMA(5);
    expect(() => ema.value).toThrow("EMA has not been initialized");
  });
});
