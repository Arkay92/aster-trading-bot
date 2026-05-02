import dotenv from "dotenv";
import { resolve } from "path";

// Load .env.local first, fallback to .env
dotenv.config({ path: resolve(process.cwd(), ".env.local") });
dotenv.config({ path: resolve(process.cwd(), ".env") });
import { BotRunner } from "@/lib/bot/botRunner";
import { loadConfig } from "@/lib/config";
import { DryRunExecutor } from "@/lib/execution/dryRunExecutor";
import { LiveExecutor } from "@/lib/execution/liveExecutor";
import { PaperExecutor } from "@/lib/execution/paperExecutor";
import { initFileLogging } from "@/lib/logging/fileLogger";
import { AsterTickStream } from "@/lib/tickStream";

async function main() {
  initFileLogging("log", "bot.log");
  const config = loadConfig();
  
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
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("Bot failed to start", error);
  process.exit(1);
});

