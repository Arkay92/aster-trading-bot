import { EMA } from "../ema";

describe("EMA Indicator", () => {
  it("should be ready only after length updates", () => {
    const ema = new EMA(5);
    ema.update(100);
    expect(ema.value).toBeNull();
    expect(ema.isReady).toBe(false);
    
    ema.update(100);
    ema.update(100);
    ema.update(100);
    ema.update(100); // 5th update
    
    expect(ema.value).toBe(100);
    expect(ema.isReady).toBe(true);
  });

  it("should calculate EMA correctly after SMA seeding", () => {
    const length = 5;
    const ema = new EMA(length);
    const smoothing = 2 / (length + 1); // 1/3 for length 5
    
    ema.update(100);
    ema.update(100);
    ema.update(100);
    ema.update(100);
    ema.update(100); // 5th update seeds the SMA at 100
    
    const result = ema.update(110);
    
    // 110 * (1/3) + 100 * (2/3) = 103.333
    expect(result).toBeCloseTo(103.333, 3);
  });

  it("should throw error for invalid length", () => {
    expect(() => new EMA(0)).toThrow("EMA length must be positive");
    expect(() => new EMA(-1)).toThrow("EMA length must be positive");
  });

  it("should return null if value is accessed before initialization", () => {
    const ema = new EMA(5);
    ema.update(1);
    expect(ema.value).toBeNull();
  });
});
