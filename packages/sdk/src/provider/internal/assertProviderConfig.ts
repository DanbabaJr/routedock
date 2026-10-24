import { Keypair } from '@stellar/stellar-sdk'
import { RouteDockManifestError } from '../../errors.js'
import { usdcToStroops } from '../../internal/usdc.js'
import { assertManifestValid, validateManifestSchema } from '../../manifest/validate.js'
import type { PaymentMode, RouteDockManifest } from '../../types.js'

/** The options every provider adapter (Hono, Express, Fastify) takes twice: once directly and once inside `manifest`. */
export interface ProviderConfigLike {
  modes: PaymentMode[]
  pricing: {
    x402?: string
    'mpp-charge'?: string
    'mpp-session'?: { rate: string; channelFactory: string }
    'mpp-session-ws'?: { rate: string; channelFactory: string }
  }
  asset?: string
  assetContract?: string
  payee: string
  network: 'testnet' | 'mainnet'
  payeeSecretKey: string
  manifest: RouteDockManifest
}

type FlatMode = 'x402' | 'mpp-charge'
type SessionMode = 'mpp-session' | 'mpp-session-ws'

const FLAT_MODES: readonly FlatMode[] = ['x402', 'mpp-charge']
const SESSION_MODES: readonly SessionMode[] = ['mpp-session', 'mpp-session-ws']

/** Compare two USDC amounts in base units so '0.001' and '0.0010' are equal. */
function sameAmount(adapter: string, label: string, optionValue: string, manifestValue: string): boolean {
  const parse = (where: string, value: string): bigint => {
    try {
      return usdcToStroops(value)
    } catch {
      throw new RouteDockManifestError(
        `${adapter}: ${label} has an unparseable ${where} amount "${value}"`,
      )
    }
  }
  return parse('option', optionValue) === parse('manifest', manifestValue)
}

/**
 * Fail at construction if a provider adapter's options disagree with the
 * manifest it signs and serves.
 *
 * Challenges (402 responses) are built from the options while clients only
 * see the signed manifest, so any drift lets a provider advertise one price,
 * asset or mode set and charge another. Checks:
 *
 *  1. `manifest` is valid against routedock.schema.json plus the semantic rules.
 *  2. The modes the adapter will serve (listed in `modes` and priced in
 *     `pricing`) are exactly `manifest.modes`.
 *  3. Per-mode prices match in base units (x402 / mpp-charge `amount`,
 *     session `rate` and `channel_factory`).
 *  4. `assetContract`, `asset` (when given) and `network` match the manifest.
 *  5. `payeeSecretKey` belongs to `manifest.payee`, and `payee` equals it.
 *
 * @throws RouteDockManifestError naming the adapter and the mismatched field.
 */
export function assertProviderConfig(opts: ProviderConfigLike, adapterName: string): void {
  const { manifest } = opts
  if (manifest === null || typeof manifest !== 'object') {
    throw new RouteDockManifestError(`${adapterName}: opts.manifest is required and must be an object`)
  }

  // 1. schema + semantics (the same checks every client runs on fetch)
  try {
    validateManifestSchema(manifest)
    assertManifestValid(manifest)
  } catch (err) {
    if (err instanceof RouteDockManifestError) {
      throw new RouteDockManifestError(`${adapterName}: ${err.message}`, { cause: err })
    }
    throw err
  }

  // 2. modes the adapter will serve vs modes the manifest advertises
  const served = new Set<PaymentMode>(opts.modes.filter((mode) => Boolean(opts.pricing[mode])))
  const advertised = new Set<PaymentMode>(manifest.modes)
  const notAdvertised = [...served].filter((mode) => !advertised.has(mode))
  const notServed = [...advertised].filter((mode) => !served.has(mode))
  if (notAdvertised.length > 0 || notServed.length > 0) {
    const parts: string[] = []
    if (notAdvertised.length > 0) parts.push(`served but not in manifest.modes: ${notAdvertised.join(', ')}`)
    if (notServed.length > 0) parts.push(`in manifest.modes but not served (missing from modes or pricing): ${notServed.join(', ')}`)
    throw new RouteDockManifestError(`${adapterName}: modes do not match manifest.modes (${parts.join('; ')})`)
  }

  // 3. prices
  for (const mode of FLAT_MODES) {
    if (!served.has(mode)) continue
    const optionValue = opts.pricing[mode]!
    const manifestValue = manifest.pricing[mode]?.amount
    if (manifestValue === undefined) {
      throw new RouteDockManifestError(`${adapterName}: manifest.pricing.${mode}.amount is missing but ${mode} is served`)
    }
    if (!sameAmount(adapterName, `pricing.${mode}`, optionValue, manifestValue)) {
      throw new RouteDockManifestError(
        `${adapterName}: pricing.${mode} "${optionValue}" does not match manifest.pricing.${mode}.amount "${manifestValue}"`,
      )
    }
  }
  for (const mode of SESSION_MODES) {
    if (!served.has(mode)) continue
    const optionValue = opts.pricing[mode]!
    const manifestValue = manifest.pricing[mode]
    if (!manifestValue) {
      throw new RouteDockManifestError(`${adapterName}: manifest.pricing.${mode} is missing but ${mode} is served`)
    }
    if (!sameAmount(adapterName, `pricing.${mode}.rate`, optionValue.rate, manifestValue.rate)) {
      throw new RouteDockManifestError(
        `${adapterName}: pricing.${mode}.rate "${optionValue.rate}" does not match manifest.pricing.${mode}.rate "${manifestValue.rate}"`,
      )
    }
    if (optionValue.channelFactory !== manifestValue.channel_factory) {
      throw new RouteDockManifestError(
        `${adapterName}: pricing.${mode}.channelFactory "${optionValue.channelFactory}" does not match manifest.pricing.${mode}.channel_factory "${manifestValue.channel_factory}"`,
      )
    }
  }

  // 4. asset and network
  if (opts.assetContract !== undefined && opts.assetContract !== manifest.asset_contract) {
    throw new RouteDockManifestError(
      `${adapterName}: assetContract "${opts.assetContract}" does not match manifest.asset_contract "${manifest.asset_contract}"`,
    )
  }
  if (opts.asset !== undefined && opts.asset !== manifest.asset) {
    throw new RouteDockManifestError(
      `${adapterName}: asset "${opts.asset}" does not match manifest.asset "${manifest.asset}"`,
    )
  }
  if (opts.network !== manifest.network) {
    throw new RouteDockManifestError(
      `${adapterName}: network "${opts.network}" does not match manifest.network "${manifest.network}"`,
    )
  }

  // 5. payee
  let signerPublicKey: string
  try {
    signerPublicKey = Keypair.fromSecret(opts.payeeSecretKey).publicKey()
  } catch (err) {
    throw new RouteDockManifestError(`${adapterName}: payeeSecretKey is not a valid Stellar secret key`, { cause: err })
  }
  if (signerPublicKey !== manifest.payee) {
    throw new RouteDockManifestError(
      `${adapterName}: payeeSecretKey belongs to ${signerPublicKey}, not manifest.payee ${manifest.payee}; clients would reject the signed manifest`,
    )
  }
  if (opts.payee !== manifest.payee) {
    throw new RouteDockManifestError(
      `${adapterName}: payee "${opts.payee}" does not match manifest.payee "${manifest.payee}"`,
    )
  }
}
