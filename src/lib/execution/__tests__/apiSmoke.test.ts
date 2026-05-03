import { AsterV3Client } from "../asterV3Client";
import { SignedRequestLock } from "../signedRequestLock";
import { Credentials } from "../../types";
import dotenv from "dotenv";

dotenv.config();

/**
 * Smoke test to verify connectivity and authentication with the Aster V3 API.
 * This runs against the real RPC/API specified in .env.
 */
describe("Aster API Smoke Test", () => {
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
});
