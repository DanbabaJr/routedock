---
"@routedock/routedock": minor
---

`routedockHono`, `routedock` (Express) and `routedockFastify` now validate `opts.manifest` against `routedock.schema.json` when they are constructed, and check it against the options they charge from. They throw `RouteDockManifestError`, naming the adapter and the field, if the served modes differ from `manifest.modes`, an x402 / mpp-charge price or a session rate or channel factory differs from the manifest (compared in base units, so `'0.001'` equals `'0.0010'`), `assetContract`, `asset` or `network` differ, or `payeeSecretKey` / `payee` do not match `manifest.payee`. Previously a drifted config served 402 challenges that the signed manifest contradicted. Existing providers whose options and manifest already agree are unaffected. `assertManifestValid` is still exported from `@routedock/routedock` and `@routedock/routedock/client`.
