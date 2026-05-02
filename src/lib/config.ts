import { z } from "zod";
import { defaultWatermellonConfig } from "./spec";
import type {
  AppConfig,
  EmaCrossConfig,
  Mode,
  PeachConfig,
  RiskConfig,
  RsiReversionConfig,
  StrategyType,
  SwingConfig,
  WatermellonConfig,
} from "./types";

const envBoolean = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off", ""].includes(normalized)) return false;
  }
  return value;
}, z.boolean());

const envSchema = z.object({
  ASTER_RPC_URL: z.string().url(),
  ASTER_WS_URL: z.string().url(),
  ASTER_API_KEY: z.string().min(1, "API key is required"),
  ASTER_PRIVATE_KEY: z.string().min(1, "Private key is required"),
  ASTER_USER_ADDRESS: z.string().optional(),
  ASTER_SIGNER_ADDRESS: z.string().optional(),
  ASTER_SIGNER_PRIVATE_KEY: z.string().optional(),
  PAIR_SYMBOL: z.string().min(1, "Trading pair is required"),
  MAX_POSITION_USDT: z.coerce.number().positive(),
  MAX_LEVERAGE: z.coerce.number().positive(),
  MAX_FLIPS_PER_HOUR: z.coerce.number().int().nonnegative(),
  STOP_LOSS_PCT: z.coerce.number().optional(),
  TAKE_PROFIT_PCT: z.coerce.number().optional(),
  POSITION_SIZE_PCT: z.coerce.number().min(0).max(100).optional(),
  QUIET_SIGNAL_LOGS: envBoolean.optional(),
  STRATEGY_OWNERSHIP_TIMEOUT_BARS: z.coerce.number().int().min(0).optional(),
  RUN_ALL_STRATEGIES: envBoolean.optional(),
  REQUIRE_TRENDING_MARKET: envBoolean.optional(),
  ADX_THRESHOLD: z.coerce.number().min(0).max(100).optional(),
  MODE: z.enum(["dry-run", "live"]),
  PAPER_TRADING: envBoolean.optional(),
  PAPER_STARTING_BALANCE: z.coerce.number().positive().optional(),
  STRATEGY_TYPE: z.enum(["watermellon", "peach-hybrid", "swing", "ema-cross", "rsi-reversion"]).optional(),
  VIRTUAL_TIMEFRAME_MS: z.coerce.number().optional(),
  // Watermellon params
  EMA_FAST: z.coerce.number().optional(),
  EMA_MID: z.coerce.number().optional(),
  EMA_SLOW: z.coerce.number().optional(),
  RSI_LENGTH: z.coerce.number().optional(),
  RSI_MIN_LONG: z.coerce.number().optional(),
  RSI_MAX_SHORT: z.coerce.number().optional(),
  // Peach Hybrid V1 params
  PEACH_V1_EMA_FAST: z.coerce.number().optional(),
  PEACH_V1_EMA_MID: z.coerce.number().optional(),
  PEACH_V1_EMA_SLOW: z.coerce.number().optional(),
  PEACH_V1_EMA_MICRO_FAST: z.coerce.number().optional(),
  PEACH_V1_EMA_MICRO_SLOW: z.coerce.number().optional(),
  PEACH_V1_RSI_LENGTH: z.coerce.number().optional(),
  PEACH_V1_RSI_MIN_LONG: z.coerce.number().optional(),
  PEACH_V1_RSI_MAX_SHORT: z.coerce.number().optional(),
  PEACH_V1_MIN_BARS_BETWEEN: z.coerce.number().optional(),
  PEACH_V1_MIN_MOVE_PCT: z.coerce.number().optional(),
  // Peach Hybrid V2 params
  PEACH_V2_EMA_FAST: z.coerce.number().optional(),
  PEACH_V2_EMA_MID: z.coerce.number().optional(),
  PEACH_V2_EMA_SLOW: z.coerce.number().optional(),
  PEACH_V2_RSI_MOMENTUM_THRESHOLD: z.coerce.number().optional(),
  PEACH_V2_VOLUME_LOOKBACK: z.coerce.number().optional(),
  PEACH_V2_VOLUME_MULTIPLIER: z.coerce.number().optional(),
  PEACH_V2_EXIT_VOLUME_MULTIPLIER: z.coerce.number().optional(),
  // Swing strategy params
  SWING_EMA_TREND_LEN: z.coerce.number().optional(),
  SWING_RSI_LENGTH: z.coerce.number().optional(),
  SWING_RSI_DIP_THRESHOLD: z.coerce.number().optional(),
  SWING_RSI_HIGH_THRESHOLD: z.coerce.number().optional(),
  SWING_LOOKBACK_BARS: z.coerce.number().optional(),
  SWING_DIP_PCT_FROM_HIGH: z.coerce.number().optional(),
  SWING_BOUNCE_CONFIRM_PCT: z.coerce.number().optional(),
  // EMA Cross strategy
  EMA_CROSS_FAST_LEN: z.coerce.number().optional(),
  EMA_CROSS_SLOW_LEN: z.coerce.number().optional(),
  EMA_CROSS_RSI_LENGTH: z.coerce.number().optional(),
  EMA_CROSS_RSI_MIN_LONG: z.coerce.number().optional(),
  EMA_CROSS_RSI_MAX_SHORT: z.coerce.number().optional(),
  // RSI Reversion strategy
  RSI_REV_RSI_LENGTH: z.coerce.number().optional(),
  RSI_REV_OVERSOLD: z.coerce.number().optional(),
  RSI_REV_OVERBOUGHT: z.coerce.number().optional(),
  RSI_REV_EMA_TREND_LEN: z.coerce.number().optional(),
  // Risk management
  USE_STOP_LOSS: envBoolean.optional(),
  EMERGENCY_STOP_LOSS_PCT: z.coerce.number().optional(),
  MAX_POSITIONS: z.coerce.number().optional(),
  MAX_POSITIONS_PER_STRATEGY: z.coerce.number().optional(),
  MAX_POSITIONS_WATERMELLON: z.coerce.number().optional(),
  MAX_POSITIONS_PEACH_HYBRID: z.coerce.number().optional(),
  MAX_POSITIONS_SWING: z.coerce.number().optional(),
  MAX_POSITIONS_EMA_CROSS: z.coerce.number().optional(),
  MAX_POSITIONS_RSI_REVERSION: z.coerce.number().optional(),
});

