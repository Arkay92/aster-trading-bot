import dotenv from "dotenv";
import { resolve } from "path";
import { Wallet } from "ethers";

dotenv.config({ path: resolve(process.cwd(), ".env.local") });
dotenv.config({ path: resolve(process.cwd(), ".env") });

type JsonObj = Record<string, unknown>;

const BASE = "https://www.asterdex.com";
const SOURCE_ADDR = (process.env.ASTER_SOURCE_ADDR || "").trim();
const PRIVATE_KEY = (process.env.ASTER_PRIVATE_KEY || process.env.ASTER_SIGNER_PRIVATE_KEY || "").trim();
const CHAIN_ID = Number(process.env.ASTER_CHAIN_ID || "56");
const NETWORK = (process.env.ASTER_NETWORK || "56").trim();
const SOURCE_CODE = (process.env.ASTER_SOURCE_CODE || "broker").trim();
const AGENT_CODE = (process.env.ASTER_AGENT_CODE || "").trim();
const DESC = `bot-${Date.now()}`;
const IP = (process.env.ASTER_API_IP_WHITELIST || "").trim();

if (!SOURCE_ADDR) {
  throw new Error("Missing ASTER_SOURCE_ADDR in .env");
}
if (!PRIVATE_KEY) {
  throw new Error("Missing ASTER_PRIVATE_KEY (or ASTER_SIGNER_PRIVATE_KEY) in .env");
}

const wallet = new Wallet(PRIVATE_KEY);
if (wallet.address.toLowerCase() !== SOURCE_ADDR.toLowerCase()) {
  throw new Error(
    `ASTER_SOURCE_ADDR does not match provided private key address. source=${SOURCE_ADDR} pkAddr=${wallet.address}`,
  );
}

async function postJson(path: string, body: JsonObj, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: JsonObj = {};
  try {
    json = JSON.parse(text) as JsonObj;
  } catch {
    throw new Error(`Non-JSON response (${res.status}): ${text}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  return { json, res };
}

function readNonce(payload: JsonObj): string {
  const data = payload.data as JsonObj | undefined;
  const nonce = data?.nonce;
  if (!nonce || typeof nonce !== "string") {
    throw new Error(`Nonce not found in response: ${JSON.stringify(payload)}`);
  }
  return nonce;
}

function readToken(payload: JsonObj): string {
  const data = payload.data as JsonObj | undefined;
  const token = data?.token;
  if (!token || typeof token !== "string") {
    throw new Error(`Login token not found in response: ${JSON.stringify(payload)}`);
  }
  return token;
}

async function main() {
  console.log("[REGISTER] 1) Fetch nonce...");
  const nonceResp = await postJson("/bapi/futures/v1/public/future/web3/get-nonce", {
    sourceAddr: SOURCE_ADDR,
    type: "CREATE_API_KEY",
  });
  console.log("[REGISTER] get-nonce:", JSON.stringify(nonceResp.json));
  const nonce = readNonce(nonceResp.json);

  const loginMessages = [
    `You are signing into Astherus ${nonce}`,
    `You are signing into Aster ${nonce}`,
    `You are signing into Astherus:${nonce}`,
    `You are signing into Astherus ${nonce}\n`,
  ];

  console.log("[REGISTER] 3) Login...");
  const loginCandidates: Array<{ body: JsonObj; headers: Record<string, string>; tag: string }> = [];
  for (const msg of loginMessages) {
    const signature = await wallet.signMessage(msg);
    for (const clientType of ["broker", "ae"]) {
      const baseBody: JsonObj = {
        signature,
        sourceAddr: SOURCE_ADDR,
        chainId: CHAIN_ID,
      };
      if (AGENT_CODE) baseBody.agentCode = AGENT_CODE;
      loginCandidates.push({ body: baseBody, headers: { clientType }, tag: `${clientType}/normal msg="${msg}"` });

      const withNonce: JsonObj = { ...baseBody, nonce };
      loginCandidates.push({ body: withNonce, headers: { clientType }, tag: `${clientType}/with-nonce msg="${msg}"` });

      const lowerAddrBody: JsonObj = { ...baseBody, sourceAddr: SOURCE_ADDR.toLowerCase() };
      loginCandidates.push({ body: lowerAddrBody, headers: { clientType }, tag: `${clientType}/lower-addr msg="${msg}"` });
    }
  }

  let token = "";
  let cookie = "";
  let loginSignature = "";
  let loginSuccess: JsonObj | null = null;
  for (const c of loginCandidates) {
    const r = await postJson("/bapi/futures/v1/public/future/web3/ae/login", c.body, c.headers);
    console.log(`[REGISTER] login(${c.tag}):`, JSON.stringify(r.json));
    try {
      token = readToken(r.json);
      cookie = r.res.headers.get("set-cookie") || "";
      loginSignature = String(c.body.signature || "");
      loginSuccess = r.json;
      break;
    } catch {
      // try next candidate
    }
  }
  if (!token || !loginSuccess) {
    throw new Error("Login failed for all variants; could not obtain token.");
  }

  console.log("[REGISTER] 4) Create API key...");
  const createBody: JsonObj = {
    desc: DESC,
    ip: IP,
    network: NETWORK,
    signature: loginSignature,
    sourceAddr: SOURCE_ADDR,
    type: "CREATE_API_KEY",
    sourceCode: SOURCE_CODE,
  };
  const createResp = await postJson(
    "/bapi/futures/v1/public/future/web3/broker-create-api-key",
    createBody,
    {
      clientType: SOURCE_CODE === "ae" ? "ae" : "broker",
      accept: "*/*",
      authorization: `Bearer ${token}`,
      token,
      cookie,
    },
  );
  console.log("[REGISTER] create:", JSON.stringify(createResp.json));

  const data = createResp.json.data as JsonObj | undefined;
  const apiKey = typeof data?.apiKey === "string" ? data.apiKey : "";
  const apiSecret = typeof data?.apiSecret === "string" ? data.apiSecret : "";
  if (!apiKey || !apiSecret) {
    throw new Error(`apiKey/apiSecret missing: ${JSON.stringify(createResp.json)}`);
  }

  console.log("\n[REGISTER] SUCCESS");
  console.log(`ASTER_API_KEY=${apiKey}`);
  console.log(`ASTER_API_SECRET=${apiSecret}`);
}

main().catch((err) => {
  console.error("[REGISTER] Failed:", err);
  process.exit(1);
});
