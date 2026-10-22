/**
 * Tests for caller request options on pay() (#560): method/headers/body
 * must reach both the unpaid probe and the paid request (and retries),
 * payment headers must win over caller headers on name collisions, and
 * assertEndpointActive must do the per-method sunset check once pay()
 * knows the HTTP method.
 *
 * Run with: pnpm --filter @routedock/routedock test
 */
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import { X402Client } from '../x402Client.js'
import { assertEndpointActive, type ModeSelectOptions } from '../ModeRouter.js'
import { prepareRequest } from '../../internal/request.js'
import type { RouteDockManifest } from '../../types.js'
import { RouteDockFacilitatorError } from '../../errors.js'

const PAYEE = Keypair.random()

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Request Options Test Service',
  description: 'POST endpoint coverage for #560',
  modes: ['x402', 'mpp-charge'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  payee: PAYEE.publicKey(),
  pricing: {
    x402: { amount: '0.01', per: 'request', facilitator: 'https://facilitator.test' },
    'mpp-charge': { amount: '0.0008', per: 'request' },
  },
  endpoints: {},
  tags: ['test'],
}

const BODY = JSON.stringify({ prompt: 'hi', temperature: 0.7 })
const REQUEST: ModeSelectOptions['request'] = {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-tracing': 'tc-1' },
  body: BODY,
}

type CapturedInit = { method?: string | undefined; headers?: Record<string, string>; body?: BodyInit | null | undefined }

function normalizeInit(init: RequestInit): CapturedInit {
  const out: CapturedInit = {}
  if (init.method !== undefined) out.method = init.method
  if (typeof init.body === 'string') out.body = init.body
  const normalized = new Headers(init.headers as HeadersInit | undefined)
  const map: Record<string, string> = {}
  normalized.forEach((value, name) => {
    map[name] = value
  })
  out.headers = map
  return out
}

// ── X402Client ────────────────────────────────────────────────────────────────

test('x402 POST probe carries method, body and caller headers', async () => {
  const client = new X402Client(PAYEE.secret(), 'testnet')
  const originalFetch = globalThis.fetch
  const captured: CapturedInit[] = []

  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const init = (args[1] ?? {}) as RequestInit
    captured.push(normalizeInit(init))
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as typeof fetch

  try {
    const result = await client.pay('https://api.test/infer', manifest, REQUEST)
    assert.equal(result.amount, '0', 'a 200 probe means a free request')
    assert.equal(captured.length, 1)
    assert.equal(captured[0]!.method, 'POST')
    assert.equal(captured[0]!.body, BODY)
    const headers = captured[0]!.headers as unknown as Record<string, string>
    assert.equal(headers['content-type'], 'application/json')
    assert.equal(headers['x-tracing'], 'tc-1')
    assert.equal(headers['x-preferred-mode'], 'x402', 'mode hint is always present')
  } finally {
    globalThis.fetch = originalFetch
  }
})

/** Patch the (private) x402 HTTP client so the 402→paid flow runs offline. */
function stubX402Signing(client: X402Client): void {
  ;(client as unknown as { httpClient: Record<string, unknown> }).httpClient = {
    createPaymentPayload: async () => ({ payload: 'test' }),
    encodePaymentSignatureHeader: () => ({
      'X-Payment': 'test-signature',
      'X-Preferred-Mode': 'x402',
    }),
  }
}

/** A structurally valid X-Payment-Requirements header (base64 JSON). */
function requirementsHeader(): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      network: 'stellar:testnet',
      resource: 'https://api.test/infer',
      maxTimeoutSeconds: 60,
      accepts: [],
      extensions: {},
    }),
  ).toString('base64')
}

