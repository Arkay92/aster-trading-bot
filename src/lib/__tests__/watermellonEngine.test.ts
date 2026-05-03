import { WatermellonEngine } from "../engines";
import { SyntheticBar } from "../types";

describe("WatermellonEngine", () => {
  const createBar = (price: number, side: "buy" | "sell" = "buy", high?: number, low?: number): SyntheticBar => ({
    startTime: Date.now(),
    endTime: Date.now() + 30000,
    open: price,
    high: high ?? price,
    low: low ?? price,
    close: price,
    volume: 1,
    buyVolume: side === "buy" ? 1 : 0,
    sellVolume: side === "sell" ? 1 : 0
  });

  it("should generate a long signal when indicators stack up and PAC is met", () => {
    const engine = new WatermellonEngine({
      emaFastLen: 2,
      emaMidLen: 3,
      emaSlowLen: 5,
      rsiLength: 2,
      rsiMinLong: 10,
      rsiMaxShort: 90
    });

    // Warm up
    for (let i = 0; i < 20; i++) {
        engine.update(createBar(100));
    }
    
    // Jump to 200 with Price Action Confirmation (Close in top 30%)
    // High=200, Low=180, Close=200 -> closePos = (200-180)/(200-180) = 1.0 (>= 0.7)
    const signal = engine.update(createBar(200, "buy", 200, 180));
    
    expect(signal).not.toBeNull();
    expect(signal?.type).toBe("long");
  });

  it("should generate a short signal when indicators stack down and PAC is met", () => {
    const engine = new WatermellonEngine({
      emaFastLen: 2,
      emaMidLen: 3,
      emaSlowLen: 5,
      rsiLength: 2,
      rsiMinLong: 10,
      rsiMaxShort: 90
    });

    for (let i = 0; i < 20; i++) {
        engine.update(createBar(100));
    }
    
    // Jump to 50 with PAC (Close in bottom 30%)
    // High=70, Low=50, Close=50 -> closePos = (50-50)/(70-50) = 0.0 (<= 0.3)
    const signal = engine.update(createBar(50, "sell", 70, 50));

    expect(signal).not.toBeNull();
    expect(signal?.type).toBe("short");
  });
});
