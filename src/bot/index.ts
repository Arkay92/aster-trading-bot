import dotenv from "dotenv";
import { resolve } from "path";

// Load .env.local first, fallback to .env
dotenv.config({ path: resolve(process.cwd(), ".env.local") });
dotenv.config({ path: resolve(process.cwd(), ".env") });
import { BotRunner } from "@/lib/bot/botRunner";
import { loadConfig } from "@/lib/config";
import { AsterV3Client } from "@/lib/execution/asterV3Client";
import { DryRunExecutor, LiveExecutor, PaperExecutor } from "@/lib/execution/executors";
import { initFileLogging } from "@/lib/logging/fileLogger";
import { BotLock } from "@/lib/runtime/botLock";
import { AsterTickStream } from "@/lib/tickStream";

const botLock = new BotLock("log/bot.lock");

async function main() {
  initFileLogging("log", "bot.log");
  const lock = botLock.acquire();
  if (!lock.ok) {
    console.error(lock.reason);
    process.exit(1);
  }

  const config = loadConfig();

  console.log("Fetching global 24h ticker data for pair ranking...");
  try {
    const client = new AsterV3Client(config.credentials);
    const tickers = await client.get24hTickers();
    const ranked = tickers
      .filter(t => t.symbol.endsWith("USDT"))
      .filter(t => Number(t.quoteVolume) > 5_000_000)
      .filter(t => Math.abs(Number(t.priceChangePercent)) < 18)
      .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
      .slice(0, 8)
      .map(t => `${t.symbol}-PERP`);
    
    if (ranked.length > 0) {
      console.log(`✅ Dynamic Pair Ranking Success. Picked top ${ranked.length} high-liquidity pairs.`);
      config.credentials.pairSymbols = ranked;
    }
  } catch (err) {
    console.warn("⚠️ Failed to fetch dynamic pair ranking. Falling back to .env pairs.");
  }
  
  // Safety warning for live mode
  if (config.mode === "live") {
    console.warn("=".repeat(80));
    console.warn("⚠️  WARNING: BOT IS RUNNING IN LIVE MODE ⚠️");
    console.warn("=".repeat(80));
    console.warn("This bot will execute REAL trades on AsterDEX with REAL money!");
    console.warn(`Trading pairs: ${config.credentials.pairSymbols.join(", ")}`);
    console.warn(`Max position size: ${config.risk.maxPositionSize} USDT`);
    console.warn(`Max leverage: ${config.risk.maxLeverage}x`);
    console.warn("=".repeat(80));
    console.warn("Press Ctrl+C within 5 seconds to cancel...");
    console.warn("=".repeat(80));
    
    // Give user 5 seconds to cancel
    await new Promise((resolve) => setTimeout(resolve, 5000));
    console.log("Starting bot in LIVE mode...\n");
  }
  
  const tickStreams = [new AsterTickStream(config.credentials.wsUrl, config.credentials.pairSymbols)];
  
  let executor;
  if (config.mode === "live") {
    executor = new LiveExecutor(config.credentials);
  } else if (config.mode === "paper") {
    executor = new PaperExecutor(config.paperTrading?.startingBalance ?? 10000);
  } else {
    executor = new DryRunExecutor();
  }
  
  // Confirm which executor is being used
  if (config.mode === "live") {
    console.log("✅ Using LiveExecutor - REAL trades will be executed on AsterDEX");
    console.log(`✅ API Endpoint: ${config.credentials.rpcUrl}`);
  } else if (config.mode === "paper") {
    console.log(`📄 Using PaperExecutor - Simulated trades against virtual balance of ${config.paperTrading?.startingBalance ?? 10000} USDT`);
  } else {
    console.log("ℹ️  Using DryRunExecutor - No real trades will be executed");
  }
  
  const bot = new BotRunner(config, tickStreams, executor);

  bot.on("log", (message, payload) => {
    if (payload) {
      console.log(`[LOG] ${message}`, payload);
    } else {
      console.log(`[LOG] ${message}`);
    }
  });

  bot.on("position", (position) => {
    console.log("[POSITION]", position);
  });

  await bot.start();

  const shutdown = async () => {
    console.log("Received shutdown signal, closing bot...");
    await bot.stop();
    botLock.release();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("Bot failed to start", error);
  botLock.release();
  process.exit(1);
});