test('x402 POST paid request sends the same method/body and payment headers win', async () => {
  const client = new X402Client(PAYEE.secret(), 'testnet')
  stubX402Signing(client)
  const originalFetch = globalThis.fetch
  const captured: CapturedInit[] = []
  let calls = 0

  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const init = (args[1] ?? {}) as RequestInit
    captured.push(normalizeInit(init))
    calls++
    if (calls === 1) {
      return new Response('', {
        status: 402,
        headers: { 'X-Payment-Requirements': requirementsHeader() },
      })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as typeof fetch

  try {
    await client.pay('https://api.test/infer', manifest, {
      ...REQUEST,
      headers: { ...REQUEST.headers!, 'x-payment': 'bogus-should-lose' },
    })
    assert.equal(captured.length, 2)
    for (const cap of captured) {
      assert.equal(cap.method, 'POST', 'both probe and paid request use POST')
      assert.equal(cap.body, BODY)
    }
    const paidHeaders = captured[1]!.headers as unknown as Record<string, string>
    assert.equal(paidHeaders['x-payment'], 'test-signature', 'payment header wins the collision')
    assert.equal(paidHeaders['content-type'], 'application/json', 'caller headers survive')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('x402 retries resend the same body on the paid request', async () => {
  const client = new X402Client(PAYEE.secret(), 'testnet', {
    maxAttempts: 2,
    baseDelayMs: 1,
    maxDelayMs: 5,
  })
  stubX402Signing(client)
  const originalFetch = globalThis.fetch
  const settleCaptured: CapturedInit[] = []

  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    const init = (args[1] ?? {}) as RequestInit
    const headers = normalizeInit(init).headers as unknown as Record<string, string>
    // Probes (no payment signature) always get 402; the first settle fails
    // retryably, the second one succeeds.
    if (headers['x-payment'] === undefined) {
      return new Response('', { status: 402, headers: { 'X-Payment-Requirements': requirementsHeader() } })
    }
    settleCaptured.push(normalizeInit(init))
    if (settleCaptured.length < 2) {
      throw new RouteDockFacilitatorError(`x402 payment failed: HTTP 500`, 500)
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }) as typeof fetch

  try {
    const result = await client.pay('https://api.test/infer', manifest, REQUEST)
    assert.ok(result, 'retrying settle eventually succeeds')
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(settleCaptured.length, 2, 'expected exactly 2 settle attempts')
  for (const cap of settleCaptured) {
    assert.equal(cap.body, BODY, 'every settle retry re-sends the same body')
    assert.equal(cap.method, 'POST')
  }
})

test('prepareRequest buffers a one-shot ReadableStream body so it can be reused', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(BODY))
      controller.close()
    },
  })

  const prepared = await prepareRequest({ method: 'post', body: stream, headers: { 'content-type': 'application/json' } })
  assert.equal(prepared.method, 'POST', 'method is normalized to uppercase')
  assert.ok(prepared.body instanceof ArrayBuffer, 'one-shot body buffered to ArrayBuffer')
  assert.equal(new TextDecoder().decode(prepared.body as ArrayBuffer), BODY)

  // The same prepared request must be serializable to RequestInit twice.
  const { toRequestInit } = await import('../../internal/request.js')
  const first = toRequestInit(prepared)
  const second = toRequestInit(prepared)
  assert.equal(first.body instanceof ArrayBuffer, true)
  assert.deepEqual(second, first)
})

// ── MppChargeClient ──────────────────────────────────────────────────────────

// Mock the mppx layer before importing MppChargeClient (same pattern as
// mppChargeClient.test.ts), capturing the init it passes to fetch.
interface ChargeMppxScript {
  status?: number
  rejectFirst?: boolean
}

let chargeMppxScript: ChargeMppxScript = {}
const chargeCaptured: CapturedInit[] = []

const fakeChargeMppx = {
  fetch: async (_url: string, init?: RequestInit): Promise<Response> => {
    chargeCaptured.push(normalizeInit(init ?? {}))
    if (chargeMppxScript.rejectFirst && chargeCaptured.length === 1) {
      throw new TypeError('fetch failed')
    }
    const status = chargeMppxScript.status ?? 200
    return new Response(JSON.stringify({ ok: true }), { status })
  },
}

mock.module('mppx/client', {
  namedExports: {
    Mppx: {
      create: () => fakeChargeMppx,
    },
  },
})
mock.module('@stellar/mpp/charge/client', {
  namedExports: {
    stellar: {
      charge: () => ({ name: 'stellar/charge', intent: 'charge' }),
    },
  },
})

