import type { PaymentMode, RouteDockManifest } from '../../../types.js'
import type { ProviderConfigLike } from '../../internal/assertProviderConfig.js'

export const TEST_ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
export const TEST_CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

interface ManifestFixtureInput {
  payee: string
  modes: PaymentMode[]
  pricing: ProviderConfigLike['pricing']
  network?: 'testnet' | 'mainnet'
  asset?: string
  assetContract?: string
  name?: string
  /** Extra manifest fields (per-mode payee overrides, assets[], and so on). */
  extra?: Partial<RouteDockManifest>
}

/**
 * Build a manifest that agrees with the adapter options under test: it lists
 * exactly the modes that are both configured and priced, with the same prices.
 * Provider adapters now refuse to start when the two disagree, so tests that
 * configure a subset of modes need a manifest for that subset.
 */
export function manifestForOptions(input: ManifestFixtureInput): RouteDockManifest {
  const modes = input.modes.filter((mode) => Boolean(input.pricing[mode]))
  const pricing: RouteDockManifest['pricing'] = {}
  if (modes.includes('x402') && input.pricing.x402) {
    pricing.x402 = { amount: input.pricing.x402, per: 'request' }
  }
  if (modes.includes('mpp-charge') && input.pricing['mpp-charge']) {
    pricing['mpp-charge'] = { amount: input.pricing['mpp-charge'], per: 'request' }
  }
  for (const mode of ['mpp-session', 'mpp-session-ws'] as const) {
    const session = input.pricing[mode]
    if (modes.includes(mode) && session) {
      pricing[mode] = {
        rate: session.rate,
        per: 'voucher',
        channel_factory: session.channelFactory,
        min_deposit: '0.10',
        refund_waiting_period_ledgers: 17280,
      }
    }
  }
  return {
    routedock: '1.0',
    name: input.name ?? 'Test Service',
    description: 'Unit test provider',
    modes,
    network: input.network ?? 'testnet',
    asset: input.asset ?? 'USDC',
    asset_contract: input.assetContract ?? TEST_ASSET_CONTRACT,
    payee: input.payee,
    pricing,
    endpoints: { price: { method: 'GET', path: '/price' } },
    tags: ['test'],
    ...input.extra,
  }
}
