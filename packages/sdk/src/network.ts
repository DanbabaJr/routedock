/**
 * Canonical Stellar network constants and the small helpers shared by the
 * client, the provider middleware and the provider apps.
 *
 * Kept in its own entry point (`@routedock/routedock/network`) so Workers
 * bundles can import it without pulling in the whole client or provider
 * surface: plain constants plus one fetch-based helper, no Node APIs, no
 * crypto. Before this module existed each app kept its own copy of the USDC
 * issuer table, the testnet SAC and the Horizon URLs, and a mainnet change
 * had to be made in three places (issue #578).
 */

/** Canonical Circle USDC issuers keyed by Stellar network. */
export const USDC_ISSUERS = {
  testnet: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  mainnet: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
} as const

export type Network = keyof typeof USDC_ISSUERS

/** Well-known USDC stablecoin asset contract on testnet. */
export const TESTNET_USDC_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'

/** Horizon REST endpoints keyed by Stellar network. */
export const HORIZON_URLS = {
  testnet: 'https://horizon-testnet.stellar.org',
  mainnet: 'https://horizon.stellar.org',
} as const

/**
 * Normalize a STELLAR_NETWORK-style string to a {@link Network}.
 * Anything other than the exact string 'mainnet' falls back to testnet, the
 * safe default.
 */
export function resolveNetwork(raw: string | undefined): Network {
  return raw === 'mainnet' ? 'mainnet' : 'testnet'
}

/**
 * Resolve the USDC asset contract for `network`: an explicit
 * `USDC_ASSET_CONTRACT` always wins, testnet falls back to the well-known
 * testnet SAC, and mainnet without one configured is a hard failure rather
 * than a silently empty asset contract in the manifest.
 */
export function resolveAssetContract(
  env: { USDC_ASSET_CONTRACT?: string | undefined },
  network: Network,
): string {
  if (env.USDC_ASSET_CONTRACT) return env.USDC_ASSET_CONTRACT
  if (network === 'testnet') return TESTNET_USDC_CONTRACT
  throw new Error('USDC_ASSET_CONTRACT is required for mainnet')
}

/** The env fields the shared config check understands. */
export interface StellarConfigEnv {
  STELLAR_PAYEE_SECRET?: string | undefined
  STELLAR_PAYEE_ADDRESS?: string | undefined
  USDC_ASSET_CONTRACT?: string | undefined
}

/**
 * Return the names of environment variables that are unset or malformed.
 * Values are never included — only names, so this is safe to log or return
 * to a caller directly. Providers append their own extra requirements
 * (channel contract, commitment key) to this shared base list.
 */
export function findStellarConfigProblems(env: StellarConfigEnv, network: Network): string[] {
  const problems: string[] = []
  if (!env.STELLAR_PAYEE_SECRET || !env.STELLAR_PAYEE_SECRET.startsWith('S')) {
    problems.push('STELLAR_PAYEE_SECRET')
  }
  if (!env.STELLAR_PAYEE_ADDRESS) {
    problems.push('STELLAR_PAYEE_ADDRESS')
  }
  if (network === 'mainnet' && !env.USDC_ASSET_CONTRACT) {
    problems.push('USDC_ASSET_CONTRACT')
  }
  return problems
}

export interface OrderBookLevel {
  price: string
  amount: string
}

export interface XlmUsdcOrderBook {
  asks: OrderBookLevel[]
  bids: OrderBookLevel[]
}

/**
 * Fetch the XLM/USDC orderbook straight from Horizon's REST API.
 *
 * The provider Express build used `Horizon.Server(...).orderbook(...)`, which
 * pulls the whole `@stellar/stellar-sdk` (and axios) into the bundle for what
 * is a single GET. Calling the endpoint keeps Workers bundles small and drops
 * the dependency, while the issuer and Horizon URL come from the canonical
 * tables above.
 */
export async function fetchXlmUsdcOrderBook(
  network: Network,
  limit: number,
): Promise<XlmUsdcOrderBook> {
  const params = new URLSearchParams({
    selling_asset_type: 'native',
    buying_asset_type: 'credit_alphanum4',
    buying_asset_code: 'USDC',
    buying_asset_issuer: USDC_ISSUERS[network],
    limit: String(limit),
  })

  const response = await fetch(`${HORIZON_URLS[network]}/order_book?${params.toString()}`, {
    headers: { accept: 'application/json' },
  })

  if (!response.ok) {
    throw new Error(`Horizon responded ${response.status}`)
  }

  return (await response.json()) as XlmUsdcOrderBook
}
