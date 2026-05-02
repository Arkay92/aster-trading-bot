import dotenv from "dotenv";
import { resolve } from "path";
import { LiveExecutor } from "../src/lib/execution/liveExecutor";
import { loadConfig } from "../src/lib/config";
import type { TradeInstruction } from "../src/lib/types";

dotenv.config({ path: resolve(process.cwd(), ".env.local") });
dotenv.config({ path: resolve(process.cwd(), ".env") });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getBtcPrice(rpcUrl: string): Promise<number> {
  const url = `${rpcUrl}/fapi/v1/ticker/price?symbol=BTCUSDT`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Price fetch failed: ${res.status}`);
  const payload = (await res.json()) as { price?: string };
  const price = Number(payload.price || 0);
  if (!Number.isFinite(price) || price <= 0) throw new Error("Invalid BTC price");
  return price;
}

async function main() {
  const config = loadConfig();
  if (config.mode !== "live") {
    throw new Error("Set MODE=live before running this test.");
  }

  const executor = new LiveExecutor(config.credentials);
  const price = await getBtcPrice(config.credentials.rpcUrl);
  const size = Number((1 / price).toFixed(6));

  const order: TradeInstruction = {
    symbol: "BTCUSDT-PERP",
    side: "long",
    size,
    leverage: Math.max(1, config.risk.maxLeverage),
    price,
    signalReason: "manual-test-buy-1usd",
    timestamp: Date.now(),
  };

  console.log("[TEST] BTC price:", price);
  console.log("[TEST] Qty for ~$1:", size);
  console.log("[TEST] Placing BUY...");
  await executor.enterLong(order);

  console.log("[TEST] Waiting 30s...");
  await sleep(30_000);

  console.log("[TEST] Closing position...");
  await executor.closePosition("BTCUSDT-PERP", "manual-test-close-30s", { waitMs: 30_000 });
  console.log("[TEST] Done.");
}

main().catch((error) => {
  console.error("[TEST] Failed:", error);
  process.exit(1);
});

