import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import { assertProviderConfig, type ProviderConfigLike } from '../internal/assertProviderConfig.js'
import { RouteDockManifestError } from '../../errors.js'
import type { RouteDockManifest } from '../../types.js'
import { manifestForOptions, TEST_ASSET_CONTRACT, TEST_CHANNEL_CONTRACT } from './helpers/manifestFixture.js'

const payee = Keypair.random()
const OTHER_ASSET_CONTRACT = 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA'
const OTHER_CHANNEL = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'

function baseOptions(overrides: Partial<ProviderConfigLike> = {}): ProviderConfigLike {
  const modes: ProviderConfigLike['modes'] = ['x402', 'mpp-charge', 'mpp-session', 'mpp-session-ws']
  const pricing: ProviderConfigLike['pricing'] = {
    x402: '0.001',
    'mpp-charge': '0.0008',
    'mpp-session': { rate: '0.0001', channelFactory: TEST_CHANNEL_CONTRACT },
    'mpp-session-ws': { rate: '0.0002', channelFactory: TEST_CHANNEL_CONTRACT },
  }
  return {
    modes,
    pricing,
    asset: 'USDC',
    assetContract: TEST_ASSET_CONTRACT,
    payee: payee.publicKey(),
    network: 'testnet',
    payeeSecretKey: payee.secret(),
    manifest: manifestForOptions({ payee: payee.publicKey(), modes, pricing }),
    ...overrides,
  }
}

function mutateManifest(fn: (m: RouteDockManifest) => void): RouteDockManifest {
  const manifest = structuredClone(baseOptions().manifest)
  fn(manifest)
  return manifest
}

function throwsManifestError(opts: ProviderConfigLike, pattern: RegExp, adapter = 'testAdapter') {
  assert.throws(
    () => assertProviderConfig(opts, adapter),
    (err: unknown) => {
      assert.ok(err instanceof RouteDockManifestError, `expected RouteDockManifestError, got ${String(err)}`)
      assert.match(err.message, new RegExp(`^${adapter}: `), 'message names the adapter')
      assert.match(err.message, pattern)
      return true
    },
  )
}

describe('assertProviderConfig — consistent configuration', () => {
  it('accepts options that agree with the manifest', () => {
    assert.doesNotThrow(() => assertProviderConfig(baseOptions(), 'testAdapter'))
  })

  it("accepts '0.001' in options against '0.0010' in the manifest (compared in base units)", () => {
    const opts = baseOptions()
    opts.manifest.pricing.x402 = { amount: '0.0010', per: 'request' }
    opts.manifest.pricing['mpp-charge'] = { amount: '0.00080', per: 'request' }
    assert.doesNotThrow(() => assertProviderConfig(opts, 'testAdapter'))
  })

  it('accepts a subset of modes when the manifest lists exactly that subset', () => {
    const modes: ProviderConfigLike['modes'] = ['x402']
    const pricing = { x402: '0.5' }
    const opts = baseOptions({
      modes,
      pricing,
      manifest: manifestForOptions({ payee: payee.publicKey(), modes, pricing }),
    })
    assert.doesNotThrow(() => assertProviderConfig(opts, 'testAdapter'))
  })

  it('does not require the optional asset and assetContract options', () => {
    const { asset: _a, assetContract: _c, ...rest } = baseOptions()
    assert.doesNotThrow(() => assertProviderConfig(rest as ProviderConfigLike, 'testAdapter'))
  })
})

describe('assertProviderConfig — manifest validity', () => {
  it('rejects a manifest that fails the JSON schema (routedock: "banana")', () => {
    const manifest = mutateManifest((m) => { (m as { routedock: string }).routedock = 'banana' })
    throwsManifestError(baseOptions({ manifest }), /Invalid manifest: .*routedock/i)
  })

  it('rejects a manifest that breaks a semantic rule (assets[0] must match the root asset)', () => {
    const manifest = mutateManifest((m) => {
      m.assets = [{ asset: 'USDC', asset_contract: OTHER_ASSET_CONTRACT }]
    })
    throwsManifestError(baseOptions({ manifest }), /assets\[0\]/)
  })

  for (const [label, value] of [['undefined', undefined], ['null', null], ['a string', 'nope']] as const) {
    it(`rejects ${label} as the manifest with a clear message`, () => {
      throwsManifestError(baseOptions({ manifest: value as unknown as RouteDockManifest }), /opts\.manifest is required/)
    })
  }
})

describe('assertProviderConfig — modes', () => {
  it('rejects modes: [] next to a manifest that lists paid modes', () => {
    throwsManifestError(baseOptions({ modes: [], pricing: {} }), /not served.*x402/)
  })

  it('rejects a served mode the manifest does not list', () => {
    const modes: ProviderConfigLike['modes'] = ['x402']
    const manifest = manifestForOptions({ payee: payee.publicKey(), modes, pricing: { x402: '0.001' } })
    const opts = baseOptions({
      modes: ['x402', 'mpp-charge'],
      pricing: { x402: '0.001', 'mpp-charge': '0.7' },
      manifest,
    })
    throwsManifestError(opts, /served but not in manifest\.modes: mpp-charge/)
  })

  it('rejects a manifest mode the adapter does not serve', () => {
    const opts = baseOptions({ modes: ['x402'], pricing: { x402: '0.001' } })
    throwsManifestError(opts, /in manifest\.modes but not served.*mpp-charge/)
  })

  it('treats a mode listed in modes but missing from pricing as not served', () => {
    const opts = baseOptions()
    delete opts.pricing['mpp-charge']
    throwsManifestError(opts, /in manifest\.modes but not served.*mpp-charge/)
  })

  it('ignores a priced mode that is not in modes (it is not served)', () => {
    const modes: ProviderConfigLike['modes'] = ['x402']
    const manifest = manifestForOptions({ payee: payee.publicKey(), modes, pricing: { x402: '0.001' } })
    const opts = baseOptions({ modes, pricing: { x402: '0.001', 'mpp-charge': '0.7' }, manifest })
    assert.doesNotThrow(() => assertProviderConfig(opts, 'testAdapter'))
  })
})

