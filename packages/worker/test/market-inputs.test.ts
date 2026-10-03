// WORKER-1 market inputs (review of f679188, item 3): the live SOL/USD price for risk, and the swap stream of every
// watched pool (its fee terms and the deployer-sell trigger).
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIVE_FEED, FakeSocketHub, LiveFeed, type Frame, CoinbaseSolPrice, COINBASE_WS_URL, dollarsToMicro } from '../src/providers/index.ts';
import { ManualTimers, P1, P3 } from '../src/scheduler/index.ts';
import { PoolWatch } from '../src/run/pool-watch.ts';
import { readdirSync, readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { join } from 'node:path';
import { rpcHandler, scriptedHttp } from '../src/providers/index.ts';
import { CreditBook, FEED_COMMITMENTS, LiveProviders } from '../src/run/sources.ts';
import { DelayProbe } from '../src/run/delay-probe.ts';
import { Recorder } from '../src/run/recorder.ts';
import { setSecretValues } from '../src/run/redact.ts';
import { checkQuota } from '../../runner/src/quota.ts';
import { blockNetwork, recordOf, settle, testSecrets, tx } from './helpers.ts';
import { makeWorker, tempState } from './worker-harness.ts';

blockNetwork();

describe('SOL/USD from the Coinbase ticker', () => {
  const setup = () => {
    const timers = new ManualTimers(Date.parse('2026-10-04T00:00:10Z'));
    const hub = new FakeSocketHub();
    const frames: Frame[] = [];
    const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, onFrame: (f) => frames.push(f) });
    const src = new CoinbaseSolPrice({ factory: hub.factory, timers, feed, key: 'worker:sol-price' });
    src.start();
    hub.last.open();
    const prices = () => frames.filter((f) => f.body.type === 'fact').map((f) => (f.body as { value: unknown }).value);
    return { timers, hub, prices, src };
  };
  const tick = (price: string, time: string) => ({ type: 'ticker', product_id: 'SOL-USD', price, time });

  it('subscribes to the SOL-USD ticker and turns each trade into micro-dollars, dated at the trade', () => {
    const { hub, prices } = setup();
    expect(hub.last.url).toBe(COINBASE_WS_URL);
    expect(hub.last.requests()).toEqual([{ type: 'subscribe', product_ids: ['SOL-USD'], channels: ['ticker'] }]);
    hub.last.push(tick('119.92', '2026-10-04T00:00:09.250Z'));
    hub.last.push(tick('119.93', '2026-10-04T00:00:09.300Z')); // within 500 ms of the last: skipped
    hub.last.push(tick('120.1', '2026-10-04T00:00:09.900Z'));
    hub.last.push({ type: 'ticker', product_id: 'BTC-USD', price: '1', time: '2026-10-04T00:00:09.990Z' });
    expect(prices()).toEqual([{ value: 119_920_000n, atMs: Date.parse('2026-10-04T00:00:09.250Z') }, { value: 120_100_000n, atMs: Date.parse('2026-10-04T00:00:09.900Z') }]);
  });

  it('a stall makes no fresh price: nothing is re-dated by its receipt, and a trade from the future is dated now', () => {
    const { hub, prices, timers } = setup();
    hub.last.push(tick('119.92', '2026-10-04T00:00:09.000Z'));
    timers.advance(20_000);
    // The same old trade again (a replayed message after a stall): still dated at its trade time, so still stale.
    hub.last.push(tick('119.92', '2026-10-04T00:00:09.000Z'));
    hub.last.push(tick('119.95', '2026-10-04T01:00:00.000Z'));
    expect(prices()).toEqual([{ value: 119_920_000n, atMs: Date.parse('2026-10-04T00:00:09.000Z') }, { value: 119_950_000n, atMs: timers.now() }]);
  });

  it('reads decimal prices exactly and refuses anything else', () => {
    expect(dollarsToMicro('119.916760')).toBe(119_916_760n);
    expect(dollarsToMicro('0.5')).toBe(500_000n);
    for (const bad of ['119.9167604', '-1', '1e3', '', ' 1']) expect(dollarsToMicro(bad), bad).toBeNull();
  });
});

