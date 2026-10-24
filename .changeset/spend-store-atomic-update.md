---
'@routedock/routedock': minor
---

Make the daily spend cap safe when several processes share one `FileSpendStore` file (the MCP server and the example agent do by default). `SpendStore` gains an optional atomic `update(fn)`; `FileSpendStore` implements it with an exclusive lock file (stale-lock recovery, fails closed on timeout), writes through a unique tmp file per write so concurrent writers no longer clobber each other or hit `ENOENT` on rename, and `RouteDockClient` uses `update` for reserve and rollback whenever the store provides it. Stores shared across processes must implement `update`.
