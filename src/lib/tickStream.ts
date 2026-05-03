import EventEmitter from "events";
import WebSocket from "ws";
import type { Tick } from "./types";

type TickEvents = {
  tick: (tick: Tick) => void;
  error: (error: Error) => void;
  close: () => void;
};

// AsterDEX WebSocket format: Based on reference code, uses Binance-compatible format
const defaultSubscribePayload = (pairs: string[]) => {
  const params = pairs.map(pair => {
    // Convert ASTERUSDT-PERP to ASTERUSDT (remove -PERP suffix, uppercase)
    const streamName = pair.toUpperCase().replace(/-PERP$/, "");
    // Binance futures format: lowercase symbol@aggTrade
    return `${streamName.toLowerCase()}@aggTrade`;
  });

  return {
    method: "SUBSCRIBE",
    params,
    id: 1,
  };
};

type MessageParser = (raw: WebSocket.RawData) => Tick[] | null;

const coerceNumber = (value: unknown): number | null => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const defaultParser: MessageParser = (raw) => {
  try {
    const payload = JSON.parse(raw.toString());

    // AsterDEX WebSocket format (combined streams): { stream: "asterusdt@aggTrade", data: { ... } }
    if (payload.stream && payload.data) {
      const trade = payload.data;
      const rawSymbol = (trade.s || payload.stream.split("@")[0] || "").toUpperCase();
      const symbol = rawSymbol.endsWith("-PERP") ? rawSymbol : `${rawSymbol}-PERP`;
      const price = coerceNumber(trade.p);
      const size = coerceNumber(trade.q);
      const timestamp = coerceNumber(trade.T) ?? Date.now();

      if (price === null) return null;

      return [{ symbol, price, size: size ?? 0, timestamp }];
    }

    // Direct trade object (single stream format)
    if (payload.p || payload.price) {
      const symbol = (payload.s || "").toUpperCase();
      const price = coerceNumber(payload.p) ?? coerceNumber(payload.price);
      const size = coerceNumber(payload.q) ?? coerceNumber(payload.quantity);
      const timestamp = coerceNumber(payload.T) ?? coerceNumber(payload.timestamp) ?? Date.now();

      if (price === null) return null;

      // If symbol is missing in payload, we can't reliably route it in a multi-stream setup
      // unless we used the 'stream' property above. 
      // Most Binance-compatible servers include "s" in the aggTrade payload.
      const finalSymbol = symbol ? (symbol.endsWith("-PERP") ? symbol : `${symbol}-PERP`) : "UNKNOWN";

      return [{ symbol: finalSymbol, price, size: size ?? 0, timestamp }];
    }

    return null;
  } catch (error) {
    console.error("Failed to parse tick message", error);
    return null;
  }
};

export class AsterTickStream {
  private readonly emitter = new EventEmitter();
  private ws: WebSocket | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private lastMessageTime = 0;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private readonly heartbeatIntervalMs = 60_000; // 1 minute
  private readonly wsTimeoutMs = 300_000; // 5 minutes
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private messageCount = 0;
  private emittedTickCount = 0;
  private droppedTickCount = 0;
  private lastFlowLog = 0;

  constructor(
    private readonly url: string,
    private readonly pairSymbols: string[],
    private readonly parser: MessageParser = defaultParser,
    private readonly subscribePayloadBuilder: (pairs: string[]) => unknown = defaultSubscribePayload,
  ) { }

  async start(): Promise<void> {
    await this.stop();

    // Construct URL for multiple streams if possible, or use base /ws
    // For AsterDEX, we'll use the base /ws and send a SUBSCRIBE command
    const wsUrl = this.url.endsWith("/ws") ? this.url : `${this.url}/ws`;

    console.log(`[TickStream] Connecting to ${wsUrl} for ${this.pairSymbols.length} pairs...`);

    this.ws = new WebSocket(wsUrl, {
      headers: {
        "User-Agent": "Watermellon-bot/0.1",
      },
    });

    this.ws.on("open", () => {
      console.log(`[TickStream] WebSocket connected to ${this.url}`);
      this.reconnectAttempts = 0;
      this.lastMessageTime = Date.now();
      this.startHeartbeat();

      const payload = this.subscribePayloadBuilder(this.pairSymbols);
      console.log(`[TickStream] Subscribing to:`, JSON.stringify(payload, null, 2));

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(payload));
      }
    });

    this.ws.on("message", (raw) => {
      this.lastMessageTime = Date.now();
      this.messageCount++;
      const message = raw.toString();

      try {
        const parsed = JSON.parse(message);
        // Subscription confirmation payloads are typically { result: null, id: 1 }.
        // Do not treat any payload with an "id" field as confirmation because some
        // trade payload formats include id-like fields too.
        if ("result" in parsed && "id" in parsed && parsed.result === null) {
          console.log(`[TickStream] Subscription confirmed`);
          return;
        }
        if (parsed.error) {
          console.error(`[TickStream] Subscription error:`, parsed.error);
          return;
        }
        // Handle ping/pong JSON
        if (parsed.ping || parsed.pong) {
          return;
        }
      } catch {
        // Not JSON trade data
      }

      const ticks = this.parser(raw);
      if (!ticks || ticks.length === 0) return;

      ticks.forEach((tick) => {
        // Only emit if it's one of our watched symbols
        // We normalize to ASTERUSDT-PERP format
        const normalizedSymbol = tick.symbol.toUpperCase();
        if (this.pairSymbols.some(s => s.toUpperCase() === normalizedSymbol)) {
          this.emittedTickCount++;
          this.emitter.emit("tick", tick);
        } else {
          this.droppedTickCount++;
        }
      });

      const now = Date.now();
      if (now - this.lastFlowLog > 15_000) {
        this.lastFlowLog = now;
        console.log(
          `[TickStream] Flow stats: messages=${this.messageCount}, emittedTicks=${this.emittedTickCount}, droppedTicks=${this.droppedTickCount}`,
        );
      }
    });

    this.ws.on("error", (err) => {
      console.error(`[TickStream] WebSocket error:`, err);
      this.emitter.emit("error", err as Error);
    });

    this.ws.on("ping", () => {
      this.lastMessageTime = Date.now();
    });

    this.ws.on("pong", () => {
      this.lastMessageTime = Date.now();
    });

    this.ws.on("close", (code, reason) => {
      console.log(`[TickStream] WebSocket closed: code=${code}, reason=${reason.toString()}`);
      this.stopHeartbeat();
      this.scheduleReconnect();
      this.emitter.emit("close");
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
        const timeSinceLastMessage = Date.now() - this.lastMessageTime;
        if (timeSinceLastMessage > this.wsTimeoutMs) {
          console.warn(`[TickStream] No messages for ${timeSinceLastMessage}ms, reconnecting...`);
          this.reconnect();
        }
      }
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`[TickStream] Max reconnect attempts reached`);
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    console.log(`[TickStream] Scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.reconnect();
    }, delay);
  }

  private async reconnect(): Promise<void> {
    this.reconnectAttempts++;
    console.log(`[TickStream] Reconnecting... (attempt ${this.reconnectAttempts})`);
    await this.stop();
    await this.start();
  }

  async stop(): Promise<void> {
    this.stopHeartbeat();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    await new Promise<void>((resolve) => {
      if (!this.ws) return resolve();
      this.ws.once("close", () => resolve());
      this.ws.close();
      this.ws = null;
    });
  }

  on<K extends keyof TickEvents>(event: K, handler: TickEvents[K]): () => void {
    this.emitter.on(event, handler as (...args: unknown[]) => void);
    return () => this.emitter.off(event, handler as (...args: unknown[]) => void);
  }
}
