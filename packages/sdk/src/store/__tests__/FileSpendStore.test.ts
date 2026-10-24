import assert from 'node:assert/strict'
import { describe, it, after, before } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Keypair } from '@stellar/stellar-sdk'
import { RouteDockClient } from '../../client/RouteDockClient.js'
import { FileSpendStore } from '../FileSpendStore.js'
import type { DailySpend } from '../SpendStore.js'

let tmpDir: string

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spendstore-test-'))
})

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('FileSpendStore', () => {
  it('returns null when no file exists', async () => {
    const filePath = path.join(tmpDir, 'nonexistent.json')
    const store = new FileSpendStore(filePath)
    assert.equal(await store.read(), null)
  })

  it('round-trips a written accumulator', async () => {
    const filePath = path.join(tmpDir, 'roundtrip.json')
    const store = new FileSpendStore(filePath)
    const state: DailySpend = {
      date: '2026-06-26',
      totalMicros: '5000000',
      endpoints: { 'https://api.example.com': '2000000' },
    }
    await store.write(state)
    const read = await store.read()
    assert.deepEqual(read, state)
  })

  it('creates parent directories if they do not exist', async () => {
    const filePath = path.join(tmpDir, 'nested', 'deep', 'spend.json')
    const store = new FileSpendStore(filePath)
    const state: DailySpend = {
      date: '2026-06-26',
      totalMicros: '1000000',
      endpoints: {},
    }
    await store.write(state)
    const read = await store.read()
    assert.deepEqual(read, state)
  })

  it('overwrites an existing file', async () => {
    const filePath = path.join(tmpDir, 'overwrite.json')
    const store = new FileSpendStore(filePath)
    const state1: DailySpend = {
      date: '2026-06-25',
      totalMicros: '100',
      endpoints: { 'https://a.com': '50' },
    }
    const state2: DailySpend = {
      date: '2026-06-26',
      totalMicros: '200',
      endpoints: { 'https://b.com': '150' },
    }
    await store.write(state1)
    await store.write(state2)
    const read = await store.read()
    assert.deepEqual(read, state2)
    assert.notDeepEqual(read, state1)
  })

  it('returns the file path', () => {
    const filePath = path.join(tmpDir, 'accessor.json')
    const store = new FileSpendStore(filePath)
    assert.equal(store.filePath, filePath)
  })

  it('satisfies the SpendStore interface', async () => {
    const filePath = path.join(tmpDir, 'interface.json')
    const store = new FileSpendStore(filePath)
    assert.equal(typeof store.read, 'function')
    assert.equal(typeof store.write, 'function')
  })

  it('throws on corrupted JSON file instead of silently returning null', async () => {
    const filePath = path.join(tmpDir, 'corrupt.json')
    await fs.writeFile(filePath, '{ not valid json', 'utf-8')
    const store = new FileSpendStore(filePath)
    // A corrupt file means the cap state is unknown — must throw, not return null,
    // so the caller fails closed rather than assuming zero spend.
    await assert.rejects(
      () => store.read(),
      (err: Error) => {
        assert.ok(err.message.includes('invalid JSON'), `Expected 'invalid JSON' in: ${err.message}`)
        return true
      },
    )
  })

  it('throws on a directory instead of a file (EISDIR)', async () => {
    const dirPath = path.join(tmpDir, 'is-dir')
    await fs.mkdir(dirPath, { recursive: true })
    const store = new FileSpendStore(dirPath)
    // EISDIR is not ENOENT — the file path exists but is unreadable as a file.
    await assert.rejects(
      () => store.read(),
      (err: Error) => {
        assert.ok(err.message.includes('Failed to read'), `Expected 'Failed to read' in: ${err.message}`)
        return true
      },
    )
  })

  it('leaves no window where the file is absent or partial (atomic write)', async () => {
    const filePath = path.join(tmpDir, 'atomic.json')
    const store = new FileSpendStore(filePath)
    const state: DailySpend = {
      date: '2026-06-26',
      totalMicros: '1000000',
      endpoints: { 'https://api.example.com': '500000' },
    }
    await store.write(state)

    // The .tmp file must not exist after a successful write — it was renamed.
    await assert.rejects(
      () => fs.access(`${filePath}.tmp`),
      { code: 'ENOENT' },
      '.tmp file must not remain after write',
    )

    // The target file must contain valid JSON matching the written state.
    const read = await store.read()
    assert.deepEqual(read, state)
  })
})

