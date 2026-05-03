import { PaperExecutor } from "../executors";
import type { TradeInstruction } from "../../types";

const order = (symbol: string, side: "long" | "short", price: number): TradeInstruction => ({
  symbol,
  side,
  size: 1,
  leverage: 1,
  price,
  signalReason: "test",
  timestamp: 1,
});

describe("PaperExecutor", () => {
  it("tracks PnL independently per symbol", async () => {
    const executor = new PaperExecutor(1000);

    await executor.enterLong(order("BTCUSDT-PERP", "long", 100));
    await executor.enterShort(order("ETHUSDT-PERP", "short", 200));

    await executor.closePosition("BTCUSDT-PERP", "test", { price: 110 });
    expect(executor.virtualBalance).toBe(1010);

    await executor.closePosition("ETHUSDT-PERP", "test", { price: 180 });
    expect(executor.virtualBalance).toBe(1030);
  });

  it("keeps the remaining paper position after a partial close", async () => {
    const executor = new PaperExecutor(1000);

    await executor.enterLong({ ...order("BTCUSDT-PERP", "long", 100), size: 2 });
    await executor.closePosition("BTCUSDT-PERP", "partial", { price: 110, size: 1 });
    await executor.closePosition("BTCUSDT-PERP", "rest", { price: 120 });

    expect(executor.virtualBalance).toBe(1030);
  });
});
