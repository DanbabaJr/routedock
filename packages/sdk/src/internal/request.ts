/**
 * Request preparation helpers for #560: pay() and SessionHandle.stream() can
 * carry a caller-supplied method/headers/body that must survive the unpaid
 * probe, the paid request, and every retry. A `BodyInit` such as a
 * ReadableStream or Request can only be read once, so it is buffered into an
 * ArrayBuffer here and re-sent verbatim on each attempt.
 */
import type { PaymentRequestInit } from '../types.js'

/** A caller request whose body is safe to resend (and re-read) repeatedly. */
export interface PreparedRequest {
  method?: string
  headers?: Record<string, string>
  body?: BodyInit
}

/** Is this body reusable without consumption? ReadableStream / Request are not. */
function isReusableBody(body: BodyInit): boolean {
  return (
    typeof body === 'string' ||
    body instanceof ArrayBuffer ||
    body instanceof URLSearchParams ||
    body instanceof Blob ||
    body instanceof FormData ||
    ArrayBuffer.isView(body)
  )
}

/**
 * Normalize the optional `request` into a resendable form.
 * - `method` is normalized to uppercase.
 * - Trivially reusable bodies (string, ArrayBuffer, ArrayBufferView,
 *   URLSearchParams, Blob, FormData) pass through; one-shot bodies
 *   (ReadableStream, Request) are consumed once into an ArrayBuffer.
 */
export async function prepareRequest(request?: PaymentRequestInit): Promise<PreparedRequest> {
  if (!request) return {}

  const prepared: PreparedRequest = {}
  if (typeof request.method === 'string' && request.method !== '') {
    prepared.method = request.method.toUpperCase()
  }
  if (request.headers !== undefined) prepared.headers = { ...request.headers }
  if (request.body != null) {
    prepared.body = isReusableBody(request.body)
      ? request.body
      : await new Response(request.body).arrayBuffer()
  }
  return prepared
}

/**
 * Merge header records, with later arguments winning on name collisions.
 * `mergeHeaderRecords(callerHeaders, paymentHeaders)` guarantees payment
 * headers cannot be overridden by caller headers (#560 acceptance criteria).
 * Keys are normalized case-insensitively (HTTP semantics): a caller's
 * `x-payment` cannot coexist with the payment layer's `X-Payment`.
 */
export function mergeHeaderRecords(
  ...records: Array<Record<string, string> | undefined>
): Record<string, string> | undefined {
  if (records.every((record) => record === undefined)) return undefined
  const out: Record<string, string> = {}
  for (const record of records) {
    if (record === undefined) continue
    for (const [name, value] of Object.entries(record)) {
      out[name.toLowerCase()] = value
    }
  }
  return out
}

/**
 * Build a `RequestInit` from a `PreparedRequest`. Keys are only set when
 * defined so `exactOptionalPropertyTypes` passes and `fetch` keeps its
 * default behavior for an omitted method (GET) and no body. `extraHeaders`
 * are merged on top of the caller's headers (they win on collisions).
 */
export function toRequestInit(
  prepared: PreparedRequest,
  ...extraHeaders: Array<Record<string, string> | undefined>
): RequestInit {
  const init: RequestInit = {}
  const headers = mergeHeaderRecords(prepared.headers, ...extraHeaders)
  if (headers !== undefined) init.headers = headers
  if (prepared.method !== undefined) init.method = prepared.method
  if (prepared.body !== undefined) init.body = prepared.body
  return init
}
