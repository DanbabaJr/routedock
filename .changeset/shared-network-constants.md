---
"@routedock/routedock": minor
---

Add a Workers-safe `@routedock/routedock/network` entry point that holds the canonical USDC issuer table, the testnet USDC SAC contract, the Horizon URL table and the shared provider helpers (`resolveNetwork`, `resolveAssetContract`, `findStellarConfigProblems`, `fetchXlmUsdcOrderBook`). provider-a, provider-b and the mcp server now import these instead of keeping their own copies, so a mainnet constant change lands in exactly one place (#578).
