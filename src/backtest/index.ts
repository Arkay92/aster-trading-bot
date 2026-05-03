import dotenv from "dotenv";
import { resolve } from "path";
import { loadConfig } from "../lib/config";
import { loadHistoricalCandles } from "../lib/backtest/dataLoader";
import { SimulationEngine } from "../lib/backtest/simulationEngine";

dotenv.config({ path: resolve(process.cwd(), ".env.local") });
dotenv.config({ path: resolve(process.cwd(), ".env") });

type CliArgs = {
  file?: string;
  symbol?: string;
  balance?: number;
  positionSize?: number;
  feeRate?: number;
  slippage?: number;
  pessimistic?: boolean;
  tickSize?: number;
  missedFillPct?: number;
  latencyBars?: number;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    throw new Error("Missing --file path/to/candles.csv");
  }

  const config = loadConfig({
    mode: "paper",
    paperTrading: { enabled: true, startingBalance: args.balance ?? 10_000 },
  });
  const bars = await loadHistoricalCandles(args.file, args.symbol ?? config.credentials.pairSymbols[0] ?? "BACKTEST-PERP");
  const engine = new SimulationEngine(config, {
    startingBalance: args.balance ?? 10_000,
    positionSizeUsdt: args.positionSize ?? config.risk.maxPositionSize,
    feeRatePct: args.feeRate,
    slippagePct: args.slippage,
    pessimisticMode: args.pessimistic,
    tickSize: args.tickSize,
    missedFillPct: args.missedFillPct,
    latencyBars: args.latencyBars,
  });
  const result = engine.run(bars);

  console.log("Backtest complete");
  console.table({
    candles: bars.length,
    trades: result.metrics.trades,
    wins: result.metrics.wins,
    losses: result.metrics.losses,
    winRatePct: result.metrics.winRatePct.toFixed(2),
    totalPnl: result.metrics.totalPnl.toFixed(4),
    endingBalance: result.metrics.endingBalance.toFixed(4),
    returnPct: result.metrics.returnPct.toFixed(2),
    maxDrawdown: result.metrics.maxDrawdown.toFixed(4),
    profitFactor: Number.isFinite(result.metrics.profitFactor) ? result.metrics.profitFactor.toFixed(2) : "Infinity",
    expectancy: result.metrics.expectancy.toFixed(4),
  });
  if (Object.keys(result.metrics.byVolatilityRegime).length > 0) {
    console.log("PnL by volatility regime");
    console.table(result.metrics.byVolatilityRegime);
  }

  if (result.trades.length > 0) {
    console.table(result.trades.slice(-10).map((trade) => ({
      symbol: trade.symbol,
      side: trade.side,
      entry: trade.entryPrice.toFixed(6),
      exit: trade.exitPrice.toFixed(6),
      pnl: trade.pnl.toFixed(4),
      exitReason: trade.exitReason,
    })));
  }
}

function parseArgs(args: string[]): CliArgs {
  const parsed: CliArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (!arg.startsWith("--")) continue;

    const [key, inlineValue] = arg.slice(2).split("=");
    if (key === "pessimistic" && inlineValue === undefined) {
      parsed.pessimistic = true;
      continue;
    }
    const value = inlineValue ?? next;
    if (inlineValue === undefined) i++;

    if (key === "file") parsed.file = value;
    else if (key === "symbol") parsed.symbol = value;
    else if (key === "balance") parsed.balance = Number(value);
    else if (key === "position-size") parsed.positionSize = Number(value);
    else if (key === "fee-rate") parsed.feeRate = Number(value);
    else if (key === "slippage") parsed.slippage = Number(value);
    else if (key === "pessimistic") parsed.pessimistic = value !== "false";
    else if (key === "tick-size") parsed.tickSize = Number(value);
    else if (key === "missed-fill-pct") parsed.missedFillPct = Number(value);
    else if (key === "latency-bars") parsed.latencyBars = Number(value);
  }
  return parsed;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