describe('assertProviderConfig — prices', () => {
  it('rejects an x402 price that differs from the manifest, naming the mode and both values', () => {
    const opts = baseOptions()
    opts.pricing.x402 = '0.5'
    throwsManifestError(opts, /pricing\.x402 "0\.5" does not match manifest\.pricing\.x402\.amount "0\.001"/)
  })

  it('rejects an mpp-charge price that differs from the manifest, naming the mode and both values', () => {
    const opts = baseOptions()
    opts.pricing['mpp-charge'] = '0.7'
    throwsManifestError(opts, /pricing\.mpp-charge "0\.7" does not match manifest\.pricing\.mpp-charge\.amount "0\.0008"/)
  })

  it('rejects a difference in the last base unit', () => {
    const opts = baseOptions()
    opts.pricing.x402 = '0.0010001'
    throwsManifestError(opts, /pricing\.x402/)
  })

  it('rejects an unparseable option price, naming the field', () => {
    const opts = baseOptions()
    opts.pricing.x402 = 'free'
    throwsManifestError(opts, /pricing\.x402 has an unparseable option amount "free"/)
  })

  it('rejects a manifest amount with too many decimals via the schema pattern', () => {
    const opts = baseOptions()
    opts.manifest.pricing.x402 = { amount: '1.00000001', per: 'request' }
    throwsManifestError(opts, /pricing.*amount.*does not match pattern/)
  })

  it('rejects an mpp-session rate that differs from the manifest', () => {
    const opts = baseOptions()
    opts.pricing['mpp-session'] = { rate: '0.9', channelFactory: TEST_CHANNEL_CONTRACT }
    throwsManifestError(opts, /pricing\.mpp-session\.rate "0\.9" does not match manifest\.pricing\.mpp-session\.rate "0\.0001"/)
  })

  it('rejects an mpp-session channelFactory that differs from the manifest', () => {
    const opts = baseOptions()
    opts.pricing['mpp-session'] = { rate: '0.0001', channelFactory: OTHER_CHANNEL }
    throwsManifestError(opts, /pricing\.mpp-session\.channelFactory/)
  })

  it('rejects an mpp-session-ws rate that differs from the manifest', () => {
    const opts = baseOptions()
    opts.pricing['mpp-session-ws'] = { rate: '0.9', channelFactory: TEST_CHANNEL_CONTRACT }
    throwsManifestError(opts, /pricing\.mpp-session-ws\.rate/)
  })

  it('rejects an mpp-session-ws channelFactory that differs from the manifest', () => {
    const opts = baseOptions()
    opts.pricing['mpp-session-ws'] = { rate: '0.0002', channelFactory: OTHER_CHANNEL }
    throwsManifestError(opts, /pricing\.mpp-session-ws\.channelFactory/)
  })

  it("accepts '0.0001' vs '0.00010' session rates", () => {
    const opts = baseOptions()
    opts.manifest.pricing['mpp-session']!.rate = '0.00010'
    assert.doesNotThrow(() => assertProviderConfig(opts, 'testAdapter'))
  })
})

describe('assertProviderConfig — asset and network', () => {
  it('rejects an assetContract that differs from the manifest', () => {
    throwsManifestError(baseOptions({ assetContract: OTHER_ASSET_CONTRACT }), /assetContract ".*" does not match manifest\.asset_contract/)
  })

  it('rejects an asset that differs from the manifest', () => {
    throwsManifestError(baseOptions({ asset: 'XLM' }), /asset "XLM" does not match manifest\.asset "USDC"/)
  })

  it('rejects a network that differs from the manifest', () => {
    throwsManifestError(baseOptions({ network: 'mainnet' }), /network "mainnet" does not match manifest\.network "testnet"/)
  })
})

describe('assertProviderConfig — payee', () => {
  it('rejects a payeeSecretKey that does not belong to manifest.payee', () => {
    const stranger = Keypair.random()
    throwsManifestError(baseOptions({ payeeSecretKey: stranger.secret() }), /payeeSecretKey belongs to G.* not manifest\.payee/)
  })

  it('rejects a payeeSecretKey that is not a Stellar secret', () => {
    throwsManifestError(baseOptions({ payeeSecretKey: 'not-a-secret' }), /payeeSecretKey is not a valid Stellar secret key/)
  })

  it('rejects an options.payee that differs from manifest.payee', () => {
    throwsManifestError(baseOptions({ payee: Keypair.random().publicKey() }), /payee ".*" does not match manifest\.payee/)
  })
})

describe('assertProviderConfig — the issue #328 repro', () => {
  it('throws for the drifted Hono configuration instead of serving a 402 for another asset', () => {
    const manifest = manifestForOptions({
      payee: payee.publicKey(),
      modes: ['x402'],
      pricing: { x402: '0.001' },
      assetContract: TEST_ASSET_CONTRACT,
    })
    const opts: ProviderConfigLike = {
      modes: ['x402', 'mpp-charge'],
      pricing: { x402: '0.5', 'mpp-charge': '0.7' },
      assetContract: OTHER_ASSET_CONTRACT,
      payee: payee.publicKey(),
      network: 'testnet',
      payeeSecretKey: payee.secret(),
      manifest,
    }
    assert.throws(() => assertProviderConfig(opts, 'routedockHono'), RouteDockManifestError)
  })
})
