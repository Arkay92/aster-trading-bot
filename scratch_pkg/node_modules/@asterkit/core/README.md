# @asterkit/core

TypeScript SDK for Aster agent and builder management APIs.

## Install

From the monorepo root:

```bash
bun install
```

From another project:

```bash
bun add @asterkit/core viem
```

## What This Package Exposes

`@asterkit/core` exports:

- Agent APIs: `approveAgent`, `getAgents`, `updateAgent`, `deleteAgent`
- Builder APIs: `approveBuilder`, `getBuilders`, `updateBuilder`, `deleteBuilder`
- Utilities/config/constants used by the APIs

## Defaults

- Host: `https://fapi.asterdex.com`
- Aster chain: `Mainnet`
- Signature chain id: `56`
- Default agent name (if omitted): `AsterKit`

## Quick Start

```ts
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { approveAgent, getAgents } from "@asterkit/core";

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);

const walletClient = createWalletClient({
  account,
  chain: bsc,
  transport: http(),
});

const approved = await approveAgent({
  walletClient,
  agentAddress: "0x1111111111111111111111111111111111111111",
  canSpotTrade: true,
  canPerpTrade: true,
  canWithdraw: false,
});

const agents = await getAgents({
  walletClient,
  user: account.address,
  signer: account.address,
});

console.log(approved.status, agents.data);
```

## Agent API

### `approveAgent(options)`

Registers an agent with permissions.

Required:

- `walletClient`
- `agentAddress`

Optional:

- `agentName`, `ipWhitelist`, `expired`
- `canSpotTrade`, `canPerpTrade`, `canWithdraw`
- `host`, `signatureChainId`, `asterChain`, `nonce`

### `getAgents(options)`

Fetches agents for a user/signer pair.

Required:

- `user`
- `signer`
- and either `signature` or `walletClient` (to sign query string)

Optional:

- `host`, `asterChain`, `nonce`

### `updateAgent(options)`

Updates permissions on an existing agent.

Required:

- `walletClient`
- `agentAddress`
- `canSpotTrade`
- `canPerpTrade`
- `canWithdraw`

Optional:

- `ipWhitelist`, `host`, `signatureChainId`, `asterChain`, `nonce`

### `deleteAgent(options)`

Deletes an existing agent.

Required:

- `walletClient`
- `agentAddress`

Optional:

- `host`, `signatureChainId`, `asterChain`, `nonce`

## Builder API

### `approveBuilder(options)`

Registers a builder.

Required:

- `walletClient`
- `builder`
- `maxFeeRate`
- `builderName`

Optional:

- `host`, `signatureChainId`, `asterChain`, `nonce`

### `getBuilders(options)`

Fetches builders for a user/signer pair.

Required:

- `user`
- `signer`
- and either `signature` or `walletClient` (to sign query string)

Optional:

- `host`, `asterChain`, `nonce`

### `updateBuilder(options)`

Updates a builder.

Required:

- `walletClient`
- `builder`
- `maxFeeRate`

Optional:

- `host`, `signatureChainId`, `asterChain`, `nonce`

### `deleteBuilder(options)`

Deletes a builder.

Required:

- `walletClient`
- `builder`

Optional:

- `host`, `signatureChainId`, `asterChain`, `nonce`

## Error Handling

API calls throw `AsterRequestError` when the HTTP status is not successful.

```ts
import { AsterRequestError, approveBuilder } from "@asterkit/core";

try {
  await approveBuilder({
    walletClient,
    builder: "0x2222222222222222222222222222222222222222",
    maxFeeRate: "10",
    builderName: "my-builder",
  });
} catch (error) {
  if (error instanceof AsterRequestError) {
    console.error(error.status, error.url, error.data);
  }
}
```

## Development

From repo root:

```bash
bun install
bun test packages/core/src/*.test.ts
bun test packages/core/src/*.integration.test.ts
bun run --cwd packages/core build
```
