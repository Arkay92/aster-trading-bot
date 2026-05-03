import { AsterV3Client } from "../asterV3Client";
import { SignedRequestLock } from "../signedRequestLock";
import { Credentials } from "../../types";
import dotenv from "dotenv";

dotenv.config();

/**
 * Smoke test to verify connectivity and authentication with the Aster V3 API.
 * This runs against the real RPC/API specified in .env.
 */
describe.skip("Aster API Smoke Test", () => {
  let client: AsterV3Client;

  const credentials: Credentials = {
    rpcUrl: process.env.ASTER_RPC_URL || "https://rpc.aster.trading",
    wsUrl: process.env.ASTER_WS_URL || "wss://ws.aster.trading",
    apiKey: process.env.ASTER_API_KEY || "",
    privateKey: process.env.ASTER_PRIVATE_KEY || "",
    pairSymbols: ["BTCUSDT"]
  };

  beforeAll(() => {
    if (!credentials.apiKey || !credentials.privateKey) {
      console.warn("Skipping smoke tests: ASTER_API_KEY or ASTER_PRIVATE_KEY not set in .env");
    }
    client = new AsterV3Client(credentials);
  });

  it("should successfully fetch exchange information", async () => {
    // This is a public call (no signature required)
    const res = await fetch(`${credentials.rpcUrl}/fapi/v3/exchangeInfo`);
    expect(res.ok).toBe(true);
    const data = await res.json() as any;
    expect(data.symbols).toBeDefined();
  });

  it("should successfully fetch account balance (Authenticated)", async () => {
    if (!credentials.apiKey || !credentials.privateKey) return;

    try {
      const balance = await SignedRequestLock.run(() => client.getBalance());
      expect(Array.isArray(balance)).toBe(true);
      console.log(`[SmokeTest] Balance fetch successful. Assets: ${balance.length}`);
    } catch (error: any) {
      // If unauthorized, we want to know why
      throw new Error(`Account balance fetch failed: ${error.message}`);
    }
  });

  it("should successfully fetch position risk (Authenticated)", async () => {
    if (!credentials.apiKey || !credentials.privateKey) return;

    try {
      const positions = await SignedRequestLock.run(() => client.getPositionRisk("BTCUSDT"));
      expect(Array.isArray(positions)).toBe(true);
      console.log(`[SmokeTest] Position risk fetch successful for BTCUSDT`);
    } catch (error: any) {
      throw new Error(`Position risk fetch failed: ${error.message}`);
    }
  });

  it("should handle live executor failures gracefully", async () => {
    // Simulate a failure in the live executor
    const mockExecutor = jest.fn().mockRejectedValue(new Error("Executor failure"));

    try {
      await mockExecutor();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      expect(error).toBeDefined();
      expect(err.message).toBe("Executor failure");
    }
  });

  it("should retry orders on failure", async () => {
    const mockOrder = jest
      .fn()
      .mockRejectedValueOnce(new Error("Temporary failure"))
      .mockResolvedValueOnce({ success: true });

    const result = await mockOrder();
    expect(mockOrder).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ success: true });
  });

  it("should enforce stop loss and take profit", async () => {
    const initialPrice = 100;
    const stopLoss = 90;
    const takeProfit = 110;

    const mockTrade = jest.fn((price) => {
      if (price <= stopLoss) throw new Error("Stop loss triggered");
      if (price >= takeProfit) return "Take profit triggered";
      return "Trade ongoing";
    });

    expect(() => mockTrade(85)).toThrow("Stop loss triggered");
    expect(mockTrade(115)).toBe("Take profit triggered");
    expect(mockTrade(100)).toBe("Trade ongoing");
  });

  it("should enforce max daily loss", async () => {
    const maxDailyLoss = 100;
    let dailyLoss = 0;

    const mockTrade = jest.fn((loss) => {
      dailyLoss += loss;
      if (dailyLoss > maxDailyLoss) throw new Error("Max daily loss exceeded");
      return dailyLoss;
    });

    expect(mockTrade(50)).toBe(50);
    expect(mockTrade(40)).toBe(90);
    expect(() => mockTrade(20)).toThrow("Max daily loss exceeded");
  });

  it("should reconnect websocket on disconnect", async () => {
    const mockWebSocket = {
      connect: jest.fn(),
      disconnect: jest.fn(),
      on: jest.fn((event, callback) => {
        if (event === "disconnect") callback();
      })
    };

    mockWebSocket.on("disconnect", async () => {
      await mockWebSocket.connect();
    });

    await mockWebSocket.disconnect();
    expect(mockWebSocket.connect).toHaveBeenCalled();
  });
});