describe('the swap stream of each watched pool', () => {
  const fake = () => {
    const calls: string[] = [];
    let next = 1;
    const stream = {
      watchLogs: (address: string, o: { priority: number; decodeLogs?: boolean; coverage?: string; commitment?: string }) => {
        calls.push(`watch ${address} P${o.priority} ${String(o.decodeLogs)} ${o.coverage} ${o.commitment}`);
        return next++;
      },
      unwatch: (id: number, reason?: string) => void calls.push(`unwatch ${id} ${reason}`),
    };
    return { calls, stream };
  };

  it('follows the list at confirmed (POS-1: the pool state is built from these swaps): a candidate at P3, a held pool at P1, dropped pools unwatched', () => {
    const { calls, stream } = fake();
    let list = new Map([['poolA', { mint: 'mA', held: false }]]);
    const w = new PoolWatch({ stream, timers: new ManualTimers(0), pools: () => list, everyMs: 2_000 });
    w.sync();
    expect(calls).toEqual([`watch poolA P${P3} true trades:poolA confirmed`]);
    list = new Map([['poolA', { mint: 'mA', held: true }], ['poolB', { mint: 'mB', held: false }]]);
    w.sync();
    expect(calls.slice(1)).toEqual(['unwatch 1 priority changed', `watch poolA P${P1} true trades:poolA confirmed`, `watch poolB P${P3} true trades:poolB confirmed`]);
    list = new Map();
    w.sync();
    expect(calls.slice(4)).toEqual(['unwatch 2 not watched', 'unwatch 3 not watched']);
  });

  it('a refused watch (the budget halt) is retried at the next sync', () => {
    const { calls, stream } = fake();
    let refuse = true;
    const s = { ...stream, watchLogs: (a: string, o: { priority: number }) => {
      if (refuse) throw new Error('halted');
      return stream.watchLogs(a, o);
    } };
    const w = new PoolWatch({ stream: s, timers: new ManualTimers(0), pools: () => new Map([['poolA', { mint: 'mA', held: false }]]), everyMs: 2_000 });
    w.sync();
    expect(w.watching.size).toBe(0);
    refuse = false;
    w.sync();
    expect(calls).toEqual([`watch poolA P${P3} true trades:poolA confirmed`]);
    expect(w.watching.size).toBe(1);
  });
});

