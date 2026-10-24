---
'@routedock/routedock': patch
---

mpp-charge `pay()` now returns the settlement `txHash` from the `Payment-Receipt` header, and `null` when the header is missing or malformed.
