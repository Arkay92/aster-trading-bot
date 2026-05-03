import { EventEmitter } from "events";
import { BotRunner } from "../botRunner";
import { DryRunExecutor } from "../../execution/executors";
import type { AppConfig } from "../../types";

describe("BotRunner risk limits", () => {
  const config: AppConfig = {
    mode: "dry-run",
    strategyTypes: ["watermellon"],
    credentials: {
      rpcUrl: "http://localhost:8545",
      wsUrl: "ws://localhost:8546",
      apiKey: "test",
      privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      pairSymbols: ["BTCUSDT"],
    },
    risk: {
      maxPositions: 1,
      maxPositionSize: 500,
      maxLeverage: 1,
      maxFlipsPerHour: 10,
      maxDrawdownUsdt: 50,
      maxDailyLossUsdt: 1_000,
      maxConsecutiveLosses: 10,
    },
    strategy: {
      timeframeMs: 1000,
      emaFastLen: 2,
      emaMidLen: 3,
      emaSlowLen: 5,
      rsiLength: 2,
      rsiMinLong: 10,
      rsiMaxShort: 90,
    },
  };

  const makeStream = () => {
    const emitter = new EventEmitter();
    return {
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      on: (event: string, handler: (...args: unknown[]) => void) => {
        emitter.on(event, handler);
        return () => emitter.off(event, handler);
      },
    };
  };

  it("halts trading when realized daily drawdown exceeds the configured cap", () => {
    const bot = new BotRunner(config, [makeStream() as any], new DryRunExecutor());
    const botAny = bot as any;

    botAny.usdtBalance = 1_000;
    botAny.resetDailyRiskWindow();

    botAny.tradeStats.startTrade("BTCUSDT-PERP", "long", 100, 1, 1, "watermellon");
    botAny.tradeStats.closeTrade("BTCUSDT-PERP", 200, "win");
    botAny.updateRiskFromLastTrade();

    botAny.tradeStats.startTrade("ETHUSDT-PERP", "long", 100, 1, 1, "watermellon");
    botAny.tradeStats.closeTrade("ETHUSDT-PERP", 40, "loss");
    botAny.updateRiskFromLastTrade();

    const metrics = bot.getPerformanceMetrics();
    expect(metrics.daily.drawdown).toBe(60);
    expect(metrics.daily.halted).toBe(true);
  });
});
