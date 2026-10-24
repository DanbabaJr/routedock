import {
  findStellarConfigProblems,
  resolveAssetContract as resolveSharedAssetContract,
  resolveNetwork,
  type Network,
} from '@routedock/routedock/network'
import type { Env } from './env.js'

/**
 * Resolve the USDC asset contract for `network`. Delegates to the SDK's
 * canonical helper (shared with provider-a, issue #578): an explicit
 * `USDC_ASSET_CONTRACT` always wins, testnet falls back to the well-known
 * testnet SAC, and mainnet without one configured is a hard failure rather
 * than a silently empty asset contract.
 */
export function resolveAssetContract(env: Env, network: Network): string {
  return resolveSharedAssetContract(env, network)
}

/**
 * Return the names of environment variables that are unset or malformed.
 * Values are never included — only names, so this is safe to log or return
 * to a caller directly. The shared checks (payee secret format, payee
 * address, mainnet asset contract) live in the SDK; provider-b additionally
 * requires its commitment public key and channel contract id.
 */
export function findConfigProblems(env: Env): string[] {
  const network = resolveNetwork(env.STELLAR_NETWORK)
  const problems = findStellarConfigProblems(env, network)
  if (!env.COMMITMENT_PUBLIC_KEY) {
    problems.push('COMMITMENT_PUBLIC_KEY')
  }
  if (!env.CHANNEL_CONTRACT_ID) {
    problems.push('CHANNEL_CONTRACT_ID')
  }
  return problems
}
