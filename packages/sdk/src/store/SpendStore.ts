import { resolveLogger, type RouteDockLogger } from '../internal/logger.js'

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Daily spend accumulator, keyed by an ISO date (YYYY-MM-DD).
 *
 * Totals are decimal strings of integer microUSDC (1 USDC = 10^7 units) so
 * the record stays JSON-serializable with no floating point precision loss.
 */
export interface DailySpend {
  date: string
  /** Global accumulated spend for the day, in microUSDC (e.g. "5000000") */
  totalMicros: string
  /** Per-endpoint accumulated spend for the day, keyed by origin URL, in microUSDC */
  endpoints: Record<string, string>
}

// ── Interface ──────────────────────────────────────────────────────────────────

/**
 * Durable backing store for the client's local daily spend cap.
 *
 * The spend cap is a financial safety control: if its accumulator lives only in
 * heap memory, any crash, OOM kill, or container restart silently resets it to
 * zero and the cap can be bypassed. Inject a persistent implementation
 * (Redis, SQL, Supabase, a file, …) so the counter survives restarts.
 *
 * ### Sharing a store between processes
 * The client serializes its own read → check → write with an in-memory mutex,
 * but that only protects one `RouteDockClient` instance. If more than one
 * process (or client) can use the same backing store — the MCP server and the
 * E2E agent share `~/.routedock/spend.json` by default — a plain `read()` /
 * `write()` pair is a lost-update race: two writers both read total X, both
 * pass the cap check, and both write X + amount, so a payment vanishes from the
 * accumulator and the cap can be exceeded. A store that is shared across
 * processes MUST implement {@link SpendStore.update}, which the client uses
 * instead of `read()` + `write()` whenever it is present.
 */
export interface SpendStore {
  /** Return the persisted accumulator, or null if none has been written yet. */
  read(): Promise<DailySpend | null>
  /** Persist the accumulator. */
  write(state: DailySpend): Promise<void>
  /**
   * Atomically read-modify-write the accumulator. Optional, but required for
   * stores shared across processes (see above).
   *
   * Implementations must guarantee that no other writer can change the state
   * between the read that produces `prev` and the write of `fn`'s result:
   * `fn` receives the current state (or `null`), and returns the new state to
   * persist, or `undefined` to leave the state unchanged (no write). If `fn`
   * throws, nothing is written and the error propagates. `fn` is synchronous
   * in spirit — keep it fast and free of side effects, because an
   * implementation backed by optimistic concurrency (compare-and-swap) may
   * call it more than once. Resolves to the state after the update.
   */
  update?(
    fn: (prev: DailySpend | null) => DailySpend | undefined,
  ): Promise<DailySpend | null>
}

// ── In-memory implementation (default) ──────────────────────────────────────────

export interface InMemorySpendStoreOptions {
  /** Log a startup warning about non-durability. Defaults to true. */
  warn?: boolean
  /** Log sink for the non-durability warning. Defaults to a console-backed logger. */
  logger?: RouteDockLogger
}

/**
 * Default, non-durable {@link SpendStore}. Holds the accumulator on the heap, so
 * it resets on every process restart. Logs a startup warning unless silenced.
 * Use this only for development; inject a persistent store in production.
 */
export class InMemorySpendStore implements SpendStore {
  private state: DailySpend | null = null

  constructor(options: InMemorySpendStoreOptions = {}) {
    if (options.warn !== false) {
      resolveLogger(options.logger)(
        'warn',
        '[RouteDock] Using in-memory SpendStore: the daily spend cap is NOT durable ' +
          'and resets on every process restart. Inject a persistent SpendStore via ' +
          'RouteDockClientConfig.spendStore for production safety.',
      )
    }
  }

  async read(): Promise<DailySpend | null> {
    return this.state ? { ...this.state, endpoints: { ...this.state.endpoints } } : null
  }

  async write(state: DailySpend): Promise<void> {
    this.state = { ...state, endpoints: { ...state.endpoints } }
  }
}

