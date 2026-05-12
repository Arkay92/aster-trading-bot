import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import type { LocalPositionState } from "./positionState";

type PersistedState = {
  positions: Record<string, LocalPositionState>;
  lastBarCloseTime: number;
  runtimeRisk?: RuntimeRiskState;
  timestamp: number;
};

export type RuntimeRiskState = {
  dayKey: string;
  dailyRealizedPnl: number;
  dailyStartBalance: number;
  dailyPeakPnl: number;
  consecutiveLosses: number;
  riskHalted: boolean;
  lastRiskProcessedTradeId?: string;
  flipHistory?: number[];
  symbolTradeCountInLastHour?: Record<string, number[]>;
  lastEntryAt?: Record<string, number>;
  cooldownUntil?: Record<string, number>;
};

export class StatePersistence {
  private readonly stateFile: string;

  constructor(dataDir: string = "./data") {
    this.stateFile = join(dataDir, "bot-state.json");
  }

  save(state: { positions: Map<string, LocalPositionState>; lastBarCloseTime: number; runtimeRisk?: RuntimeRiskState }): void {
    try {
      const dir = dirname(this.stateFile);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      
      const persisted: PersistedState = {
        positions: Object.fromEntries(state.positions),
        lastBarCloseTime: state.lastBarCloseTime,
        runtimeRisk: state.runtimeRisk,
        timestamp: Date.now(),
      };
      
      writeFileSync(this.stateFile, JSON.stringify(persisted, null, 2), "utf-8");
    } catch (error) {
      console.error("[StatePersistence] Failed to save state", error);
    }
  }

  load(): { positions: Map<string, LocalPositionState>; lastBarCloseTime: number; runtimeRisk?: RuntimeRiskState } | null {
    try {
      if (!existsSync(this.stateFile)) {
        return null;
      }
      const content = readFileSync(this.stateFile, "utf-8");
      const persisted: PersistedState = JSON.parse(content);
      
      const age = Date.now() - persisted.timestamp;
      if (age > 48 * 60 * 60 * 1000) {
        console.log("[StatePersistence] State too old, ignoring");
        return null;
      }
      
      return {
        positions: new Map(Object.entries(persisted.positions || {})),
        lastBarCloseTime: persisted.lastBarCloseTime,
        runtimeRisk: persisted.runtimeRisk,
      };
    } catch (error) {
      console.error("[StatePersistence] Failed to load state", error);
      return null;
    }
  }

  clear(): void {
    try {
      if (existsSync(this.stateFile)) {
        writeFileSync(this.stateFile, "{}", "utf-8");
      }
    } catch (error) {
      console.error("[StatePersistence] Failed to clear state", error);
    }
  }

  applyRiskLimits(state: { positions: Map<string, LocalPositionState>; dailyLoss: number }, maxDailyLoss: number): void {
    if (state.dailyLoss > maxDailyLoss) {
      console.error("[StatePersistence] Max daily loss exceeded. Halting trading.");
      throw new Error("Max daily loss exceeded");
    }
  }
}