describe('LiveProviders on scripted sockets: a live migration reaches an entry decision (no scripted facts)', () => {
  it('slots, the migration from PumpPortal and its fetched transaction, the SOL price and the pool watch, through the real feeds', async () => {
    const mig = tx('migration CreatePoolEvent');
    const record = recordOf(mig);
    const blockMs = Number(record.blockTime) * 1000;
    // An hour and a bit after the migration: inside U2's window, so the candidate is judged.
    const manual = new ManualTimers(blockMs + 61 * 60_000);
    const timers = Object.assign(manual, { set: (ms: number) => manual.advance(Math.max(0, ms - manual.now())) });
    const hub = new FakeSocketHub();
    const http = scriptedHttp(rpcHandler((m) => (m === 'getTransaction' ? mig.base64 : m === 'getSignaturesForAddress' ? [] : null)));
    const stateDir = tempState();
    const providers = new LiveProviders({ tradeStreams: false, secrets: testSecrets, http, factory: hub.factory, credits: new CreditBook(stateDir, timers) });
    const h = makeWorker({ stateDir, timers, seedWaitMs: 0, sources: (ctx) => providers.feeds(ctx), ops: () => providers.ops(), config: { ZEROED_HEALTH_ADDR: '127.0.0.1:18860', ZEROED_API_ADDR: '127.0.0.1:18861' } });
    const socket = (part: string) => hub.sockets.filter((s) => s.url.includes(part)).at(-1);
    const acked = new Map<unknown, number>();
    const opened = new Set<unknown>();
    let slot = BigInt(mig.slot) + 50n;
    let migrated = false;
    const drive = async (ms: number, done?: () => boolean): Promise<void> => {
      for (let t = 0; t < ms && !(done?.() ?? false); t += 100) {
        for (const s of hub.sockets) {
          if (opened.has(s) || s.closed !== null) continue;
          opened.add(s);
          s.open();
        }
        const hel = socket('helius');
        if (hel !== undefined) {
          const reqs = hel.requests();
          for (let k = acked.get(hel) ?? 0; k < reqs.length; k++) {
            const r = reqs[k]!;
            if (typeof r.method === 'string' && r.method.endsWith('Subscribe') && r.id !== undefined) hel.push({ jsonrpc: '2.0', id: r.id, result: 500 + k });
          }
          acked.set(hel, reqs.length);
          if (t % 400 === 0) hel.push({ jsonrpc: '2.0', method: 'slotNotification', params: { subscription: 500, result: { slot: Number(slot++), parent: 0, root: 0 } } });
        }
        if (t % 500 === 0) socket('coinbase')?.push({ type: 'ticker', product_id: 'SOL-USD', price: '150.25', time: new Date(timers.now()).toISOString() });
        timers.advance(100);
        await settle(5);
        await new Promise<void>((r) => setImmediate(r));
      }
    };
    const started = h.worker.start();
    let result: unknown = null;
    void started.then((r) => (result = r));
    await drive(20_000, () => result !== null);
    expect(result).toEqual({ ok: true });
    socket('pumpportal')!.push({ signature: mig.signature, mint: 'So11111111111111111111111111111111111111112', txType: 'migrate', pool: 'pump-amm' });
    migrated = true;
    await drive(8_000);
    expect(migrated).toBe(true);
    const decisions = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; reasons?: string[] }).filter((l) => l.kind === 'decision');
    const shortlist = decisions.find((d) => d.reasons?.[0] === 'shortlist');
    expect(shortlist).toBeDefined();
    const mint = shortlist!.reasons![2]!;
    // Judged: a reject naming the reason (the gate facts FACTS-1 produces are not wired in this test).
    expect(decisions.some((d) => d.reasons?.[0] === 'reject' && d.reasons[2] === mint)).toBe(true);
    // The candidate's pool is watched for swaps, under its own stream name.
    const pools = [...h.worker.strategy.watchedPools()];
    expect(pools).toHaveLength(1);
    const logs = socket('helius')!.requests().filter((r) => r.method === 'logsSubscribe').map((r) => (r.params as [{ mentions: string[] }])[0].mentions[0]);
    expect(logs).toContain(pools[0]![0]);
    // Every critical feed is up and fresh (helius-ws and coinbase-ws), so entries are not halted.
    expect(h.worker.health().halt_reasons).toEqual([]);
    expect(Object.keys(h.worker.health().feeds).sort()).toEqual(['coinbase-ws', 'helius-ws', 'pumpportal']);
    // RUN-1c: the chain feed is up, so an exit could go out; every free-plan provider reports its credits by class.
    const health = h.worker.health();
    expect(health.exit_capable).toBe(true);
    expect(checkQuota(health.quota)).toMatchObject({ ok: true });
    const helius = health.quota.find((q) => q.provider === 'helius')!;
    expect(helius.credits_used).toBeGreaterThan(0);
    expect(helius.credits_by_class.reduce((a, b) => a + b, 0)).toBe(helius.credits_used);
    expect(health.lookups.counts.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1);
    await h.worker.stop();
    // The SOL price went on the feed as a fact from Coinbase (the recorder holds every frame).
    const frames = readdirSync(join(stateDir, 'recorder'), { recursive: true, encoding: 'utf8' }).filter((f) => /frames-\d+\.jsonl\.zst$/.test(f))
      .flatMap((f) => zstdDecompressSync(readFileSync(join(stateDir, 'recorder', f))).toString('utf8').split('\n').filter((l) => l !== ''));
    expect(frames.some((l) => l.includes('"source":"coinbase"') && l.includes('"key":"worker:sol-price"'))).toBe(true);
  }, 60_000);
});

