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
    strategyTypes: ["watermellon", "ema-cross"], 
    credentials: {
      rpcUrl: "http://localhost:8545",
      wsUrl: "ws://localhost:8546",
      apiKey: "test",
      privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      pairSymbols: ["BTCUSDT"]
    },
    risk: {
      maxPositions: 1,
      maxPositionSize: 500, // Reduced to avoid balance issues
      maxLeverage: 1,
      maxFlipsPerHour: 10,
      minTradeIntervalMs: 0
    },
    strategy: {
        timeframeMs: 1000,
        emaFastLen: 2,
        emaMidLen: 3,
        emaSlowLen: 5,
        rsiLength: 2,
        rsiMinLong: 40,
        rsiMaxShort: 60
    },
    strategies: {
      watermellon: {
        timeframeMs: 1000,
        emaFastLen: 2,
        emaMidLen: 3,
        emaSlowLen: 5,
        rsiLength: 2,
        rsiMinLong: 40,
        rsiMaxShort: 60
      },
      "ema-cross": {
        timeframeMs: 1000,
        emaFastLen: 2,
        emaSlowLen: 5,
        rsiLength: 14,
        rsiMinLong: 1,
        rsiMaxShort: 99
      }
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

  const sendTick = (price: number, timestamp: number) => {
    tickEmitter.emit("tick", {
      symbol: "BTCUSDT",
      price,
      size: 1,
      timestamp
    });
  };

  it("should complete a full trading cycle: Signal -> Entry", async () => {
    const startPromise = bot.start();
    restPollerInstance.emit("balance", [{ asset: "USDT", balance: "2000", availableBalance: "2000" }]);
    await startPromise;

    let now = Date.now();
    
    for (let i = 0; i < 30; i++) {
        sendTick(100 + i, now + (i * 1100));
        await new Promise(r => setTimeout(r, 5));
    }

    const logs = executor.logs;
    const entries = logs.filter(l => l.type === "enter");
    
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].side).toBe("long");

    await bot.stop();
  });
});
