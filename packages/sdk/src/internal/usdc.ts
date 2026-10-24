/**
 * USDC conversion — canonical implementation lives in @routedock/nulth-sdk and is
 * re-exported here so SDK consumers (client, provider) share one converter.
 *
 * @routedock/routedock already depends on @routedock/nulth-sdk, so re-exporting
 * (rather than defining a parallel helper) keeps a single source of truth.
 */
import { usdcToStroops, stroopsToUsdc, USDC_DECIMALS } from '@routedock/nulth-sdk'
export { usdcToStroops, stroopsToUsdc, USDC_DECIMALS }

// Canonical Circle USDC issuers — defined once in ../network.ts (the
// `@routedock/routedock/network` entry point) and re-exported here so client
// internals keep their existing import path.
export { USDC_ISSUERS } from '../network.js'

/**
 * @deprecated Use {@link usdcToStroops} — the same validated bigint converter.
 * Kept as a thin alias so existing call sites keep working during migration.
 */
export const usdcToUnits = usdcToStroops
