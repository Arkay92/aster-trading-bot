import { loadConfig } from "../config";

const originalEnv = process.env;

const baseEnv = {
  ASTER_RPC_URL: "https://fapi.asterdex.com",
  ASTER_WS_URL: "wss://fstream.asterdex.com/ws",
  PAIR_SYMBOL: "ASTERUSDT-PERP",
  MAX_POSITION_USDT: "100",
  MAX_LEVERAGE: "1",
  MAX_FLIPS_PER_HOUR: "1",
  MODE: "dry-run",
};

describe("loadConfig credential validation", () => {
  beforeEach(() => {
    process.env = { ...baseEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("does not require exchange credentials for dry-run mode", () => {
    const config = loadConfig();

    expect(config.mode).toBe("dry-run");
    expect(config.credentials.apiKey).toBe("");
    expect(config.credentials.privateKey).toBe("");
  });

  it("does not require exchange credentials for paper mode", () => {
    process.env.PAPER_TRADING = "true";

    const config = loadConfig();

    expect(config.mode).toBe("paper");
    expect(config.paperTrading?.startingBalance).toBe(10000);
  });

  it("requires exchange credentials for live mode", () => {
    process.env.MODE = "live";

    expect(() => loadConfig()).toThrow(/ASTER_API_KEY.*ASTER_PRIVATE_KEY/);
  });

  it("leaves dynamic pair ranking disabled unless explicitly enabled", () => {
    expect(loadConfig().enableDynamicPairRanking).toBe(false);

    process.env.ENABLE_DYNAMIC_PAIR_RANKING = "true";
    expect(loadConfig().enableDynamicPairRanking).toBe(true);
  });
});
