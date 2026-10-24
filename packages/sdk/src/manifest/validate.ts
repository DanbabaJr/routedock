import { Validator, type Schema } from '@cfworker/json-schema'
import type { RouteDockManifest } from '../types.js'
import { RouteDockManifestError } from '../errors.js'
import { usdcToStroops } from '../internal/usdc.js'
import schema from '../schemas/routedock.schema.json' assert { type: 'json' }

/**
 * The one manifest schema validator in the SDK. It uses @cfworker/json-schema,
 * which does not compile validators with `new Function`, so it is safe on
 * Cloudflare Workers. Both the client (ModeRouter) and the provider adapters
 * (assertProviderConfig) validate through this module.
 */
const validator = new Validator(schema as unknown as Schema, '7')

/**
 * Validate `manifest` against routedock.schema.json.
 *
 * @param source Where the manifest came from (a URL), used in the message.
 * @throws RouteDockManifestError listing every schema violation.
 */
export function validateManifestSchema(manifest: unknown, source?: string): void {
  const result = validator.validate(manifest)
  if (!result.valid) {
    const msgs = result.errors.map((err) => err.error).join('; ')
    throw new RouteDockManifestError(`Invalid manifest${source ? ` at ${source}` : ''}: ${msgs}`)
  }
}

/**
 * Validate semantic constraints for manifest fields beyond JSON schema syntax.
 * Enforces:
 * - All keys in `latency_hints` must be a subset of declared `regions`.
 * - If `assets` is defined, it must be a non-empty array whose first entry
 *   (`assets[0]`) matches the root-level `asset` and `asset_contract`.
 * - Every mode in `modes` has a matching `pricing` entry, so `pay()` and
 *   `estimateCost()` never read a missing price.
 * - Every entry in `deprecated_modes` is also listed in `modes`.
 * - Every price (`amount`, `rate`, `min_deposit`) is a decimal the SDK can
 *   convert to base units (non-negative, at most 7 fractional digits).
 *
 * Every failure is a {@link RouteDockManifestError}.
 */
export function assertManifestValid(manifest: RouteDockManifest, baseUrl?: string): void {
  const context = baseUrl ? ` at ${baseUrl}` : ''
  if (manifest.latency_hints !== undefined) {
    if (!Array.isArray(manifest.regions) || manifest.regions.length === 0) {
      throw new RouteDockManifestError(
        `Invalid manifest${context}: latency_hints defined without declaring regions`,
      )
    }
    const regionSet = new Set(manifest.regions)
    for (const region of Object.keys(manifest.latency_hints)) {
      if (!regionSet.has(region)) {
        throw new RouteDockManifestError(
          `Invalid manifest${context}: latency_hints key '${region}' is not declared in regions (${manifest.regions.join(', ')})`,
        )
      }
    }
  }

  if (manifest.assets !== undefined) {
    if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
      throw new RouteDockManifestError(
        `Invalid manifest${context}: assets must be a non-empty array when defined`,
      )
    }
    for (let i = 0; i < manifest.assets.length; i++) {
      const a = manifest.assets[i]
      if (!a || typeof a.asset !== 'string' || typeof a.asset_contract !== 'string') {
        throw new RouteDockManifestError(
          `Invalid manifest${context}: assets[${i}] must define asset and asset_contract strings`,
        )
      }
    }
    const first = manifest.assets[0]!
    if (first.asset !== manifest.asset || first.asset_contract !== manifest.asset_contract) {
      throw new RouteDockManifestError(
        `Invalid manifest${context}: assets[0] (${first.asset}:${first.asset_contract}) must match root asset fields (${manifest.asset}:${manifest.asset_contract})`,
      )
    }
  }

  assertPricingMatchesModes(manifest, context)
  assertDeprecatedModesListed(manifest, context)
  assertPricesParse(manifest, context)
}

function assertPricingMatchesModes(manifest: RouteDockManifest, context: string): void {
  const pricing = (manifest.pricing ?? {}) as Record<string, unknown>
  for (const mode of manifest.modes ?? []) {
    if (pricing[mode] === undefined || pricing[mode] === null) {
      throw new RouteDockManifestError(
        `Invalid manifest${context}: mode '${mode}' is listed in modes but pricing.${mode} is missing`,
      )
    }
  }
}

function assertDeprecatedModesListed(manifest: RouteDockManifest, context: string): void {
  if (manifest.deprecated_modes === undefined) return
  const modes = new Set<string>(manifest.modes ?? [])
  for (const mode of manifest.deprecated_modes) {
    if (!modes.has(mode)) {
      throw new RouteDockManifestError(
        `Invalid manifest${context}: deprecated_modes entry '${mode}' is not listed in modes`,
      )
    }
  }
}

const PRICE_FIELDS: Record<string, readonly string[]> = {
  x402: ['amount'],
  'mpp-charge': ['amount'],
  'mpp-session': ['rate', 'min_deposit'],
  'mpp-session-ws': ['rate', 'min_deposit'],
}

function assertPricesParse(manifest: RouteDockManifest, context: string): void {
  const pricing = (manifest.pricing ?? {}) as Record<string, Record<string, unknown> | undefined>
  for (const [mode, fields] of Object.entries(PRICE_FIELDS)) {
    const entry = pricing[mode]
    if (entry === undefined || entry === null) continue
    for (const field of fields) {
      const value = entry[field]
      try {
        if (typeof value !== 'string') {
          throw new RangeError(`expected a decimal string, got ${typeof value}`)
        }
        usdcToStroops(value)
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        throw new RouteDockManifestError(
          `Invalid manifest${context}: pricing.${mode}.${field} ${JSON.stringify(value)} is not a valid amount (${detail})`,
          { cause: err },
        )
      }
    }
  }
}
