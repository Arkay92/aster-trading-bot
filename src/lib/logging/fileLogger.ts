import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

let initialized = false;

function formatLine(level: "INFO" | "WARN" | "ERROR", args: unknown[]): string {
  const ts = new Date().toISOString();
  const parts = args.map((a) => {
    if (typeof a === "string") return a;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  });
  return `[${ts}] [${level}] ${parts.join(" ")}\n`;
}

export function initFileLogging(logDir = "log", fileName = "bot.log"): void {
  if (initialized) return;
  initialized = true;

  const dir = join(process.cwd(), logDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filePath = join(dir, fileName);

  const originalLog = console.log.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);

  console.log = (...args: unknown[]) => {
    originalLog(...args);
    try {
      appendFileSync(filePath, formatLine("INFO", args), "utf8");
    } catch (e) {
      originalError("[FileLogger] Failed to append log", e);
    }
  };

  console.warn = (...args: unknown[]) => {
    originalWarn(...args);
    try {
      appendFileSync(filePath, formatLine("WARN", args), "utf8");
    } catch (e) {
      originalError("[FileLogger] Failed to append warn", e);
    }
  };

  console.error = (...args: unknown[]) => {
    originalError(...args);
    try {
      appendFileSync(filePath, formatLine("ERROR", args), "utf8");
    } catch (e) {
      originalError("[FileLogger] Failed to append error", e);
    }
  };
}

