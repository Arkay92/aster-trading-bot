import { createReadStream } from "fs";
import { createInterface } from "readline";
import type { SyntheticBar } from "../types";

export type HistoricalBar = SyntheticBar & {
  symbol: string;
};

type CsvRow = Record<string, string>;

const requiredHeaders = ["timestamp", "open", "high", "low", "close", "volume"];

export async function loadHistoricalCandles(filePath: string, fallbackSymbol = "BACKTEST-PERP"): Promise<HistoricalBar[]> {
  const rows: HistoricalBar[] = [];
  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let headers: string[] | null = null;
  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    if (!headers) {
      headers = splitCsvLine(line).map((h) => h.trim());
      validateHeaders(headers);
      continue;
    }

    const values = splitCsvLine(line);
    const row: CsvRow = {};
    headers.forEach((header, index) => {
      row[header] = values[index]?.trim() ?? "";
    });
    rows.push(toHistoricalBar(row, fallbackSymbol));
  }

  return rows.sort((a, b) => a.endTime - b.endTime);
}

function validateHeaders(headers: string[]): void {
  const lowerHeaders = headers.map((h) => h.toLowerCase());
  const missing = requiredHeaders.filter((header) => !lowerHeaders.includes(header));
  if (missing.length > 0) {
    throw new Error(`Historical CSV is missing required column(s): ${missing.join(", ")}`);
  }
}

function toHistoricalBar(row: CsvRow, fallbackSymbol: string): HistoricalBar {
  const normalized = Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]));
  const timestamp = parseTimestamp(normalized.timestamp);
  const open = parseNumber(normalized.open, "open");
  const high = parseNumber(normalized.high, "high");
  const low = parseNumber(normalized.low, "low");
  const close = parseNumber(normalized.close, "close");
  const volume = parseNumber(normalized.volume, "volume");
  const buyVolume = normalized.buyvolume ? parseNumber(normalized.buyvolume, "buyVolume") : volume / 2;
  const sellVolume = normalized.sellvolume ? parseNumber(normalized.sellvolume, "sellVolume") : Math.max(0, volume - buyVolume);

  return {
    symbol: normalized.symbol || fallbackSymbol,
    startTime: timestamp,
    endTime: timestamp,
    open,
    high,
    low,
    close,
    volume,
    buyVolume,
    sellVolume,
  };
}

function parseTimestamp(value: string): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(`Invalid timestamp: ${value}`);
}

function parseNumber(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${field}: ${value}`);
  return parsed;
}

function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current);
  return result;
}
