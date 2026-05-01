# Aster Core Agent/Builder Skill

Use this skill when you need to manage Aster agents/builders from code with `@asterkit/core`.

## When To Use

- Approve, update, or delete an agent
- Approve, update, or delete a builder
- Query existing agents/builders for a user
- Generate reproducible scripts/tests around these flows

## Inputs You Need

- `walletClient` configured with `account`
- User wallet address (usually `walletClient.account.address`)
- Target address:
  - agent flow: `agentAddress`
  - builder flow: `builder`
- Optional overrides: `host`, `asterChain`, `signatureChainId`, `nonce`

## Workflow

1. Confirm which entity is being managed: `agent` or `builder`.
2. Confirm action: `approve`, `get`, `update`, or `delete`.
3. Build call using exported helpers from `@asterkit/core`.
4. For `get*` calls:
   - Provide `user` and `signer`.
   - Provide either:
     - `signature`, or
     - `walletClient` (auto-sign query string).
5. Execute and return:
   - `status`
   - parsed `data`
   - `url`
   - signed `params`
6. Handle failures by catching `AsterRequestError` and surfacing `status/url/data`.

## API Map

- Agent:
  - `approveAgent`
  - `getAgents`
  - `updateAgent`
  - `deleteAgent`
- Builder:
  - `approveBuilder`
  - `getBuilders`
  - `updateBuilder`
  - `deleteBuilder`

## Defaults

- `host`: `https://fapi.asterdex.com`
- `asterChain`: `Mainnet`
- `signatureChainId`: `56`
- `agentName` default: `AsterKit`

## Minimal Usage Pattern

```ts
import {
  approveAgent,
  getAgents,
  updateBuilder,
  AsterRequestError,
} from "@asterkit/core";

try {
  const created = await approveAgent({
    walletClient,
    agentAddress: "0x1111111111111111111111111111111111111111",
  });

  const listed = await getAgents({
    walletClient,
    user: walletClient.account!.address,
    signer: walletClient.account!.address,
  });

  const updated = await updateBuilder({
    walletClient,
    builder: "0x2222222222222222222222222222222222222222",
    maxFeeRate: "10",
  });

  console.log(created.status, listed.status, updated.status);
} catch (error) {
  if (error instanceof AsterRequestError) {
    console.error(error.status, error.url, error.data);
  }
  throw error;
}
```

## Guardrails

- Require `walletClient.account`; calls should fail fast if missing.
- Ensure `signer` equals `walletClient.account.address` when auto-signing `get*`.
- Keep `maxFeeRate` as a string.
- Do not swallow `AsterRequestError`; propagate meaningful metadata upstream.