const formatErrors = (issues: z.ZodIssue[]): string =>
  issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`).join("; ");

export const loadConfig = (overrides?: Partial<AppConfig>): AppConfig => {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${formatErrors(parsed.error.issues)}`);
  }

  const env = parsed.data;
  const strategyType = env.STRATEGY_TYPE ?? "watermellon";
  const enabledStrategyTypes: StrategyType[] = env.RUN_ALL_STRATEGIES
    ? ["watermellon", "peach-hybrid", "swing", "ema-cross", "rsi-reversion"]
    : [strategyType];

  const watermellonStrategy: WatermellonConfig = {
    ...defaultWatermellonConfig,
    timeframeMs: env.VIRTUAL_TIMEFRAME_MS || defaultWatermellonConfig.timeframeMs,
    emaFastLen: env.EMA_FAST || defaultWatermellonConfig.emaFastLen,
    emaMidLen: env.EMA_MID || defaultWatermellonConfig.emaMidLen,
    emaSlowLen: env.EMA_SLOW || defaultWatermellonConfig.emaSlowLen,
    rsiLength: env.RSI_LENGTH || defaultWatermellonConfig.rsiLength,
    rsiMinLong: env.RSI_MIN_LONG || defaultWatermellonConfig.rsiMinLong,
    rsiMaxShort: env.RSI_MAX_SHORT || defaultWatermellonConfig.rsiMaxShort,
  };
  const peachStrategy: PeachConfig = {
    timeframeMs: env.VIRTUAL_TIMEFRAME_MS || 30_000,
    v1: {
      emaFastLen: env.PEACH_V1_EMA_FAST || 8,
      emaMidLen: env.PEACH_V1_EMA_MID || 21,
      emaSlowLen: env.PEACH_V1_EMA_SLOW || 48,
      emaMicroFastLen: env.PEACH_V1_EMA_MICRO_FAST || 5,
      emaMicroSlowLen: env.PEACH_V1_EMA_MICRO_SLOW || 13,
      rsiLength: env.PEACH_V1_RSI_LENGTH || 14,
      rsiMinLong: env.PEACH_V1_RSI_MIN_LONG || 42.0,
      rsiMaxShort: env.PEACH_V1_RSI_MAX_SHORT || 58.0,
      minBarsBetween: env.PEACH_V1_MIN_BARS_BETWEEN || 1,
      minMovePercent: env.PEACH_V1_MIN_MOVE_PCT || 0.10,
    },
    v2: {
      emaFastLen: env.PEACH_V2_EMA_FAST || 3,
      emaMidLen: env.PEACH_V2_EMA_MID || 8,
      emaSlowLen: env.PEACH_V2_EMA_SLOW || 13,
      rsiMomentumThreshold: env.PEACH_V2_RSI_MOMENTUM_THRESHOLD || 3.0,
      volumeLookback: env.PEACH_V2_VOLUME_LOOKBACK || 4,
      volumeMultiplier: env.PEACH_V2_VOLUME_MULTIPLIER || 1.5,
      exitVolumeMultiplier: env.PEACH_V2_EXIT_VOLUME_MULTIPLIER || 1.2,
    },
  };
  const swingStrategy: SwingConfig = {
    timeframeMs: env.VIRTUAL_TIMEFRAME_MS || 30_000,
    emaTrendLen: env.SWING_EMA_TREND_LEN || 50,
    rsiLength: env.SWING_RSI_LENGTH || 14,
    rsiDipThreshold: env.SWING_RSI_DIP_THRESHOLD || 35,
    rsiHighThreshold: env.SWING_RSI_HIGH_THRESHOLD || 65,
    lookbackBars: env.SWING_LOOKBACK_BARS || 20,
    dipPercentFromHigh: env.SWING_DIP_PCT_FROM_HIGH || 1.5,
    bounceConfirmPercent: env.SWING_BOUNCE_CONFIRM_PCT || 0.3,
  };
  const emaCrossStrategy: EmaCrossConfig = {
    timeframeMs: env.VIRTUAL_TIMEFRAME_MS || 30_000,
    emaFastLen: env.EMA_CROSS_FAST_LEN || 9,
    emaSlowLen: env.EMA_CROSS_SLOW_LEN || 26,
    rsiLength: env.EMA_CROSS_RSI_LENGTH || 14,
    rsiMinLong: env.EMA_CROSS_RSI_MIN_LONG || 45,
    rsiMaxShort: env.EMA_CROSS_RSI_MAX_SHORT || 55,
  };
  const rsiReversionStrategy: RsiReversionConfig = {
    timeframeMs: env.VIRTUAL_TIMEFRAME_MS || 30_000,
    rsiLength: env.RSI_REV_RSI_LENGTH || 14,
    rsiOversold: env.RSI_REV_OVERSOLD || 30,
    rsiOverbought: env.RSI_REV_OVERBOUGHT || 70,
    emaTrendLen: env.RSI_REV_EMA_TREND_LEN || 50,
  };

  const strategies = {
    "watermellon": watermellonStrategy,
    "peach-hybrid": peachStrategy,
    "swing": swingStrategy,
    "ema-cross": emaCrossStrategy,
    "rsi-reversion": rsiReversionStrategy,
  } as const;
  const strategy = strategies[strategyType];

  const risk: RiskConfig = {
    maxPositionSize: env.MAX_POSITION_USDT,
    maxLeverage: env.MAX_LEVERAGE,
    maxFlipsPerHour: env.MAX_FLIPS_PER_HOUR,
    stopLossPct: env.STOP_LOSS_PCT ?? undefined,
    takeProfitPct: env.TAKE_PROFIT_PCT ?? undefined,
    useStopLoss: env.USE_STOP_LOSS ?? false,
    emergencyStopLoss: env.EMERGENCY_STOP_LOSS_PCT ?? 2.0,
    maxPositions: env.MAX_POSITIONS ?? 1,
    positionSizePct: env.POSITION_SIZE_PCT ?? undefined,
    requireTrendingMarket: env.REQUIRE_TRENDING_MARKET ?? false,
    adxThreshold: env.ADX_THRESHOLD ?? 25,
    quietSignalLogs: env.QUIET_SIGNAL_LOGS ?? true,
    strategyOwnershipTimeoutBars: env.STRATEGY_OWNERSHIP_TIMEOUT_BARS ?? 6,
    perStrategyMaxPositions: {
      "watermellon": env.MAX_POSITIONS_WATERMELLON ?? env.MAX_POSITIONS_PER_STRATEGY ?? env.MAX_POSITIONS ?? 1,
      "peach-hybrid": env.MAX_POSITIONS_PEACH_HYBRID ?? env.MAX_POSITIONS_PER_STRATEGY ?? env.MAX_POSITIONS ?? 1,
      "swing": env.MAX_POSITIONS_SWING ?? env.MAX_POSITIONS_PER_STRATEGY ?? env.MAX_POSITIONS ?? 1,
      "ema-cross": env.MAX_POSITIONS_EMA_CROSS ?? env.MAX_POSITIONS_PER_STRATEGY ?? env.MAX_POSITIONS ?? 1,
      "rsi-reversion": env.MAX_POSITIONS_RSI_REVERSION ?? env.MAX_POSITIONS_PER_STRATEGY ?? env.MAX_POSITIONS ?? 1,
    },
  };

  const isPaper = env.PAPER_TRADING ?? false;
  const mode = isPaper ? "paper" : env.MODE;

  const config: AppConfig = {
    mode: mode as Mode,
    paperTrading: isPaper
      ? { enabled: true, startingBalance: env.PAPER_STARTING_BALANCE ?? 10000 }
      : undefined,
    strategyType: strategyType as StrategyType,
    strategyTypes: enabledStrategyTypes,
    strategies,
    credentials: {
      rpcUrl: env.ASTER_RPC_URL,
      wsUrl: env.ASTER_WS_URL,
      apiKey: env.ASTER_API_KEY,
      privateKey: env.ASTER_PRIVATE_KEY,
      userAddress: env.ASTER_USER_ADDRESS || undefined,
      signerAddress: env.ASTER_SIGNER_ADDRESS || undefined,
      signerPrivateKey: env.ASTER_SIGNER_PRIVATE_KEY || undefined,
      pairSymbols: env.PAIR_SYMBOL.split(",").map((s) => s.trim()).filter(Boolean),
    },
    strategy,
    risk,
  };

  return overrides ? mergeConfig(config, overrides) : config;
};

const mergeConfig = (base: AppConfig, overrides: Partial<AppConfig>): AppConfig => ({
  ...base,
  ...overrides,
  credentials: { ...base.credentials, ...overrides?.credentials },
  strategy: { ...base.strategy, ...overrides?.strategy },
  risk: { ...base.risk, ...overrides?.risk },
});

