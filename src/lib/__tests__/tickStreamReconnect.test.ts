import WebSocket, { WebSocketServer } from "ws";
import { AsterTickStream } from "../tickStream";

describe("AsterTickStream reconnection", () => {
  it("reconnects after an unexpected exchange websocket close", async () => {
    const server = new WebSocketServer({ port: 0 });
    const sockets: WebSocket[] = [];
    let connections = 0;
    let stream: AsterTickStream | null = null;

    try {
      server.on("connection", (socket) => {
        sockets.push(socket);
        connections++;
        if (connections === 1) setTimeout(() => socket.close(), 10);
      });

      const address = server.address();
      if (typeof address === "string" || address === null) throw new Error("Expected TCP server address");

      stream = new AsterTickStream(`ws://127.0.0.1:${address.port}`, ["BTCUSDT-PERP"]);
      await stream.start();

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for reconnect")), 2_500);
        const interval = setInterval(() => {
          if (connections >= 2) {
            clearInterval(interval);
            clearTimeout(timeout);
            resolve();
          }
        }, 25);
      });

      expect(connections).toBeGreaterThanOrEqual(2);
    } finally {
      await stream?.stop();
      await Promise.all(sockets.map((socket) => new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) return resolve();
        if (socket.readyState === WebSocket.CONNECTING) {
          socket.terminate();
          return resolve();
        }
        socket.once("close", () => resolve());
        socket.close();
      })));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
