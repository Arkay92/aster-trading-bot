import { LiveExecutor } from "../executors";
import type { Credentials, TradeInstruction } from "../../types";

const mockNewOrder = jest.fn();
const mockChangeLeverage = jest.fn();
const mockGetOpenOrders = jest.fn();
const mockCancelOrder = jest.fn();
const mockGetAccount = jest.fn();

jest.mock("../asterV3Client", () => ({
  AsterV3Client: jest.fn().mockImplementation(() => ({
    newOrder: mockNewOrder,
    changeLeverage: mockChangeLeverage,
    getOpenOrders: mockGetOpenOrders,
    cancelOrder: mockCancelOrder,
    getAccount: mockGetAccount,
  })),
}));

describe("LiveExecutor retry handling", () => {
  const credentials: Credentials = {
    rpcUrl: "http://localhost:8545",
    wsUrl: "ws://localhost:8546",
    apiKey: "test",
    privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    pairSymbols: ["BTCUSDT"],
  };

  const order: TradeInstruction = {
    symbol: "BTCUSDT-PERP",
    side: "long",
    size: 0.1,
    leverage: 1,
    price: 100,
    signalReason: "test",
    timestamp: 1,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockChangeLeverage.mockResolvedValue({});
    mockGetOpenOrders.mockResolvedValue([]);
    mockCancelOrder.mockResolvedValue({});
    mockGetAccount.mockResolvedValue({ positions: [] });
  });

  it("retries transient market order failures with bounded backoff", async () => {
    mockNewOrder
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockResolvedValueOnce({ orderId: 123 });

    const executor = new LiveExecutor(credentials, {
      risk: {
        execution: {
          maxOrderRetries: 1,
          orderRetryBaseDelayMs: 1,
          orderRetryMaxDelayMs: 1,
        },
      },
    });

    await executor.enterLong(order);

    expect(mockNewOrder).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable exchange rejections", async () => {
    mockNewOrder.mockRejectedValueOnce(new Error("-5018 notional limit reached"));

    const executor = new LiveExecutor(credentials, {
      risk: {
        execution: {
          maxOrderRetries: 3,
          orderRetryBaseDelayMs: 1,
          orderRetryMaxDelayMs: 1,
        },
      },
    });

    await expect(executor.enterLong(order)).rejects.toThrow("-5018");
    expect(mockNewOrder).toHaveBeenCalledTimes(1);
  });
});
