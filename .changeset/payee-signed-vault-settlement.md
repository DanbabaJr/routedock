---
"@routedock/routedock": patch
---

Stop reading the vault admin secret env var. The `record_session_settlement` call on the
agent vault is now authorized by the allowlisted payee's own key, which is also the
transaction source, so providers no longer need — and must no longer be given — the
vault admin secret. `payee.require_auth()` on the contract enforces this; the admin
key keeps guarding `upgrade`, `set_agent_pubkey` and the cap/allowlist setters.

The `AGENT_VAULT_CONTRACT` env var is still the only variable that enables the vault
record. Transaction construction moved into a testable
`buildSessionSettlementTransaction` helper in `provider/internal/vaultSettlement.ts`.

Already-deployed vaults keep the admin-gated function until their admin uploads the
new wasm and calls `upgrade`; against those vaults this call fails and is logged,
leaving the channel close response unaffected.
