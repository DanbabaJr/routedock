/**
 * Tests for in-flight manifest fetch deduplication (#577).
 *
 * fetchManifest had a TTL cache but no in-flight dedupe: every concurrent
 * cache miss started its own request, so an agent fanning out N pay() calls
 * at startup (or right after the 60s TTL expired) sent N manifest requests
 * and ran N signature verifications. Concurrent misses must now share one
 * HTTP request, a rejected shared fetch must reject every waiter without
 * being cached, and the per-caller trust anchor must still be enforced.
 *
 * Mirrors manifest-cache.test.ts: a real local HTTP server serves a signed
 * manifest, counts hits, and delays responses so concurrent calls overlap.
 *
 * Run with: pnpm --filter @routedock/routedock test
 */

import * as http from 'node:http'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import { fetchManifest } from '../ModeRouter.js'
import { signManifest } from '../../manifest/sign.js'
import { RouteDockManifestError, RouteDockSignatureError } from '../../errors.js'
import type { RouteDockManifest } from '../../types.js'

const signingKey = Keypair.random()

function createManifest(): RouteDockManifest {
  return {
    routedock: '1.0',
    name: 'Inflight Dedupe Provider',
    description: 'Manifest used to verify in-flight fetch deduplication',
    modes: ['x402'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    payee: signingKey.publicKey(),
    pricing: {
      x402: {
        amount: '1.00',
        per: 'request',
        facilitator: 'https://facilitator.example',
      },
    },
    endpoints: {
      price: {
        method: 'GET',
        path: '/price',
      },
    },
    tags: ['test'],
  }
}

const signedManifest = signManifest(createManifest(), signingKey.secret())

interface CountingServer {
  baseUrl: string
  hits: { count: number }
  /** When true, every request gets a 404 instead of the manifest. */
  failing: { value: boolean }
  close: () => Promise<void>
}

/**
 * Start a manifest server that counts hits and delays each response by
 * `delayMs` so that concurrently issued requests are all in flight (and all
 * cache misses) before the first one completes.
 */
function startManifestServer(delayMs = 50): Promise<CountingServer> {
  return new Promise((resolve) => {
    const hits = { count: 0 }
    const failing = { value: false }
    const server = http.createServer((_req, res) => {
      hits.count += 1
      const respond = () => {
        if (failing.value) {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('not found')
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(signedManifest))
      }
      setTimeout(respond, delayMs)
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        hits,
        failing,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

describe('fetchManifest — in-flight dedupe', () => {
  it('20 concurrent calls for one origin result in one HTTP request', async () => {
    const server = await startManifestServer()
    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, () => fetchManifest(server.baseUrl)),
      )
      assert.equal(server.hits.count, 1, 'concurrent misses must share one request')
      for (const manifest of results) {
        assert.equal(manifest, results[0], 'every caller must receive the shared manifest')
      }
    } finally {
      await server.close()
    }
  })

  it('a failing shared fetch rejects all waiters and is not cached, so the next call retries', async () => {
    const server = await startManifestServer()
    try {
      server.failing.value = true
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => fetchManifest(server.baseUrl)),
      )
      assert.equal(server.hits.count, 1, 'the failing fetch must also be deduplicated')
      for (const result of results) {
        assert.equal(result.status, 'rejected')
        if (result.status === 'rejected') {
          assert.ok(
            result.reason instanceof RouteDockManifestError,
            `expected a manifest error, got ${String(result.reason)}`,
          )
        }
      }

      server.failing.value = false
      const manifest = await fetchManifest(server.baseUrl)
      assert.equal(server.hits.count, 2, 'a rejected shared fetch must not be cached')
      assert.equal(manifest.payee, signingKey.publicKey())
    } finally {
      await server.close()
    }
  })

  it('expectedPayee is still enforced per caller on a shared fetch', async () => {
    const server = await startManifestServer()
    try {
      const wrongPayee = Keypair.random().publicKey()
      const [anchored, unanchored] = await Promise.allSettled([
        fetchManifest(server.baseUrl, undefined, undefined, signingKey.publicKey()),
        fetchManifest(server.baseUrl, undefined, undefined, wrongPayee),
      ])
      assert.equal(server.hits.count, 1, 'the fetch underlying both callers must be shared')
      assert.equal(anchored.status, 'fulfilled', 'the caller with the right anchor must succeed')
      assert.equal(unanchored.status, 'rejected', 'the caller with a wrong anchor must be rejected')
      if (unanchored.status === 'rejected') {
        assert.ok(unanchored.reason instanceof RouteDockSignatureError)
      }
    } finally {
      await server.close()
    }
  })

  it('expectedPayee is enforced for a late caller that joins a warm cache', async () => {
    const server = await startManifestServer()
    try {
      const first = await fetchManifest(server.baseUrl, undefined, undefined, signingKey.publicKey())
      assert.equal(server.hits.count, 1)

      const wrongPayee = Keypair.random().publicKey()
      await assert.rejects(
        () => fetchManifest(server.baseUrl, undefined, undefined, wrongPayee),
        (err: unknown) => err instanceof RouteDockSignatureError,
      )
      assert.equal(first.payee, signingKey.publicKey())
      assert.equal(server.hits.count, 1, 'the cache-hit path must not refetch')
    } finally {
      await server.close()
    }
  })

  it('sequential calls after the shared fetch still hit the cache', async () => {
    const server = await startManifestServer()
    try {
      const [a, b] = await Promise.all([
        fetchManifest(server.baseUrl),
        fetchManifest(server.baseUrl),
      ])
      assert.equal(server.hits.count, 1)
      const later = await fetchManifest(server.baseUrl)
      assert.equal(server.hits.count, 1, 'a completed shared fetch must be cached')
      assert.equal(later, a)
      assert.equal(a, b)
    } finally {
      await server.close()
    }
  })
})
