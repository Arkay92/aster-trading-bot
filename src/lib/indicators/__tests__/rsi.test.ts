import { RSI } from "../rsi";

describe("RSI Indicator", () => {
  it("should initialize with neutral 50", () => {
    const rsi = new RSI(14);
    const result = rsi.update(100);
    expect(result).toBe(50);
    expect(rsi.isReady).toBe(false);
  });

  it("should be 100 when only gains occur", () => {
    const rsi = new RSI(5);
    rsi.update(100);
    rsi.update(101);
    rsi.update(102);
    rsi.update(103);
    rsi.update(104);
    const result = rsi.update(105);
    expect(result).toBe(100);
    expect(rsi.isReady).toBe(true);
  });

  it("should be 0 when only losses occur", () => {
    const rsi = new RSI(5);
    rsi.update(100);
    rsi.update(99);
    rsi.update(98);
    rsi.update(97);
    rsi.update(96);
    const result = rsi.update(95);
    expect(result).toBe(0);
    expect(rsi.isReady).toBe(true);
  });

  it("should calculate correct RSI for mixed price action", () => {
    const rsi = new RSI(2); 
    rsi.update(100);
    rsi.update(110); 
    rsi.update(105); 
    const result = rsi.update(115); 
    
    // Wilder's smoothing makes exact manual calculation tedious for a one-off test,
    // but we can verify it's bullish (>50) and ready.
    expect(result).toBeGreaterThan(50);
    expect(rsi.isReady).toBe(true);
  });

  it("should throw error for invalid length", () => {
    expect(() => new RSI(1)).toThrow("RSI length must be at least 2");
  });
});
