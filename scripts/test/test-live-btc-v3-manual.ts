import dotenv from "dotenv";
import { resolve } from "path";
import { Wallet } from "ethers";

dotenv.config({ path: resolve(process.cwd(), ".env.local") });
dotenv.config({ path: resolve(process.cwd(), ".env") });

const BASE_URL = process.env.ASTER_RPC_URL || "https://fapi.asterdex.com";
const USER = process.env.ASTER_USER_ADDRESS || "";
const SIGNER = process.env.ASTER_SIGNER_ADDRESS || "";
const PRIVATE_KEY = process.env.ASTER_SIGNER_PRIVATE_KEY || process.env.ASTER_PRIVATE_KEY || "";

if (!USER || !SIGNER || !PRIVATE_KEY) {
  throw new Error("Missing ASTER_USER_ADDRESS / ASTER_SIGNER_ADDRESS / ASTER_SIGNER_PRIVATE_KEY");
}

const wallet = new Wallet(PRIVATE_KEY);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let lastMicros = 0n;
function nextNonceMicros(): string {
  const now = BigInt(Date.now()) * 1000n;
  if (now <= lastMicros) lastMicros += 1n;
  else lastMicros = now;
  return lastMicros.toString();
}

function buildQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join("&");
}

async function signQueryString(query: string): Promise<string> {
  const domain = {
    name: "AsterSignTransaction",
    version: "1",
    chainId: 1666,
    verifyingContract: "0x0000000000000000000000000000000000000000",
  } as const;
  const types = {
    Message: [{ name: "msg", type: "string" }],
  } as const;
  return wallet.signTypedData(domain, types, { msg: query });
}

async function signedRequest(method: "GET" | "POST" | "DELETE", path: string, business: Record<string, string>) {
  const params: Record<string, string> = {
    ...business,
    nonce: nextNonceMicros(),
    signer: SIGNER,
    user: USER,
  };
  const qs = buildQuery(params);
  const signature = await signQueryString(qs);
  const url = `${BASE_URL}${path}?${qs}&signature=${encodeURIComponent(signature)}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "aster-bot-manual-v3-test",
    },
  });
  const text = await res.text();
  let json: unknown = text;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${typeof json === "string" ? json : JSON.stringify(json)}`);
  }
  return json;
}

async function getBtcPrice(): Promise<number> {
  const res = await fetch(`${BASE_URL}/fapi/v3/ticker/price?symbol=BTCUSDT`);
  if (!res.ok) throw new Error(`Price fetch failed: ${res.status}`);
  const data = (await res.json()) as { price?: string };
  const p = Number(data.price || 0);
  if (!Number.isFinite(p) || p <= 0) throw new Error("Invalid BTC price");
  return p;
}

function floorToStep(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

async function getMarketQtyForOneDollar(price: number): Promise<string> {
  const res = await fetch(`${BASE_URL}/fapi/v3/exchangeInfo`);
  if (!res.ok) throw new Error(`exchangeInfo failed: ${res.status}`);
  const info = (await res.json()) as {
    symbols?: Array<{ symbol: string; filters: Array<{ filterType: string; minQty?: string; stepSize?: string; notional?: string }> }>;
  };
  const sym = info.symbols?.find((s) => s.symbol === "BTCUSDT");
  if (!sym) throw new Error("BTCUSDT not found in exchangeInfo");

  const lot = sym.filters.find((f) => f.filterType === "LOT_SIZE");
  const minNotionalFilter = sym.filters.find((f) => f.filterType === "MIN_NOTIONAL");
  const step = Number(lot?.stepSize || "0.000001");
  const minQty = Number(lot?.minQty || "0.000001");
  const minNotional = Number(minNotionalFilter?.notional || "1");

  const targetNotional = Math.max(1, minNotional);
  const rawQty = targetNotional / price;
  const qty = Math.max(minQty, floorToStep(rawQty, step));
  return qty.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

async function closeAllBtcPosition() {
  const pos = (await signedRequest("GET", "/fapi/v3/positionRisk", { symbol: "BTCUSDT" })) as Array<{ positionAmt?: string }>;
  const p = pos?.[0];
  const amt = Number(p?.positionAmt || "0");
  if (!Number.isFinite(amt) || amt === 0) {
    console.log("[MANUAL-V3] No BTC position to close.");
    return;
  }
  const side = amt > 0 ? "SELL" : "BUY";
  const qty = Math.abs(amt).toString();
  const resp = await signedRequest("POST", "/fapi/v3/order", {
    symbol: "BTCUSDT",
    side,
    type: "MARKET",
    quantity: qty,
    reduceOnly: "true",
  });
  console.log("[MANUAL-V3] Close response:", resp);
}

async function main() {
  const price = await getBtcPrice();
  const qty = await getMarketQtyForOneDollar(price);
  console.log("[MANUAL-V3] BTC price:", price);
  console.log("[MANUAL-V3] Qty:", qty);

  const buy = await signedRequest("POST", "/fapi/v3/order", {
    symbol: "BTCUSDT",
    side: "BUY",
    type: "MARKET",
    quantity: qty,
  });
  console.log("[MANUAL-V3] Buy response:", buy);

  console.log("[MANUAL-V3] Waiting 30s...");
  await sleep(30_000);

  await closeAllBtcPosition();
  console.log("[MANUAL-V3] Done.");
}

main().catch((e) => {
  console.error("[MANUAL-V3] Failed:", e);
  process.exit(1);
});

