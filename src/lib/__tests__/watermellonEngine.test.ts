import { WatermellonEngine } from "../engines";
import { SyntheticBar } from "../types";

describe("WatermellonEngine", () => {
  const createBar = (price: number): SyntheticBar => ({
    startTime: Date.now(),
    endTime: Date.now() + 30000,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: 1
  });

  it("should generate a long signal when indicators stack up", () => {
    const engine = new WatermellonEngine({
      emaFastLen: 2,
      emaMidLen: 3,
      emaSlowLen: 5,
      rsiLength: 2,
      rsiMinLong: 10,
      rsiMaxShort: 90
    });

    // Start with 10 bars of 100 to stabilize EMAs at 100.
    // lastLongLook will be false because RSI=50 and 50 > 10, BUT bullStack will be false (100=100=100).
    for (let i = 0; i < 10; i++) {
        engine.update(createBar(100));
    }
    
    // Now push price up.
    // update(110) -> Fast=103.3, Mid=102.5, Slow=101.6 -> bullStack=true.
    // RSI will also be > 10.
    // So this SHOULD trigger longTrig on the first bar that creates a bull stack.
    const signal = engine.update(createBar(110));
    
    expect(signal).not.toBeNull();
    expect(signal?.type).toBe("long");
  });

  it("should generate a short signal when indicators stack down", () => {
    const engine = new WatermellonEngine({
      emaFastLen: 2,
      emaMidLen: 3,
      emaSlowLen: 5,
      rsiLength: 2,
      rsiMinLong: 10,
      rsiMaxShort: 90
    });

    for (let i = 0; i < 10; i++) {
        engine.update(createBar(100));
    }
    
    const signal = engine.update(createBar(90));

    expect(signal).not.toBeNull();
    expect(signal?.type).toBe("short");
  });
});