// ── Concurrency (#562) ───────────────────────────────────────────────────────

const day = (totalMicros: string): DailySpend => ({ date: '2026-06-26', totalMicros, endpoints: {} })

describe('FileSpendStore — concurrent writers', () => {
  it('concurrent writes never fail (unique tmp file per write, no ENOENT on rename)', async () => {
    const filePath = path.join(tmpDir, 'concurrent-writes.json')
    const a = new FileSpendStore(filePath)
    const b = new FileSpendStore(filePath)

    await Promise.all(
      Array.from({ length: 60 }, (_, i) => (i % 2 ? a : b).write(day(String(i)))),
    )

    const final = await a.read()
    assert.ok(final, 'file is readable, valid JSON')
    assert.match(final.totalMicros, /^\d+$/)
    const leftovers = (await fs.readdir(tmpDir)).filter(
      (f) => f.startsWith('concurrent-writes.json.') && f !== 'concurrent-writes.json.lock',
    )
    assert.deepEqual(leftovers, [], 'no tmp files left behind')
  })

  it('update() from two instances never loses an increment', async () => {
    const filePath = path.join(tmpDir, 'interleaved-update.json')
    const a = new FileSpendStore(filePath)
    const b = new FileSpendStore(filePath)
    const bump = (prev: DailySpend | null): DailySpend =>
      day((BigInt(prev?.totalMicros ?? '0') + 1n).toString())

    await Promise.all(Array.from({ length: 100 }, (_, i) => (i % 2 ? a : b).update(bump)))

    assert.equal((await a.read())?.totalMicros, '100')
    await assert.rejects(fs.stat(`${filePath}.lock`), { code: 'ENOENT' }, 'lock released')
  })

  it('update() receives null on first use and returns the new state', async () => {
    const store = new FileSpendStore(path.join(tmpDir, 'update-first.json'))
    let seen: DailySpend | null | undefined
    const result = await store.update((prev) => {
      seen = prev
      return day('7')
    })
    assert.equal(seen, null)
    assert.deepEqual(result, day('7'))
    assert.deepEqual(await store.read(), day('7'))
  })

  it('update() writes nothing when the callback returns undefined', async () => {
    const filePath = path.join(tmpDir, 'update-noop.json')
    const store = new FileSpendStore(filePath)
    await store.write(day('5'))
    const result = await store.update(() => undefined)
    assert.deepEqual(result, day('5'))
    assert.deepEqual(await store.read(), day('5'))
  })

  it('update() leaves the file untouched and releases the lock when the callback throws', async () => {
    const filePath = path.join(tmpDir, 'update-throws.json')
    const store = new FileSpendStore(filePath)
    await store.write(day('5'))

    await assert.rejects(
      store.update(() => {
        throw new Error('cap exceeded')
      }),
      /cap exceeded/,
    )

    assert.deepEqual(await store.read(), day('5'))
    await assert.rejects(fs.stat(`${filePath}.lock`), { code: 'ENOENT' })
    // and the store is still usable
    await store.update(() => day('6'))
    assert.deepEqual(await store.read(), day('6'))
  })

  it('update() fails closed on a corrupt spend file', async () => {
    const filePath = path.join(tmpDir, 'update-corrupt.json')
    await fs.writeFile(filePath, '{not json')
    const store = new FileSpendStore(filePath)
    await assert.rejects(store.update(() => day('1')), /invalid JSON/)
    await assert.rejects(fs.stat(`${filePath}.lock`), { code: 'ENOENT' }, 'lock released on error')
  })

  it('breaks a stale lock left by a crashed process', async () => {
    const filePath = path.join(tmpDir, 'stale-lock.json')
    const lockPath = `${filePath}.lock`
    await fs.writeFile(lockPath, '99999:dead')
    const old = new Date(Date.now() - 60_000)
    await fs.utimes(lockPath, old, old)

    const store = new FileSpendStore(filePath, { lockStaleMs: 200, lockTimeoutMs: 2_000 })
    await store.update(() => day('3'))

    assert.deepEqual(await store.read(), day('3'))
    await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' })
  })

  it('times out (fails closed) while another holder keeps a fresh lock', async () => {
    const filePath = path.join(tmpDir, 'held-lock.json')
    const lockPath = `${filePath}.lock`
    await fs.writeFile(lockPath, 'other-process')

    const store = new FileSpendStore(filePath, { lockStaleMs: 60_000, lockTimeoutMs: 150 })
    await assert.rejects(store.update(() => day('1')), /Timed out/)

    assert.equal(await fs.readFile(lockPath, 'utf-8'), 'other-process', "someone else's lock is untouched")
    assert.equal(await store.read(), null, 'nothing was written')
  })

  it('waits for a held lock to be released, then proceeds', async () => {
    const filePath = path.join(tmpDir, 'released-lock.json')
    const lockPath = `${filePath}.lock`
    await fs.writeFile(lockPath, 'other-process')
    setTimeout(() => void fs.unlink(lockPath), 100)

    const store = new FileSpendStore(filePath, { lockStaleMs: 60_000, lockTimeoutMs: 3_000 })
    await store.update(() => day('9'))
    assert.deepEqual(await store.read(), day('9'))
  })
})