describe('processed and confirmed arrival of the same signature (supervisor ruling 2026-10-04, BT-1c)', () => {
  it('samples the newest processed sighting, reads it at confirmed and records both arrival times on this host', async () => {
    const t = tx('pump CreateEvent');
    const record = recordOf(t);
    const timers = new ManualTimers(1_000_000);
    const rows: { row: Readonly<Record<string, unknown>>; at: number }[] = [];
    let mono = 0;
    const reads: string[] = [];
    const probe = new DelayProbe({
      timers, via: 'logs:TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM', everyMs: 60_000, record: (row, at) => void rows.push({ row, at }), mono: () => (mono += 250.5),
      confirmed: async (sig) => {
        reads.push(sig);
        return record;
      },
    });
    const seen = (via: string, at: number, backfilled = false): Frame => ({ seq: 0, receivedAt: at, source: 'helius', backfilled, place: { at: 'offchain', slot: 1n }, duplicate: false, body: { type: 'seen', signature: t.signature, slot: record.slot, err: null, via, detail: null } });
    probe.frame(seen('pumpportal:create', 999_000));
    probe.frame(seen('logs:TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM', 1_000_100));
    probe.start();
    timers.advance(60_000);
    await settle();
    expect(reads).toEqual([t.signature]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.row).toEqual({
      signature: t.signature, slot: record.slot, processed_mono_ms: 250.5, confirmed_mono_ms: 501, delay_ms: 250.5, processed_at_ms: 1_000_100, processed_path: 'helius logsSubscribe logs:TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM', processed_commitment: 'processed',
      confirmed_at_ms: 1_060_000, confirmed_path: 'helius getTransaction', confirmed_commitment: 'confirmed', confirmed_slot: record.slot,
      found: true, error: null, other_sightings: [{ source: 'pumpportal:create', at: 999_000 }],
    });
    // Nothing new seen: the next minute reads nothing (one credit a minute at most).
    timers.advance(60_000);
    await settle();
    expect(reads).toHaveLength(1);
    probe.stop();
  });

  it('the recorder keeps the samples in its own table and lists the commitment of each path in the manifest', () => {
    const root = tempState();
    const rec = new Recorder({ root, boot: 'b1', gitSha: 'abc', rotateBytes: 1 << 20, commitments: FEED_COMMITMENTS });
    rec.delay({ signature: 's', slot: 5n, processed_at_ms: 1, confirmed_at_ms: 2 }, Date.parse('2026-10-04T00:00:00Z'));
    rec.close();
    const manifest = JSON.parse(readFileSync(join(root, 'b1', 'manifest.json'), 'utf8')) as { commitments: Record<string, string>; days: { files: { path: string }[] }[] };
    expect(manifest.commitments['helius-ws logsSubscribe']).toBe('processed');
    expect(manifest.commitments['helius getTransaction']).toBe('confirmed');
    const file = manifest.days.flatMap((d) => d.files).find((f) => f.path.includes('delays-'))!;
    expect(zstdDecompressSync(readFileSync(join(root, 'b1', file.path))).toString('utf8')).toBe('{"signature":"s","slot":"5","processed_at_ms":1,"confirmed_at_ms":2}\n');
  });
});

describe('redactions in recorded files are listed (re-review of #48)', () => {
  it('a file with redacted values is named in the manifest\'s coverage gaps with its count, so a replay difference is explained', () => {
    setSecretValues(['secret-value-123456']);
    const root = tempState();
    const rec = new Recorder({ root, boot: 'b1', gitSha: 'abc', rotateBytes: 1 << 20 });
    const at = Date.parse('2026-10-04T00:00:00Z');
    rec.delay({ note: 'carries secret-value-123456 twice: secret-value-123456' }, at);
    rec.delay({ note: 'clean' }, at);
    rec.close();
    setSecretValues([]);
    const manifest = JSON.parse(readFileSync(join(root, 'b1', 'manifest.json'), 'utf8')) as { coverage_gaps: { reason: string; file?: string; redactions?: number }[] };
    expect(manifest.coverage_gaps).toEqual([{ reason: 'values redacted as credentials; a replay of this file differs there', file: expect.stringMatching(/delays-000\.jsonl\.zst$/), redactions: 2 }]);
  });
});

describe('the delay probe after FACTS-1 (log frames name their commitment)', () => {
  it('samples a processed log frame, never a confirmed watch\'s copy of the same signature', async () => {
    const t = tx('pump CreateEvent');
    const record = recordOf(t);
    const timers = new ManualTimers(1_000_000);
    const rows: Readonly<Record<string, unknown>>[] = [];
    const via = 'logs:TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';
    const probe = new DelayProbe({ timers, via, everyMs: 60_000, record: (row) => void rows.push(row), confirmed: async () => record, mono: () => 0 });
    const logs = (at: number, commitment?: 'confirmed'): Frame => ({ seq: 0, receivedAt: at, source: 'helius', backfilled: false, place: { at: 'chain', slot: record.slot }, duplicate: false, body: { type: 'logs', signature: t.signature, slot: record.slot, err: null, via, logs: [], ...(commitment === undefined ? {} : { commitment }) } });
    probe.frame(logs(1_000_100));
    probe.frame(logs(1_000_900, 'confirmed'));
    probe.start();
    timers.advance(60_000);
    await settle();
    expect(rows[0]).toMatchObject({ signature: t.signature, processed_at_ms: 1_000_100, processed_commitment: 'processed' });
    probe.stop();
  });
});
