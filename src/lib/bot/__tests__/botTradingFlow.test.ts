import { BotRunner } from "../botRunner";
import { DryRunExecutor } from "../../execution/executors";
import { AppConfig } from "../../types";
import { EventEmitter } from "events";
import { RestPoller } from "../../rest/restPoller";

// Mock the RestPoller and Client to avoid real network/wallet activity
jest.mock("../../rest/restPoller");
jest.mock("../../execution/asterV3Client");

describe("Bot Acceptance Test", () => {
  let bot: BotRunner;
  let executor: DryRunExecutor;
  let tickEmitter: EventEmitter;
  let restPollerInstance: any;

  const mockConfig: AppConfig = {
    mode: "dry-run",
    strategyTypes: ["watermellon"], 
    credentials: {
      rpcUrl: "http://localhost:8545",
      wsUrl: "ws://localhost:8546",
      apiKey: "test",
      privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      pairSymbols: ["BTCUSDT"]
    },
    risk: {
      maxPositions: 1,
      maxPositionSize: 500,
      maxLeverage: 1,
      maxFlipsPerHour: 10,
      minTradeIntervalMs: 0,
      atrStopMultiplier: 1.5,
      atrTakeProfitR: 2,
      requireStructureBreak: false,
      htfBiasEnabled: false,
      requireVolumeSpike: false,
      useMarketRegimeFilter: false
    },
    strategy: {
        timeframeMs: 1000,
        emaFastLen: 2,
        emaMidLen: 3,
        emaSlowLen: 5,
        rsiLength: 2,
        rsiMinLong: 10,
        rsiMaxShort: 90
    }
  };

  beforeEach(() => {
    executor = new DryRunExecutor();
    tickEmitter = new EventEmitter();
    
    const handlers: Record<string, Function> = {};
    restPollerInstance = {
      on: jest.fn((event, handler) => {
        handlers[event] = handler;
      }),
      start: jest.fn(),
      stop: jest.fn(),
      emit: (event: string, data: any) => {
        if (handlers[event]) handlers[event](data);
      }
    };
    (RestPoller as jest.Mock).mockReturnValue(restPollerInstance);

    const mockTickStream = {
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      on: (event: string, handler: any) => {
        tickEmitter.on(event, handler);
        return () => tickEmitter.off(event, handler);
      }
    };

    bot = new BotRunner(mockConfig, [mockTickStream as any], executor);
  });

  const sendTick = (price: number, timestamp: number, side: "buy" | "sell" = "buy") => {
    tickEmitter.emit("tick", {
      symbol: "BTCUSDT",
      price,
      size: 1,
      timestamp,
      side
    });
  };

  it("should complete a full trading cycle: Signal -> Entry", async () => {
    const startPromise = bot.start();
    restPollerInstance.emit("balance", [{ asset: "USDT", balance: "2000", availableBalance: "2000" }]);
    await startPromise;

    let now = Date.now();
    
    // Warm up
    for (let i = 0; i < 20; i++) {
        sendTick(100, now + (i * 1100), "buy");
        await new Promise(r => setTimeout(r, 1));
    }

    // Trigger Long with PAC (Price jump and strong close)
    // To get PAC > 0.7 on a 1s timeframe with multiple ticks:
    // First tick of bar at 200, last tick at 210, low at 200 -> PAC = (210-200)/(210-200) = 1.0
    sendTick(200, now + (21 * 1100), "buy");
    sendTick(210, now + (21 * 1100) + 500, "buy");
    sendTick(210, now + (22 * 1100), "buy"); // Close bar

    await new Promise(r => setTimeout(r, 100));

    const logs = executor.logs;
    const entries = logs.filter(l => l.type === "enter");
    
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].side).toBe("long");

    await bot.stop();
  });
});