const { MppChargeClient } = await import('../MppChargeClient.js')

test('mpp-charge POST carries method and body', async () => {
  chargeMppxScript = {}
  chargeCaptured.length = 0
  const client = new MppChargeClient(Keypair.random(), 'testnet')
  const result = await client.pay('https://api.test/infer', manifest, REQUEST)
  assert.equal(result.mode, 'mpp-charge')
  assert.equal(chargeCaptured.length, 1)
  assert.equal(chargeCaptured[0]!.method, 'POST')
  assert.equal(chargeCaptured[0]!.body, BODY)
  const headers = chargeCaptured[0]!.headers as unknown as Record<string, string>
  assert.equal(headers['content-type'], 'application/json')
})

test('mpp-charge retries resend the same body', async () => {
  chargeMppxScript = { rejectFirst: true }
  chargeCaptured.length = 0
  const client = new MppChargeClient(Keypair.random(), 'testnet', {
    maxAttempts: 3,
    baseDelayMs: 1,
    maxDelayMs: 5,
  })
  const result = await client.pay('https://api.test/infer', manifest, REQUEST)
  assert.equal(result.mode, 'mpp-charge')
  assert.ok(chargeCaptured.length >= 2, `expected retries, got ${chargeCaptured.length} attempts`)
  for (const cap of chargeCaptured) {
    assert.equal(cap.body, BODY, 'every retry re-sends the same body')
    assert.equal(cap.method, 'POST')
  }
})

// ── Method-aware sunset check ─────────────────────────────────────────────────

const PAST = new Date(Date.now() - 60_000).toISOString()

const sharedPathManifest = {
  routedock: '1.0',
  name: 'Method Sunset Test',
  description: '',
  modes: ['x402'] as const,
  network: 'testnet' as const,
  asset: 'USDC',
  asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  payee: PAYEE.publicKey(),
  pricing: { x402: { amount: '0.01', per: 'request', facilitator: 'https://facilitator.test' } },
  endpoints: {
    inferGet: { method: 'GET', path: '/infer', sunset_at: PAST },
    inferPost: { method: 'POST', path: '/infer' },
    goodbyeGet: { method: 'GET', path: '/goodbye', sunset_at: PAST },
    goodbyePost: { method: 'POST', path: '/goodbye', sunset_at: PAST },
  },
  tags: ['test'],
} as unknown as RouteDockManifest

test('method-aware sunset: a sunet GET descriptor does not block a POST', () => {
  // GET /infer has sunset; POST /infer is active.
  // With no method → today's behavior: not every descriptor has sunset → allowed.
  assertEndpointActive(sharedPathManifest, 'https://api.test/infer')
  // With method POST → only the POST descriptor is matched → allowed.
  assert.doesNotThrow(() =>
    assertEndpointActive(sharedPathManifest, 'https://api.test/infer', undefined, 'POST'),
  )
  // With method GET → the GET /infer descriptor has sunset → refused.
  assert.throws(
    () => assertEndpointActive(sharedPathManifest, 'https://api.test/infer', undefined, 'GET'),
    /sunset/,
  )
  // Case-insensitive method matching.
  assert.throws(
    () => assertEndpointActive(sharedPathManifest, 'https://api.test/infer', undefined, 'get'),
    /sunset/,
  )
})

test('method-aware sunset: every matching descriptor sunset refused', () => {
  // GET and POST /goodbye are both sunset → refuse for any matching method.
  assert.throws(
    () => assertEndpointActive(sharedPathManifest, 'https://api.test/goodbye', undefined, 'POST'),
    /sunset/,
  )
  // A method that matches no descriptor is an unlisted path → allowed.
  assert.doesNotThrow(() =>
    assertEndpointActive(sharedPathManifest, 'https://api.test/goodbye', undefined, 'DELETE'),
  )
  // Without a method the old behavior holds: not all sunset → allowed.
  assert.doesNotThrow(() => assertEndpointActive(sharedPathManifest, 'https://api.test/infer'))
})