describe('RouteDockClient spend cap over a shared FileSpendStore (#562)', () => {
  type Reserver = { _checkAndReserveSpend(amount: string, endpointKey: string, asset: string): Promise<string> }
  const origin = 'https://provider.test'

  function clientOn(filePath: string, dailyCap: string): Reserver {
    return new RouteDockClient({
      wallet: Keypair.random(),
      network: 'testnet',
      spendCap: { daily: dailyCap, asset: 'USDC' },
      spendStore: new FileSpendStore(filePath),
    }) as unknown as Reserver
  }

  it('two clients (separate mutexes, one file) never exceed the cap or lose a reservation', async () => {
    const filePath = path.join(tmpDir, 'two-clients.json')
    const clients = [clientOn(filePath, '5'), clientOn(filePath, '5')]

    // 2 clients x 40 attempts of 0.25 USDC against a 5 USDC cap = 20 slots.
    const results = await Promise.allSettled(
      Array.from({ length: 80 }, (_, i) => clients[i % 2]!._checkAndReserveSpend('0.25', origin, 'USDC')),
    )
    const granted = results.filter((r) => r.status === 'fulfilled').length

    assert.equal(granted, 20, 'exactly the cap worth of reservations is granted')
    const stored = await new FileSpendStore(filePath).read()
    assert.equal(stored?.totalMicros, String(granted * 2_500_000), 'accumulator equals the granted total')
  })

  it('separate processes sharing one file: granted total equals the stored total and the cap holds', async () => {
    const filePath = path.join(tmpDir, 'multi-process.json')
    const sdkDir = fileURLToPath(new URL('../../../', import.meta.url))
    const worker = fileURLToPath(new URL('./fixtures/spend-worker.ts', import.meta.url))
    const startAt = Date.now() + 6_000 // slow machines need time to boot four tsx processes
    const WORKERS = 4
    const ATTEMPTS = 40 // 4 x 40 = 160 attempts of 0.1 USDC against a 10 USDC cap (100 slots)

    const run = () =>
      new Promise<{ granted: number; rejected: number }>((resolve, reject) => {
        execFile(
          process.execPath,
          ['--import', 'tsx', worker, filePath, String(ATTEMPTS), '0.1', '10', String(startAt)],
          { cwd: sdkDir, timeout: 60_000 },
          (err, stdout, stderr) => {
            if (err) return reject(new Error(`worker failed: ${err.message}\n${stderr}`))
            resolve(JSON.parse(stdout) as { granted: number; rejected: number })
          },
        )
      })

    const outcomes = await Promise.all(Array.from({ length: WORKERS }, run))
    const granted = outcomes.reduce((n, o) => n + o.granted, 0)
    const rejected = outcomes.reduce((n, o) => n + o.rejected, 0)

    assert.equal(granted + rejected, WORKERS * ATTEMPTS)
    const stored = await new FileSpendStore(filePath).read()
    assert.equal(
      stored?.totalMicros,
      String(granted * 1_000_000),
      `lost update: granted ${granted} reservations but the file records ${stored?.totalMicros}`,
    )
    assert.equal(granted, 100, 'the cap is filled exactly, never exceeded')
    await assert.rejects(fs.stat(`${filePath}.lock`), { code: 'ENOENT' }, 'lock released')
  })
})
