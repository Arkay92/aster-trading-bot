import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { mkdirSync } from "fs";

type LockMeta = {
  pid: number;
  createdAt: string;
};

export class BotLock {
  private readonly lockPath: string;
  private held = false;

  constructor(lockPath = "log/bot.lock") {
    this.lockPath = resolve(process.cwd(), lockPath);
  }

  acquire(): { ok: true } | { ok: false; reason: string } {
    const dir = dirname(this.lockPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    if (existsSync(this.lockPath)) {
      const existing = this.readMeta();
      if (existing && this.isPidAlive(existing.pid)) {
        return { ok: false, reason: `Another bot instance is running (PID ${existing.pid}).` };
      }
      this.safeRemoveLock();
    }

    try {
      const meta: LockMeta = { pid: process.pid, createdAt: new Date().toISOString() };
      writeFileSync(this.lockPath, JSON.stringify(meta, null, 2), { encoding: "utf8", flag: "wx" });
      this.held = true;
      return { ok: true };
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      return { ok: false, reason: `Failed to acquire bot lock: ${err}` };
    }
  }

  release(): void {
    if (!this.held) return;
    this.safeRemoveLock();
    this.held = false;
  }

  private readMeta(): LockMeta | null {
    try {
      const raw = readFileSync(this.lockPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<LockMeta>;
      if (typeof parsed.pid !== "number") return null;
      return { pid: parsed.pid, createdAt: parsed.createdAt || "" };
    } catch {
      return null;
    }
  }

  private isPidAlive(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private safeRemoveLock(): void {
    try {
      if (existsSync(this.lockPath)) unlinkSync(this.lockPath);
    } catch {
      // ignore
    }
  }
}

