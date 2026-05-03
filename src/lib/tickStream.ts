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
  const params = pairs.flatMap(pair => {
    // Convert ASTERUSDT-PERP to ASTERUSDT (remove -PERP suffix, uppercase)
    const streamName = pair.toUpperCase().replace(/-PERP$/, "");
    const normalized = streamName.toLowerCase();
    return [`${normalized}@aggTrade`, `${normalized}@bookTicker`];
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
      const data = payload.data;
      const stream = String(payload.stream);
      const rawSymbol = (data.s || stream.split("@")[0] || "").toUpperCase();
      const symbol = rawSymbol.endsWith("-PERP") ? rawSymbol : `${rawSymbol}-PERP`;

      if (stream.includes("@bookTicker")) {
        const bid = coerceNumber(data.b);
        const ask = coerceNumber(data.a);
        const timestamp = coerceNumber(data.T) ?? coerceNumber(data.E) ?? Date.now();
        if (bid === null || ask === null || bid <= 0 || ask <= 0) return null;
        return [{ symbol, price: (bid + ask) / 2, bid, ask, size: 0, timestamp, quoteOnly: true }];
      }

      const price = coerceNumber(data.p);
      const size = coerceNumber(data.q);
      const timestamp = coerceNumber(data.T) ?? Date.now();

      if (price === null) return null;

      // m is the maker flag. If m is true, the buyer is the maker, so the trade is a SELL.
      const side: "buy" | "sell" = data.m ? "sell" : "buy";

      return [{ symbol, price, size: size ?? 0, timestamp, side }];
    }

    // Direct trade object (single stream format)
    if (payload.p || payload.price) {
      const symbol = (payload.s || "").toUpperCase();
      const price = coerceNumber(payload.p) ?? coerceNumber(payload.price);
      const size = coerceNumber(payload.q) ?? coerceNumber(payload.quantity);
      const timestamp = coerceNumber(payload.T) ?? coerceNumber(payload.timestamp) ?? Date.now();

      if (price === null) return null;
      const side: "buy" | "sell" = payload.m ? "sell" : "buy";

      const finalSymbol = symbol ? (symbol.endsWith("-PERP") ? symbol : `${symbol}-PERP`) : "UNKNOWN";

      return [{ symbol: finalSymbol, price, size: size ?? 0, timestamp, side }];
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
  private intentionalClose = false;
  private reconnecting = false;
  private messageCount = 0;
  private emittedTickCount = 0;
  private droppedTickCount = 0;
  private lastFlowLog = 0;
  private latestQuotes = new Map<string, { bid: number; ask: number }>();

  constructor(
    private readonly url: string,
    private readonly pairSymbols: string[],
    private readonly parser: MessageParser = defaultParser,
    private readonly subscribePayloadBuilder: (pairs: string[]) => unknown = defaultSubscribePayload,
  ) { }

  async start(): Promise<void> {
    await this.stop();
    this.intentionalClose = false;

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
          if (tick.bid && tick.ask) this.latestQuotes.set(normalizedSymbol, { bid: tick.bid, ask: tick.ask });
          const quote = this.latestQuotes.get(normalizedSymbol);
          const enrichedTick = quote && (!tick.bid || !tick.ask)
            ? { ...tick, bid: quote.bid, ask: quote.ask }
            : tick;
          this.emittedTickCount++;
          this.emitter.emit("tick", enrichedTick);
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
      if (this.ws?.readyState === WebSocket.CLOSED || this.ws?.readyState === WebSocket.CLOSING) this.ws = null;
      if (!this.intentionalClose) this.scheduleReconnect();
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

    if (this.heartbeatInterval.unref) {
      this.heartbeatInterval.unref();
    }
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

    if (this.reconnectTimeout.unref) {
      this.reconnectTimeout.unref();
    }
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.reconnectAttempts++;
    try {
      console.log(`[TickStream] Reconnecting... (attempt ${this.reconnectAttempts})`);
      await this.stop();
      await this.start();
    } finally {
      this.reconnecting = false;
    }
  }

  async stop(): Promise<void> {
    this.intentionalClose = true;
    this.stopHeartbeat();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    await new Promise<void>((resolve) => {
      if (!this.ws) return resolve();
      const ws = this.ws;
      ws.once("close", () => resolve());
      this.ws.close();
      this.ws = null;
    });
  }

  on<K extends keyof TickEvents>(event: K, handler: TickEvents[K]): () => void {
    this.emitter.on(event, handler as (...args: unknown[]) => void);
    return () => this.emitter.off(event, handler as (...args: unknown[]) => void);
  }
}
