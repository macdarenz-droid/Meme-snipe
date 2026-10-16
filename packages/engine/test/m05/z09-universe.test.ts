// A-M05-01 candidate state machine (card Z09): the property test over random event sequences, the age rule (C-15),
// the C-44 config rule, Phase 0, Phase 1 handlers through test doubles, and persistence over M24.
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import fc from 'fast-check';
import type { Lamports, UnixMs } from '@bot/types';
import { MINTS } from '@bot/venue/constants';
import {
  ALLOWED, checkUniverseConfig, createUniverse, isAllowed, LIMIT_SETS, limitSetHash, MR_LIMITS, PM_LIMITS, tailReason, STATES, UNIVERSE_DEFAULTS,
  type CandidateRecord, type CandidateStore, type PrefilterFacts, type Transition, type UniverseConfig, type UniverseDeps,
} from '../../src/m05/universe.ts';
import { CANDIDATE_TOPIC, m24CandidateStore } from '../../src/m05/store.ts';
import { HeapStore, MemStore } from './mem-store.ts';
import { buildUniverseManifest } from '../../src/m05/manifest.ts';
import { createWatchlist, WATCHLIST_DEFAULTS } from '../../src/m05/watchlist.ts';
import { openDb, type Db } from '../../src/m24/db.ts';
import { prepareDatabase } from '../../src/m24/migrate.ts';
import { createRepos } from '../../src/m24/repos.ts';
import { fakeClock, tempDir } from '../helpers.ts';
import { pubkey, ulid } from '../m24/samples.ts';

const T0 = Date.UTC(2026, 9, 16) as UnixMs;
const SOL = 1_000_000_000n;
/** Test facts; with no `observedAtMs` they are read as current (M04 polling the pool now). */
type Facts = Omit<PrefilterFacts, 'observedAtMs'> & { observedAtMs?: UnixMs };
const deep: Facts = { venue: 'pumpswap', quoteMint: MINTS.wsol, feeTotalBps: 30, effectiveQuoteLamports: 400n * SOL };

function setup(o: { config?: Partial<UniverseConfig>; facts?: (p: string) => Facts | null; store?: CandidateStore; idBase?: number; requestFacts?: (ids: readonly string[]) => void; readsAvailable?: () => boolean } = {}) {
  let now: number = T0;
  let id = o.idBase ?? 0;
  const store = o.store ?? new MemStore();
  const published: Transition[] = [];
  const logs: string[] = [];
  const writtenOff = new Set<string>();
  const deps: UniverseDeps = {
    config: { ...UNIVERSE_DEFAULTS, ...o.config }, store, nowMs: () => now as UnixMs, newId: () => ulid(id++), wsolMint: MINTS.wsol,
    facts: (p) => { const f = (o.facts ?? (() => deep))(p); return f === null ? null : { observedAtMs: now as UnixMs, ...f }; },
    ...(o.requestFacts === undefined ? {} : { requestFacts: o.requestFacts }), ...(o.readsAvailable === undefined ? {} : { readsAvailable: o.readsAvailable }), lists: { isWrittenOff: (m) => writtenOff.has(m), isUnsolicited: () => false },
    publish: (t) => published.push(t), log: { event: (_l, c) => logs.push(c) },
  };
  const u = createUniverse(deps);
  return { u, store, published, logs, writtenOff, advance: (ms: number) => { now += ms; }, at: () => now };
}
/** MR-01's limit set: no latest entry age, so a retry 6 h later is not retired for age (Z09-39). */
const MR = { limitSetId: 'mr01', limits: [MR_LIMITS] } as const;
/** A migration 2 days before T0: old enough for MR-01 (24 h); past PM-01's entry window (Z09-52). */
const OLD = T0 - 2 * 86_400_000;
/** By default a pool is found 30 min after its migration: inside PM-01's window (20-120 min). */
const disc = (i: number, migratedAtMs: number | null = T0 - 1_800_000) => ({ poolId: pubkey(100 + i), baseMint: pubkey(200 + i), quoteMint: MINTS.wsol, venue: 'pumpswap', verifiedOnChain: true, migratedAtMs: migratedAtMs as UnixMs | null });

describe('A-M05-01 acceptance (SYNTHETIC events)', () => {
  it('property: no undefined transition; open_failed or written_off always moves the candidate to cooldown; a written-off mint is blacklisted', () => {
    const ev = fc.oneof(
      fc.record({ k: fc.constant('disc'), i: fc.integer({ min: 0, max: 4 }) }),
      fc.record({ k: fc.constantFrom('watched', 'evicted', 'signal', 'accept', 'reject', 'stale', 'fresh', 'layout', 'quarantine', 'auth', 'tick'), i: fc.integer({ min: 0, max: 4 }) }),
      fc.record({ k: fc.constant('screen'), i: fc.integer({ min: 0, max: 4 }), v: fc.constantFrom('eligible', 'rejected', 'honeypot', 'authority') }),
      fc.record({ k: fc.constant('terminal'), i: fc.integer({ min: 0, max: 4 }), v: fc.constantFrom('closed', 'open_failed', 'written_off') }),
      fc.record({ k: fc.constant('time'), ms: fc.integer({ min: 0, max: 30 * 3_600_000 }) }),
      // Ruling Z09-17: a pool's current facts turn shallow (or deep again), so a tick re-checks it on them.
      fc.record({ k: fc.constant('shallow'), i: fc.integer({ min: 0, max: 4 }) }),
    );
    let eligibleToPrefiltered = 0;
    fc.assert(fc.property(fc.boolean(), fc.array(ev, { maxLength: 80 }), (screening, events) => {
      const shallow = new Set<string>();
      const t = setup({ config: { screeningRequired: screening }, facts: (p) => (shallow.has(p) ? { ...deep, effectiveQuoteLamports: 1n } : deep) });
      for (const e of events as Array<{ k: string; i: number; v?: string; ms?: number }>) {
        const pool = pubkey(100 + (e.i ?? 0)), mint = pubkey(200 + (e.i ?? 0));
        const before = t.u.candidate(pool)?.state;
        switch (e.k) {
          case 'disc': t.u.onDiscovery(disc(e.i)); break;
          case 'watched': t.u.onWatched(pool); break;
          case 'evicted': t.u.onEvicted(pool, 'budget'); break;
          case 'signal': t.u.onSignal(pool); break;
          case 'accept': t.u.onRiskDecision(pool, true); break;
          case 'reject': t.u.onRiskDecision(pool, false); break;
          case 'stale': t.u.onStale(pool, t.at() as UnixMs); break;
          case 'fresh': t.u.onFresh(pool); break;
          case 'layout': t.u.onUnknownLayout(pool); break;
          case 'quarantine': t.u.onQuarantine(pool); break;
          case 'auth': t.u.onAuthorityChanged(mint); break;
          case 'tick': t.u.tick(); break;
          case 'time': t.advance(e.ms as number); t.u.tick(); break;
          case 'shallow': if (!shallow.delete(pool)) shallow.add(pool); break;
          case 'screen': t.u.onScreen(pool, e.v === 'eligible' || e.v === 'rejected' ? { verdict: e.v } : { verdict: 'hard_fail', kind: e.v as 'honeypot' | 'authority' }); break;
          case 'terminal': {
            t.u.onPositionTerminal(pool, e.v as 'closed');
            if (before === 'in_position') {
              const kinds = t.published.filter((x) => x.poolId === pool).map((x) => x.to);
              assert.ok(kinds.includes('cooldown'));
              if (e.v === 'written_off') assert.equal(t.u.candidate(pool)?.state, 'blacklisted');
            }
            break;
          }
        }
      }
      for (const x of (t.store as MemStore).log) assert.ok(isAllowed(x.from, x.to), `${x.from} → ${x.to}`);
      eligibleToPrefiltered += (t.store as MemStore).log.filter((x) => x.from === 'eligible' && x.to === 'prefiltered_out').length;
      assert.deepEqual(t.published, (t.store as MemStore).log);
    }), { numRuns: 300 });
    // The ARCH deviation U7 (DECISIONS Z09-17) is exercised, not only listed.
    assert.ok(eligibleToPrefiltered > 0, 'eligible → prefiltered_out never happened');
  });

  it('a pool with no known migration has no age proof and fails the MR age prefilter (D30 parked); with the migration it passes at 24 h', () => {
    const t = setup({ config: { limitSetId: 'mr01', limits: [MR_LIMITS], screeningRequired: false } });
    t.u.onDiscovery(disc(0, null));
    assert.equal(t.u.candidate(pubkey(100))?.state, 'prefiltered_out');
    assert.ok(t.u.candidate(pubkey(100))?.reasons.includes('mr-01:age=unknown'));
    t.u.onDiscovery(disc(1, T0 - 86_400_000 + 1));
    assert.equal(t.u.candidate(pubkey(101))?.state, 'prefiltered_out');
    t.u.onDiscovery(disc(2, T0 - 86_400_000));
    assert.equal(t.u.candidate(pubkey(102))?.state, 'eligible');
    assert.ok(t.u.candidate(pubkey(102))?.reasons.includes('phase0_unscreened'));
  });

  it('screening_required = false with an enabled strategy is rejected by config validation (C-44)', () => {
    assert.match(checkUniverseConfig({ ...UNIVERSE_DEFAULTS, screeningRequired: false, enabledStrategies: 1 }) as string, /C-44/);
    assert.throws(() => setup({ config: { screeningRequired: false, enabledStrategies: 1 } }));
    assert.equal(checkUniverseConfig({ ...UNIVERSE_DEFAULTS, screeningRequired: false }), null);
  });

  it('Z09-2: the limit set is named explicitly (default pm01) and must match the limits in use', () => {
    assert.equal(UNIVERSE_DEFAULTS.limitSetId, 'pm01');
    assert.deepEqual(UNIVERSE_DEFAULTS.limits, [PM_LIMITS]);
    assert.match(checkUniverseConfig({ ...UNIVERSE_DEFAULTS, limits: [MR_LIMITS] }) as string, /Z09-2/);
    assert.match(checkUniverseConfig({ ...UNIVERSE_DEFAULTS, limitSetId: 'nope' }) as string, /Z09-2/);
    assert.equal(checkUniverseConfig({ ...UNIVERSE_DEFAULTS, limitSetId: 'mr01', limits: LIMIT_SETS.mr01 }), null);
    assert.match(limitSetHash(LIMIT_SETS.pm01), /^[0-9a-f]{64}$/);
    assert.notEqual(limitSetHash(LIMIT_SETS.pm01), limitSetHash(LIMIT_SETS.mr01));
  });
});

describe('A-M05-01 transitions', () => {
  it('Phase 0: PM limits 125 bps / 85 SOL / 20 min; fee, depth, venue and quote mint fail with reasons; re-evaluated after 6 h', () => {
    let f: Facts = { ...deep, feeTotalBps: 126 };
    const t = setup({ config: { screeningRequired: false }, facts: () => f });
    t.u.onDiscovery(disc(0, T0 - 1_200_000));
    const c = t.u.candidate(pubkey(100)) as CandidateRecord;
    assert.equal(c.state, 'prefiltered_out');
    assert.deepEqual(c.reasons, ['pm-01:fee=126bps>125']);
    f = { ...deep, effectiveQuoteLamports: 84n * SOL, venue: 'raydium_cpmm', quoteMint: MINTS.usdc };
    t.u.onDiscovery(disc(1, T0 - 1_199_999));
    assert.deepEqual(t.u.candidate(pubkey(101))?.reasons, ['venue=raydium_cpmm', 'quote_not_wsol', 'pm-01:depth=84SOL<85', 'pm-01:age<1200000ms']);
    f = deep;
    t.advance(21_600_000 - 1); t.u.tick();
    assert.equal(t.u.candidate(pubkey(100))?.state, 'prefiltered_out');
    // 6 h on, PM-01 can never enter it again (pool_age ends at migration + 120 min): retired, no read (Z09-39).
    t.advance(1); t.u.tick();
    assert.equal(t.u.candidate(pubkey(100))?.state, 'prefiltered_out');
    assert.deepEqual([t.u.candidate(pubkey(100))?.retryAtMs, t.u.candidate(pubkey(100))?.reasons[0]], [null, 'retired=past_entry_age']);
    // Under MR-01 (no latest age) the same retry is judged again and passes.
    let g: Facts = { ...deep, feeTotalBps: 31 };
    const m = setup({ config: { screeningRequired: false, ...MR }, facts: () => g });
    m.u.onDiscovery(disc(0, OLD));
    assert.equal(m.u.candidate(pubkey(100))?.state, 'prefiltered_out');
    g = deep;
    m.advance(21_600_000); m.u.tick();
    assert.equal(m.u.candidate(pubkey(100))?.state, 'eligible');
    assert.equal(m.u.candidate(pubkey(100))?.depthLamports, 400n * SOL);
    // A rediscovery of a prefiltered pool re-evaluates it at once; no facts → prefiltered_out (no_snapshot).
    const n = setup({ config: { screeningRequired: false }, facts: () => null });
    n.u.onDiscovery(disc(0));
    assert.deepEqual(n.u.candidate(pubkey(100))?.reasons, ['no_snapshot']);
    n.u.onDiscovery(disc(0), { ...deep, observedAtMs: n.at() as UnixMs });
    assert.equal(n.u.candidate(pubkey(100))?.state, 'eligible');
    // Unverified discoveries and another mint on the same pool are ignored; one candidate per pool.
    n.u.onDiscovery({ ...disc(5, OLD), verifiedOnChain: false });
    assert.equal(n.u.candidate(pubkey(105)), null);
    n.u.onDiscovery({ ...disc(0, OLD), baseMint: pubkey(999) });
    assert.equal(n.u.candidates().length, 1);
  });

  it('Phase 1 path through test doubles: screening → eligible → watched → signalled → in_position → cooldown → watched', () => {
    const t = setup({ config: MR });
    const p = pubkey(100);
    t.u.onDiscovery(disc(0, OLD));
    assert.equal(t.u.candidate(p)?.state, 'screening');
    t.u.onScreen(p, { verdict: 'eligible' });
    t.u.onWatched(p);
    t.u.onSignal(p);
    t.u.onRiskDecision(p, false);
    assert.equal(t.u.candidate(p)?.state, 'watched');
    t.u.onSignal(p);
    t.u.onRiskDecision(p, true);
    t.u.onPositionTerminal(p, 'closed');
    assert.equal(t.u.candidate(p)?.state, 'cooldown');
    assert.equal(t.u.candidate(p)?.cooldownUntilMs, T0 + 1_800_000);
    t.advance(1_800_000); t.u.tick();
    assert.equal(t.u.candidate(p)?.state, 'watched');
    // Stale after more than 30 s; fresh again.
    t.u.onStale(p, t.at() as UnixMs);
    t.advance(30_001); t.u.tick();
    assert.equal(t.u.candidate(p)?.state, 'stale');
    t.u.onFresh(p);
    assert.equal(t.u.candidate(p)?.state, 'watched');
    // Evicted; eligible again only through the prefilter at its retry (Z09-16), then watched.
    t.u.onEvicted(p, 'budget', (t.at() + 30 * 3_600_000) as UnixMs);                // still on its tail at the retry
    assert.equal(t.u.candidate(p)?.state, 'evicted');
    assert.equal(t.u.onWatched(p), false);
    t.advance(21_600_000); t.u.tick();
    assert.equal(t.u.candidate(p)?.state, 'eligible');
    assert.equal(t.u.onWatched(p), true);
    assert.equal(t.u.candidate(p)?.state, 'watched');
    // A re-screen soft fail; retried after 6 h.
    t.u.onScreen(p, { verdict: 'rejected' });
    assert.equal(t.u.candidate(p)?.state, 'rejected');
    t.advance(21_600_000); t.u.tick();
    assert.equal(t.u.candidate(p)?.state, 'screening');
  });

  it('a cooldown whose re-screen fails ends evicted; honeypot is blacklisted 24 h, authority for good; expiry re-runs the prefilter', () => {
    let f: Facts | null = deep;
    // MR-01's set: the blacklist expires a day later, when a PM-01 pool would be past its entry window (Z09-52).
    const t = setup({ config: MR, facts: () => f });
    const [a, b] = [pubkey(100), pubkey(101)];
    for (const i of [0, 1]) t.u.onDiscovery(disc(i, OLD));
    t.u.onScreen(a, { verdict: 'eligible' }); t.u.onWatched(a); t.u.onSignal(a); t.u.onRiskDecision(a, true); t.u.onPositionTerminal(a, 'open_failed');
    f = null;
    t.advance(1_800_000); t.u.tick();
    assert.equal(t.u.candidate(a)?.state, 'evicted');
    f = deep;
    t.u.onScreen(b, { verdict: 'hard_fail', kind: 'honeypot' });
    assert.equal(t.u.candidate(b)?.state, 'blacklisted');
    t.advance(86_400_000 - 1); t.u.tick();
    assert.equal(t.u.candidate(b)?.state, 'blacklisted');
    t.advance(1); t.u.tick();
    assert.equal(t.u.candidate(b)?.state, 'screening');
    t.u.onAuthorityChanged(pubkey(201));
    t.advance(365 * 86_400_000); t.u.tick();
    assert.equal(t.u.candidate(b)?.state, 'blacklisted');
    // A new pool of a blacklisted mint is blacklisted at discovery; a written-off mint never becomes a candidate.
    t.u.onDiscovery({ ...disc(7), baseMint: pubkey(201) });
    assert.equal(t.u.candidate(pubkey(107))?.state, 'blacklisted');
    t.writtenOff.add(pubkey(208));
    t.u.onDiscovery(disc(8));
    assert.equal(t.u.candidate(pubkey(108)), null);
    // An event for an unknown candidate is logged and creates nothing (edge case 2).
    t.u.onPositionTerminal(pubkey(999), 'closed');
    assert.ok(t.logs.includes('m05.unknown_candidate'));
  });

  it('a screening backlog above 100 drops the oldest unscreened candidates with reason backlog', () => {
    const t = setup();
    for (let i = 0; i < 150; i++) { t.u.onDiscovery(disc(i)); t.advance(1); }
    const screening = t.u.candidates().filter((c) => c.state === 'screening');
    assert.equal(screening.length, 100);
    const dropped = Array.from({ length: 150 }, (_, i) => t.u.candidate(pubkey(100 + i)) as CandidateRecord).filter((c) => c.state === 'rejected');
    assert.equal(dropped.length, 50);
    assert.ok(dropped.every((c) => c.reasons[0] === 'backlog'));
    assert.deepEqual(dropped.map((c) => c.poolId).sort(), Array.from({ length: 50 }, (_, i) => pubkey(100 + i)).sort());
  });

  it('a refused write (E_STATE_CHANGED or a database failure) is not applied in memory either', () => {
    const store = new MemStore();
    const t = setup({ store, config: { screeningRequired: false } });
    store.refuse = true;
    t.u.onDiscovery(disc(0));
    assert.equal(t.u.candidate(pubkey(100)), null);
    assert.ok(t.logs.includes('m05.transition_not_applied'));
    store.refuse = false;
    t.u.onDiscovery(disc(0));
    const c = t.u.candidate(pubkey(100)) as CandidateRecord;
    store.rows.set(c.candidateId, { ...c, version: c.version + 5 });                 // someone else moved it
    t.u.onWatched(pubkey(100));
    assert.equal(t.u.candidate(pubkey(100))?.state, 'eligible');
  });

  it('the edge table covers every state; edges from nothing go only to discovered', () => {
    assert.deepEqual([...ALLOWED.keys()].filter((k) => k !== null).sort(), [...STATES].sort());
    assert.deepEqual([...(ALLOWED.get(null) as Set<string>)], ['discovered']);
    for (const s of STATES) if (s !== 'blacklisted') assert.ok(isAllowed(s, 'blacklisted'), s);
    assert.ok(!isAllowed('discovered', 'in_position'));
    assert.equal(PM_LIMITS.minDepthLamports, 85n * SOL);
    for (const c of [{ cooldownMs: -1 }, { prefilterRetryMs: 1 }, { staleToStateMs: 1 }, { screenBacklogMax: 9 }, { limits: [] }, { limits: [{ ...PM_LIMITS, feeCeilingBps: -1 }] }]) {
      assert.notEqual(checkUniverseConfig({ ...UNIVERSE_DEFAULTS, ...c }), null, JSON.stringify(c, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    }
  });
});

describe('A-M05-01 over M24', () => {
  const dir = tempDir('universe');
  let n = 0;
  async function migrated(): Promise<Db> {
    const path = join(dir, `u${n++}.db`);
    const db = openDb({ create: true, path, clock: fakeClock() });
    assert.equal((await prepareDatabase(db, { clock: fakeClock(), backupPath: `${path}.bak` })).ok, true);
    return db;
  }

  it('each transition writes the candidate row, the event row and the outbox event; state and the blacklist survive a restart', async () => {
    const db = await migrated();
    let id = 1_000;
    const store = m24CandidateStore(db, { newId: () => ulid(id++), nowMs: () => T0 });
    const t = setup({ store, config: { screeningRequired: false } });
    t.u.onDiscovery(disc(0));
    t.u.onDiscovery(disc(1));
    t.u.onScreen(pubkey(101), { verdict: 'hard_fail', kind: 'authority' });           // ignored: not screening (Phase 0)
    t.u.blacklist(pubkey(201), 'screen_authority', null);
    t.u.onWatched(pubkey(100));
    const repos = createRepos();
    const r = db.reader();
    assert.deepEqual(repos.candidate_event.find(r, {}, { orderBy: 'at' }).map((e) => `${e.fromState ?? '-'}>${e.toState}`).sort(),
      ['-' + '>discovered', '-' + '>discovered', 'discovered>eligible', 'discovered>eligible', 'eligible>blacklisted', 'eligible>watched'].sort());
    const outbox: string[] = [];
    db.outbox.drain((rows) => { for (const x of rows) outbox.push(x.topic); });
    assert.equal(outbox.length, 6);
    assert.ok(outbox.every((x) => x === CANDIDATE_TOPIC));
    // Restart: a fresh universe on the same database.
    const again = setup({ store: m24CandidateStore(db, { newId: () => ulid(id++), nowMs: () => T0 }), config: { screeningRequired: false }, idBase: 500 });
    assert.equal(again.u.candidate(pubkey(100))?.state, 'watched');
    assert.equal(again.u.candidate(pubkey(100))?.migratedAtMs, T0 - 1_800_000);
    assert.equal(again.u.candidate(pubkey(100))?.depthLamports, (400n * SOL) as Lamports);
    again.advance(400 * 86_400_000); again.u.tick();
    assert.equal(again.u.candidate(pubkey(101))?.state, 'blacklisted');                // permanent, still after restart
    // A second pool of that mint is blacklisted at discovery.
    again.u.onDiscovery({ ...disc(9), baseMint: pubkey(201) });
    assert.equal(again.u.candidate(pubkey(109))?.state, 'blacklisted');
    db.close();
  });
});

describe('Z09 round 2 (red team RT-3 to RT-6; rulings Z09-14 to Z09-18, Z09-20, Z09-22, Z09-23)', () => {
  it('RT-3 / Z09-14: a soft-rejected candidate whose retry fails the prefilter stays rejected with a new persisted retry, logged once per retry', () => {
    let f: Facts | null = deep;
    const store = new MemStore();
    const t = setup({ store, config: MR, facts: () => f });
    t.u.onDiscovery(disc(1, OLD));
    const p = pubkey(101);
    t.u.onScreen(p, { verdict: 'rejected' });
    f = { ...deep, effectiveQuoteLamports: 1n * SOL };
    t.advance(6 * 3_600_000 + 1);
    t.u.tick(); t.u.tick(); t.u.tick();
    assert.equal(t.logs.filter((c) => c === 'm05.transition_refused').length, 0);
    assert.equal(t.logs.filter((c) => c === 'm05.retry_failed').length, 1);
    const c = t.u.candidate(p) as CandidateRecord;
    assert.equal(c.state, 'rejected');
    assert.equal(c.retryAtMs, t.at() + 21_600_000);
    assert.equal(store.get(p)?.retryAtMs, t.at() + 21_600_000);                       // persisted
    f = deep;
    t.advance(21_600_000); t.u.tick();
    assert.equal(t.u.candidate(p)?.state, 'screening');
  });

  it('Z09-20: a prefiltered_out retry that fails again is persisted and survives a restart', () => {
    const store = new MemStore();
    const t = setup({ store, config: MR, facts: () => ({ ...deep, feeTotalBps: 500 }) });
    t.u.onDiscovery(disc(1, OLD));
    t.advance(21_600_000); t.u.tick();
    const due = (store.get(pubkey(101)) as CandidateRecord).retryAtMs;
    assert.equal(due, t.at() + 21_600_000);
    assert.equal(store.get(pubkey(101))?.failedRetries, 1);                          // persisted (Z09-39)
    const t2 = setup({ store, idBase: 900, config: MR, facts: () => ({ ...deep, feeTotalBps: 500 }) });
    t2.advance(t.at() - T0 + 21_600_000 - 1); t2.u.tick();
    assert.equal(t2.logs.filter((c) => c === 'm05.retry_failed').length, 0);         // not due yet after the restart
  });

  it('RT-4 / Z09-15: a permanent blacklist on top of a timed one survives a restart; a shorter one never shortens it', () => {
    const store = new MemStore();
    const t = setup({ store });
    t.u.onDiscovery(disc(1));
    const p = pubkey(101), m = pubkey(201);
    t.u.onScreen(p, { verdict: 'hard_fail', kind: 'honeypot' });                    // 24 h
    t.u.onAuthorityChanged(m);                                                      // permanent
    t.u.blacklist(m, 'screen_honeypot', (T0 + 3_600_000) as UnixMs);                 // shorter: ignored
    assert.deepEqual(store.blacklist.get(m), { mint: m, untilMs: null, reason: 'authority_changed' });
    const t2 = setup({ store, idBase: 1_000 });                                      // restart
    t2.advance(25 * 3_600_000); t2.u.tick();
    assert.equal(t2.u.candidate(p)?.state, 'blacklisted');
    // An expired timed entry is replaced by a new timed one.
    t2.u.blacklist(pubkey(999), 'x', (T0 + 1) as UnixMs);
    t2.u.blacklist(pubkey(999), 'y', (T0 + 30 * 3_600_000) as UnixMs);
    assert.equal(store.blacklist.get(pubkey(999))?.reason, 'y');
  });

  it('RT-5 / Z09-16: a pool evicted after a failed cooldown re-screen is never watched again without passing the prefilter', () => {
    let f: Facts | null = deep;
    const t = setup({ config: { screeningRequired: false, ...MR }, facts: () => f });
    t.u.onDiscovery(disc(1, OLD));
    const p = pubkey(101);
    const w = createWatchlist({ restoreTails: () => [], config: WATCHLIST_DEFAULTS, nowMs: () => t.at() as UnixMs, maxHoldMs: () => 0, mode: () => 'normal',
      tracker: { watch: () => true, unwatch: () => {} }, universe: t.u, onEviction: () => {}, log: { event: () => {} } });
    w.recompute(t.u.candidates());
    t.u.onSignal(p); t.u.onRiskDecision(p, true); t.u.onPositionTerminal(p, 'closed');
    f = { ...deep, feeTotalBps: 500 };
    t.advance(1_800_001); t.u.tick();
    assert.equal(t.u.candidate(p)?.state, 'evicted');
    w.recompute([...t.u.candidates(), t.u.candidate(p) as CandidateRecord]);
    assert.equal(t.u.candidate(p)?.state, 'evicted');
    t.advance(21_600_000); t.u.tick();
    assert.equal(t.u.candidate(p)?.state, 'evicted');                               // its retry: past its tail, retired (Z09-39)
    assert.equal(t.u.candidate(p)?.reasons[0], 'retired=past_tail');
    f = deep;
    t.advance(21_600_000); t.u.tick();
    w.recompute(t.u.candidates());
    assert.equal(t.u.candidate(p)?.state, 'evicted', 'a retired pool waits for a new discovery');
    t.u.onDiscovery(disc(1, OLD));                                                        // only a new discovery brings it back, through the prefilter
    w.recompute(t.u.candidates());
    assert.equal(t.u.candidate(p)?.state, 'watched');
  });

  it('Z09-17: depth comes from the current facts; a watched pool below its set minimum leaves (rejected), an eligible one is prefiltered out', () => {
    let depth = 400n * SOL;
    const t = setup({ config: { screeningRequired: false }, facts: () => ({ ...deep, effectiveQuoteLamports: depth }) });
    t.u.onDiscovery(disc(1)); t.u.onDiscovery(disc(2));
    t.u.onWatched(pubkey(101));
    depth = 84n * SOL;
    t.u.tick();
    assert.equal(t.u.candidate(pubkey(101))?.state, 'rejected');
    assert.equal(t.u.candidate(pubkey(102))?.state, 'prefiltered_out');
    // The watchlist ranks on M04's current depth, not on the depth stored at the last prefilter.
    const order: string[] = [];
    const w = createWatchlist({ restoreTails: () => [], config: { ...WATCHLIST_DEFAULTS, maxWatched: 1 }, nowMs: () => t.at() as UnixMs, maxHoldMs: () => 0, mode: () => 'normal',
      tracker: { watch: (id) => { order.push(id); return true; }, unwatch: () => {} }, universe: { onWatched: () => true, onEvicted: () => {}, candidate: () => null, pastEntryAge: () => false },
      depthOf: (id) => (id === 'p-shallow-then-deep' ? 900n * SOL : 10n * SOL), onEviction: () => {}, log: { event: () => {} } });
    const r = (id: string, d: bigint): CandidateRecord => ({ ...(t.u.candidate(pubkey(101)) as CandidateRecord), poolId: id, state: 'eligible', depthLamports: d });
    w.recompute([r('p-deep-then-shallow', 900n * SOL), r('p-shallow-then-deep', 1n * SOL)]);
    assert.deepEqual(order, ['p-shallow-then-deep']);
  });

  it('RT-6 / Z09-18: a pool evicted for budget is not eligible in later manifests: only until its tail ends', () => {
    const P = pubkey(1), M = pubkey(2);
    const ev = [
      { poolId: P, mint: M, from: 'discovered' as const, to: 'eligible' as const, reason: 'set=pm-01;phase0_unscreened', atMs: T0 },
      { poolId: P, mint: M, from: 'eligible' as const, to: 'watched' as const, reason: 'slot', atMs: T0 + 1 },
      { poolId: P, mint: M, from: 'watched' as const, to: 'evicted' as const, reason: tailReason('budget', T0 + 3_600_000), atMs: T0 + 2 },
    ];
    const day = (d: string, events = ev) => buildUniverseManifest({ dayUtc: d, events, crossCheck: { poolsOnlyInVendor: 0, otherDexPairs: 0, knownPoolsUnderOtherDex: 0, status: 'ok' },
      migrationCoverage: { chainMigrations: 0, seenByPumpPortal: 0, gapBps: 0 }, limitSet: { id: 'pm01', paramHash: 'x' }, generatedAtMs: 0, late: false, prefilterOnly: true });
    assert.equal(day('2026-11-30').a24.eligibleCount, 0);
    const today = day('2026-10-16');
    assert.deepEqual(today.eligible[0]?.intervals, [[T0, T0 + 3_600_000]]);
    assert.deepEqual(today.evicted, [{ poolId: P, atMs: T0 + 2, reason: 'budget', tailUntilMs: T0 + 3_600_000 }]);
    // No tail: eligibility ends at the eviction.
    const noTail = day('2026-10-16', [...ev.slice(0, 2), { ...ev[2] as (typeof ev)[number], reason: 'degraded' }]);
    assert.deepEqual(noTail.eligible[0]?.intervals, [[T0, T0 + 2]]);
  });

  it('Z09-22: a tail cut is joined by pool and its eviction, on a live clock with a transaction in between', () => {
    let now = T0 + 7;
    const store = new MemStore();
    let id = 0;
    const u = createUniverse({ config: { ...UNIVERSE_DEFAULTS, screeningRequired: false }, store, nowMs: () => now as UnixMs, newId: () => ulid(id++), wsolMint: MINTS.wsol,
      facts: () => ({ ...deep, observedAtMs: now as UnixMs }), lists: { isWrittenOff: () => false, isUnsolicited: () => false }, publish: () => {}, log: { event: () => {} } });
    const cuts: Array<{ poolId: string; atMs: number; reason: string; tailUntilMs: number | null }> = [];
    const w = createWatchlist({ restoreTails: () => [], config: { ...WATCHLIST_DEFAULTS, maxWatched: 1, tailMaxPools: 1 }, nowMs: () => now as UnixMs, maxHoldMs: () => 0, mode: () => 'normal',
      tracker: { watch: () => true, unwatch: () => {} }, universe: u, onEviction: (e) => cuts.push(e), log: { event: () => {} } });
    for (const i of [1, 2]) u.onDiscovery(disc(i));
    w.recompute(u.candidates());                                                    // pool 101 or 102 watched
    now += 13;
    const w0 = createWatchlist({ restoreTails: () => [], config: { ...WATCHLIST_DEFAULTS, maxWatched: 1, tailMaxPools: 1 }, nowMs: () => now as UnixMs, maxHoldMs: () => 0, mode: () => 'normal',
      tracker: { watch: () => true, unwatch: () => {} }, universe: u, onEviction: (e) => cuts.push(e), log: { event: () => {} } });
    // Two evictions on a moving clock: the second tail start ends the first tail (capacity 1), a millisecond later.
    const watchedNow = u.candidates().filter((c) => c.state === 'watched');
    for (const c of watchedNow) u.onEvicted(c.poolId, 'budget', (now + 3_600_000) as UnixMs);
    now += 1;
    u.onDiscovery(disc(3));                                                         // a transaction in between
    w0.recompute(u.candidates());
    const capacity = { poolId: (watchedNow[0] as CandidateRecord).poolId, atMs: now + 5, reason: 'tail_capacity', tailUntilMs: null };
    const m = buildUniverseManifest({ dayUtc: '2026-10-16', events: store.log.map((x) => ({ ...x })), watchlistEvictions: [...cuts, capacity],
      crossCheck: { poolsOnlyInVendor: 0, otherDexPairs: 0, knownPoolsUnderOtherDex: 0, status: 'ok' }, migrationCoverage: { chainMigrations: 0, seenByPumpPortal: 0, gapBps: 0 },
      limitSet: { id: 'pm01', paramHash: 'x' }, generatedAtMs: 0, late: false, prefilterOnly: true });
    const ev = m.eligible.find((e) => e.poolId === capacity.poolId);
    assert.equal(ev?.lastEligibleAtMs, capacity.atMs);                               // cut by its own tail record, not an exact-ms match
  });

  it('Z09-23: memory holds active candidates only; tick work is bounded by active plus due', () => {
    const store = new MemStore();
    const t = setup({ store, facts: () => ({ ...deep, feeTotalBps: 500 }) });
    for (let i = 0; i < 5_000; i++) t.u.onDiscovery(disc(i));
    assert.equal(t.u.candidates().length, 0);                                        // every one is prefiltered_out (in the store)
    assert.equal(store.rows.size, 5_000);
    const reads: number[] = [];
    const due = store.due.bind(store);
    store.due = (n, limit) => { const r = due(n, limit); reads.push(r.length); return r; };
    t.u.tick();
    assert.deepEqual(reads, [0]);                                                    // nothing due
    t.advance(21_600_000); t.u.tick();
    assert.deepEqual(reads, [0, 1_000]);                                             // one batch per tick, at most DUE_BATCH
  });
});

describe('Z09 round 3 (red team RT-8 and RT-9; rulings Z09-33, Z09-34, Z09-38)', () => {
  /** A universe and a watchlist over it, with the tracker's classes and the eviction records. */
  function rig(o: { facts?: (p: string) => Facts | null; requestFacts?: (ids: readonly string[]) => void; config?: Partial<UniverseConfig> } = {}) {
    const t = setup({ config: { screeningRequired: false, ...o.config }, ...(o.facts === undefined ? {} : { facts: o.facts }), ...(o.requestFacts === undefined ? {} : { requestFacts: o.requestFacts }) });
    const classes = new Map<string, string>();
    const evictions: Array<{ poolId: string; reason: string; tailUntilMs: number | null }> = [];
    const w = createWatchlist({ restoreTails: () => [], config: WATCHLIST_DEFAULTS, nowMs: () => t.at() as UnixMs, maxHoldMs: () => 0, mode: () => 'normal',
      tracker: { watch: (id, c) => { classes.set(id, c); return true; }, unwatch: (id) => { classes.delete(id); } }, universe: t.u,
      onEviction: (e) => evictions.push(e), log: { event: () => {} } });
    return { ...t, w, classes, evictions };
  }

  it('Z09-33 (RT-8): a watched pool that drains below its limits keeps a tail and an eviction record (prefilter_recheck)', () => {
    let depth = 400n * SOL;
    const t = rig({ facts: () => ({ ...deep, effectiveQuoteLamports: depth }) });
    t.u.onDiscovery(disc(1));
    const p = pubkey(101);
    t.w.recompute(t.u.candidates());
    assert.equal(t.u.candidate(p)?.state, 'watched');
    depth = 5n * SOL;                                                                // the pool is drained (a rug)
    t.u.tick();
    t.w.recompute(t.u.candidates());
    assert.equal(t.u.candidate(p)?.state, 'rejected');
    assert.equal(t.classes.get(p), 'tail', 'the aftermath is still recorded');
    assert.deepEqual(t.evictions, [{ poolId: p, atMs: t.at(), reason: 'prefilter_recheck', tailUntilMs: t.at() + 3_600_000 }]);
  });

  it('Z09-33: a blacklisted watched pool and a failed cooldown re-screen also leave through the tail', () => {
    let fee = 30;
    const t = rig({ facts: () => ({ ...deep, feeTotalBps: fee }) });
    t.u.onDiscovery(disc(1));
    t.u.onDiscovery(disc(2));
    t.w.recompute(t.u.candidates());
    t.u.onAuthorityChanged(pubkey(201));
    t.w.recompute(t.u.candidates());
    // Pool 2 trades, then fails its cooldown re-screen.
    const p2 = pubkey(102);
    t.u.onSignal(p2); t.u.onRiskDecision(p2, true); t.w.recompute(t.u.candidates());
    t.u.onPositionTerminal(p2, 'closed');
    fee = 500;
    t.advance(1_800_001); t.u.tick();
    assert.equal(t.u.candidate(p2)?.state, 'evicted');
    t.w.recompute(t.u.candidates());
    assert.deepEqual(t.evictions.map((e) => [e.poolId, e.reason]), [[pubkey(101), 'blacklisted'], [p2, 'cooldown_rescreen_failed']]);
    assert.deepEqual([t.classes.get(pubkey(101)), t.classes.get(p2)], ['tail', 'tail']);
  });

  it('Z09-34 (RT-9): an eligible pool that never gets a slot is not judged on 30-day-old facts', () => {
    // MR-01's set (no latest entry age), so the facts' age is what decides.
    const t = setup({ config: { screeningRequired: false, ...MR }, facts: () => ({ ...deep, observedAtMs: T0 }) });   // never polled again
    t.u.onDiscovery(disc(1, OLD));
    assert.equal(t.u.candidate(pubkey(101))?.state, 'eligible');
    t.advance(30 * 86_400_000);
    t.u.tick();
    assert.equal(t.u.candidate(pubkey(101))?.state, 'prefiltered_out');
    assert.deepEqual(t.u.candidate(pubkey(101))?.reasons, ['facts_stale']);
    assert.equal(t.u.candidate(pubkey(101))?.retryAtMs, t.at() + UNIVERSE_DEFAULTS.prefilterRetryMs);
    // Under PM-01 the same pool is past every entry age first: retired from the queue (Z09-43), no retry.
    const pm = setup({ config: { screeningRequired: false }, facts: () => ({ ...deep, observedAtMs: T0 }) });
    pm.u.onDiscovery(disc(1, OLD));
    pm.advance(30 * 86_400_000); pm.u.tick();
    assert.deepEqual([pm.u.candidate(pubkey(101))?.state, pm.u.candidate(pubkey(101))?.reasons, pm.u.candidate(pubkey(101))?.retryAtMs], ['prefiltered_out', ['retired=past_entry_age'], null]);
    // No facts at all: the same, and a slot is never granted on stale facts.
    const n = setup({ config: { screeningRequired: false }, facts: () => null });
    n.u.onDiscovery(disc(2), { ...deep, observedAtMs: T0 });
    assert.equal(n.u.candidate(pubkey(102))?.state, 'eligible');
    assert.equal(n.u.onWatched(pubkey(102)), false);
    assert.deepEqual([n.u.candidate(pubkey(102))?.state, n.u.candidate(pubkey(102))?.reasons], ['prefiltered_out', ['no_snapshot']]);
  });

  it('Z09-34: a due retry on stale facts asks for one fresh read (capped per tick), then judges the fresh facts; no read is a failed retry', () => {
    const reads: string[][] = [];
    let freshFor = new Set<string>();
    const t = setup({ config: { screeningRequired: false, factsRefreshMax: 2, ...MR }, requestFacts: (ids) => reads.push([...ids]),
      facts: (p) => (freshFor.has(p) ? deep : { ...deep, observedAtMs: T0 }) });
    for (const i of [1, 2, 3]) { freshFor.add(pubkey(100 + i)); t.u.onDiscovery(disc(i, OLD)); t.u.onWatched(pubkey(100 + i)); t.u.onEvicted(pubkey(100 + i), 'budget', (T0 + 30 * 3_600_000) as UnixMs); }
    freshFor = new Set();
    t.advance(UNIVERSE_DEFAULTS.prefilterRetryMs);
    t.u.tick();
    assert.deepEqual(reads, [[pubkey(101), pubkey(102)]], 'one batch, at most factsRefreshMax');
    t.u.tick();
    assert.equal(reads.length, 1, 'one flush a minute (Z09-46): the third waits');
    // Pool 1's read arrives; pool 2's does not. A minute on, the third is asked.
    freshFor.add(pubkey(101));
    t.advance(60_000);
    t.u.tick();
    assert.deepEqual(reads, [[pubkey(101), pubkey(102)], [pubkey(103)]]);
    assert.equal(t.u.candidate(pubkey(101))?.state, 'eligible');
    assert.equal(t.u.candidate(pubkey(102))?.state, 'evicted', 'an evicted pool on stale facts stays put');
    assert.deepEqual(t.u.candidate(pubkey(102))?.reasons, ['facts_stale']);
    assert.equal(t.u.candidate(pubkey(102))?.retryAtMs, t.at() + UNIVERSE_DEFAULTS.prefilterRetryMs);
    t.advance(60_000); t.u.tick();
    assert.equal(reads.length, 2, 'no second read for the same retry');
    // Without the port, a stale retry simply fails.
    const q = setup({ config: { screeningRequired: false, ...MR }, facts: (p) => (p === pubkey(104) && q.at() === T0 ? deep : { ...deep, observedAtMs: T0 }) });
    q.u.onDiscovery(disc(4, OLD)); q.u.onWatched(pubkey(104)); q.u.onEvicted(pubkey(104), 'budget', (T0 + 30 * 3_600_000) as UnixMs);
    q.advance(UNIVERSE_DEFAULTS.prefilterRetryMs); q.u.tick();
    assert.deepEqual([q.u.candidate(pubkey(104))?.state, q.u.candidate(pubkey(104))?.reasons], ['evicted', ['facts_stale']]);
  });

  it('Z09-34: staleness comes from the facts\' own time, so a restart does not reset it', () => {
    const store = new MemStore();
    const t = setup({ store, config: { screeningRequired: false }, facts: () => ({ ...deep, observedAtMs: T0 }) });
    t.u.onDiscovery(disc(1));
    t.u.onWatched(pubkey(101));
    t.advance(20_000); t.u.tick();
    assert.equal(t.u.candidate(pubkey(101))?.state, 'watched');
    // Restart 11 s later: no stale event was ever received, but the data is 31 s old.
    const t2 = setup({ store, idBase: 500, config: { screeningRequired: false }, facts: () => ({ ...deep, observedAtMs: T0 }) });
    t2.advance(31_000); t2.u.tick();
    assert.equal(t2.u.candidate(pubkey(101))?.state, 'stale');
    assert.ok(checkUniverseConfig({ ...UNIVERSE_DEFAULTS, factsMaxAgeMs: 29_999 }) !== null);
    assert.ok(checkUniverseConfig({ ...UNIVERSE_DEFAULTS, factsRefreshMax: 91 }) !== null);
  });

  it('Z09-38: a blacklist write that fails is logged as E_WRITE and never throws out of a handler', () => {
    const store = new MemStore();
    store.failBlacklist = true;
    const t = setup({ store });
    t.u.onDiscovery(disc(1));
    assert.doesNotThrow(() => t.u.onScreen(pubkey(101), { verdict: 'hard_fail', kind: 'authority' }));
    assert.equal(t.u.candidate(pubkey(101))?.state, 'blacklisted');
    assert.ok(t.logs.includes('m05.blacklist_not_saved'));
    // A put that throws is caught the same way.
    const throwing = new MemStore();
    throwing.blacklist.put = () => { throw new Error('disk'); };
    const u = setup({ store: throwing });
    u.u.onDiscovery(disc(2));
    assert.doesNotThrow(() => u.u.onAuthorityChanged(pubkey(202)));
    assert.equal(u.u.candidate(pubkey(102))?.state, 'blacklisted');
    assert.ok(u.logs.includes('m05.blacklist_not_saved'));
  });
});

describe('Z09-39: the fresh-read budget is bounded per hour, and pools that cannot pass read nothing', () => {
  const H = 3_600_000;
  /** The most reads in any 60 minutes. */
  const worstHour = (times: readonly number[]): number => {
    let best = 0;
    for (let i = 0, j = 0; j < times.length; j++) {
      while ((times[j] as number) - (times[i] as number) >= H) i++;
      best = Math.max(best, j - i + 1);
    }
    return best;
  };
  function run(o: { n: number; config: Partial<UniverseConfig>; migratedAtMs: number; hours: number; stepMs: number; activePool?: boolean }) {
    const store = new HeapStore();
    const W = pubkey(99_999);
    const t = setup({ store, config: { screeningRequired: false, ...o.config },
      facts: (p) => (p === W ? deep : { ...deep, feeTotalBps: 500, observedAtMs: T0 }),     // never polled again; fails anyway
      requestFacts: (ids) => { calls.push(t.at()); for (const id of ids) { times.push(t.at()); perPool.set(id, (perPool.get(id) ?? 0) + 1); } } });
    const times: number[] = [];
    const calls: number[] = [];
    const perPool = new Map<string, number>();
    for (let i = 0; i < o.n; i++) t.u.onDiscovery(disc(i, o.migratedAtMs));
    if (o.activePool === true) { t.u.onDiscovery({ ...disc(0), poolId: W, baseMint: pubkey(88_888) }); t.u.onWatched(W); }
    for (let at = 0; at < o.hours * H; at += o.stepMs) {
      t.advance(o.stepMs);
      if (o.activePool === true) t.u.onStale(W, t.at() as UnixMs);                 // a stale event every step
      t.u.tick();
    }
    return { t, store, times, perPool, calls };
  }

  it('10,000 inactive pools over 24 h, a tick and an onStale every second: reads per hour never pass the ceiling', { timeout: 120_000 }, () => {
    const r = run({ n: 10_000, config: MR, migratedAtMs: T0 - 2 * 86_400_000, hours: 24, stepMs: 1_000, activePool: true });
    const worst = worstHour(r.times);
    assert.ok(worst <= UNIVERSE_DEFAULTS.factsRefreshPerHour, `worst-case reads in an hour: ${worst}`);
    assert.ok(worstHour(r.calls) <= 60, `worst-case requestFacts calls in an hour: ${worstHour(r.calls)}`);   // Z09-46
    assert.equal(worst, 300, 'the ceiling is reached while the backlog lasts (worst case reported in DECISIONS)');
    assert.ok(Math.max(...r.perPool.values()) <= UNIVERSE_DEFAULTS.retireAfterFailedRetries);
    // From the first retries at 6 h to the end at 24 h: 300 in each rolling hour (5,430 with the batch on the last edge).
    assert.ok(r.times.length >= 18 * 300 && r.times.length <= 19 * 300, `${r.times.length} reads`);
    assert.equal(r.times[0], T0 + 6 * H);
  });

  it('a pool is retired after k failed retries, then reads nothing; a new discovery brings it back', () => {
    const r = run({ n: 50, config: MR, migratedAtMs: T0 - 2 * 86_400_000, hours: 48, stepMs: 60_000 });
    assert.deepEqual([...new Set(r.perPool.values())], [3], 'each pool read once per retry, 3 times');
    assert.ok(r.times.every((x) => x < T0 + 19 * H), 'nothing read after the third failed retry (18 h)');
    for (let i = 0; i < 50; i++) {
      const c = r.t.u.candidate(pubkey(100 + i)) as CandidateRecord;
      assert.deepEqual([c.state, c.retryAtMs, c.reasons[0]], ['prefiltered_out', null, 'retired=failed_retries']);
    }
    r.t.u.onDiscovery(disc(0, OLD));
    const back = r.t.u.candidate(pubkey(100)) as CandidateRecord;
    assert.deepEqual([back.retryAtMs, back.failedRetries], [r.t.at() + UNIVERSE_DEFAULTS.prefilterRetryMs, 1]);   // judged again: a new retry
  });

  it('PM-01 pools past migration + 120 min, and pools with no migration time, are retired with zero reads', () => {
    const pm = run({ n: 1_000, config: {}, migratedAtMs: T0 - 1_800_000, hours: 24, stepMs: 60_000 });
    assert.equal(pm.times.length, 0);
    assert.equal(pm.t.u.candidate(pubkey(100))?.reasons[0], 'retired=past_entry_age');
    const unknown = run({ n: 10, config: MR, migratedAtMs: null as never, hours: 12, stepMs: 60_000 });
    assert.equal(unknown.times.length, 0);
    assert.equal(unknown.t.u.candidate(pubkey(100))?.reasons[0], 'retired=age_unknown');
    assert.ok(checkUniverseConfig({ ...UNIVERSE_DEFAULTS, factsRefreshPerHour: 3_601 }) !== null);
    assert.ok(checkUniverseConfig({ ...UNIVERSE_DEFAULTS, retireAfterFailedRetries: 0 }) !== null);
  });
});

describe('Z09-39 with the red team\'s RT-11 repro', () => {
  it('300 dead pools (drained to 1 SOL) over 30 days, one tick a minute: far below 10 reads each (they are retired)', () => {
    const asked: string[][] = [];
    const t = setup({ config: { screeningRequired: false }, requestFacts: (ps) => asked.push([...ps]),
      facts: () => ({ ...deep, effectiveQuoteLamports: 1n * SOL, observedAtMs: (t.at() - 3_600_000) as UnixMs }) });
    for (let i = 0; i < 300; i++) t.u.onDiscovery(disc(i));
    for (let k = 0; k < 30 * 24 * 60; k++) { t.advance(60_000); t.u.tick(); }
    const reads = asked.reduce((a, x) => a + x.length, 0);
    assert.ok(reads < 300 * 10, `${reads} pool reads in 30 days (${asked.length} calls)`);
    assert.equal(reads, 0, 'PM-01 pools 2 days past migration are past every entry age: retired with no read');
  });
});

describe('Z09-43: a pool too young for PM-01 is retried at its minimum age, not after 6 h; Z09-44: reads pause off the primary', () => {
  const MIN = 60_000;
  it('discovered 1 min after migration: prefiltered_out until migration + 20 min, then eligible', () => {
    const t = setup({ config: { screeningRequired: false } });
    t.u.onDiscovery(disc(1, T0 - MIN));
    const c = t.u.candidate(pubkey(101)) as CandidateRecord;
    assert.deepEqual([c.state, c.retryAtMs, c.reasons], ['prefiltered_out', T0 - MIN + 1_200_000, ['pm-01:age<1200000ms']]);
    t.advance(19 * MIN - 1); t.u.tick();
    assert.equal(t.u.candidate(pubkey(101))?.state, 'prefiltered_out');
    t.advance(1); t.u.tick();
    assert.equal(t.u.candidate(pubkey(101))?.state, 'eligible');
    assert.equal(t.u.candidate(pubkey(101))?.failedRetries ?? 0, 0, 'an age wait is not a failed retry');
    // A pool that also fails on something else keeps the 6 h retry.
    t.u.onDiscovery({ ...disc(2, t.at() - MIN), venue: 'raydium_cpmm' }, { ...deep, venue: 'raydium_cpmm', observedAtMs: t.at() as UnixMs });
    assert.equal(t.u.candidate(pubkey(102))?.retryAtMs, t.at() + UNIVERSE_DEFAULTS.prefilterRetryMs);
  });

  it('the reviewer\'s repro: migration at T0 − 60 s, a tick every minute for 8 h, with the verification read only: it reaches eligible', () => {
    const asked: string[][] = [];
    let read = new Map<string, number>();
    const askedAt: number[] = [];
    const t = setup({ config: { screeningRequired: false }, requestFacts: (ids) => { asked.push([...ids]); askedAt.push(t.at()); for (const id of ids) read.set(id, t.at()); },
      facts: (p) => ({ ...deep, observedAtMs: (read.get(p) ?? T0) as UnixMs }) });
    t.u.onDiscovery(disc(1, T0 - MIN));
    const states: string[] = [];
    for (let k = 0; k < 8 * 60; k++) { t.advance(MIN); t.u.tick(); states.push(t.u.candidate(pubkey(101))?.state as string); }
    assert.ok(states.includes('eligible'), `states: ${[...new Set(states)].join(', ')}`);
    assert.equal(states.indexOf('eligible'), 19, 'eligible at migration + 21 min: the age-due retry asks one read, judged a minute later');
    assert.deepEqual(asked[0], [pubkey(101)]);
    // Z09-51: unwatched, it is read again whenever its facts go stale, until no strategy can enter it (+ 120 min).
    assert.ok(asked.every((x) => x.length === 1 && x[0] === pubkey(101)));
    assert.ok(askedAt.every((x) => x < T0 - MIN + 7_200_000), 'no read after migration + 120 min');
    assert.ok(asked.length <= 25, `${asked.length} reads`);
    read = new Map();
  });

  it('a scripted day of fresh migrations (each found 1 min after): the manifest\'s A-24 count is above 0', () => {
    const store = new MemStore();
    const t = setup({ store, config: { screeningRequired: false } });
    const w = createWatchlist({ restoreTails: () => [], config: WATCHLIST_DEFAULTS, nowMs: () => t.at() as UnixMs, maxHoldMs: () => 0, mode: () => 'normal',
      tracker: { watch: () => true, unwatch: () => {} }, universe: t.u, onEviction: () => {}, log: { event: () => {} } });
    for (let m = 0; m < 24 * 60; m++) {
      if (m % 60 === 1) t.u.onDiscovery(disc(m, t.at() - MIN));
      t.u.tick();
      w.recompute(t.u.candidates());
      t.advance(MIN);
    }
    const m = buildUniverseManifest({ dayUtc: '2026-10-16', events: store.log.map((x) => ({ poolId: x.poolId, mint: x.mint, from: x.from, to: x.to, reason: x.reason, atMs: x.atMs })),
      crossCheck: { poolsOnlyInVendor: 0, otherDexPairs: 0, knownPoolsUnderOtherDex: 0, status: 'ok' }, migrationCoverage: { chainMigrations: 24, seenByPumpPortal: 24, gapBps: 0 },
      limitSet: { id: 'pm01', paramHash: 'x' }, generatedAtMs: T0 + 86_400_000, late: false, prefilterOnly: true });
    assert.equal(m.a24.eligibleCount, 24);
  });

  it('Z09-44: while P4 has no unmetered primary, nothing is asked and nothing fails; it resumes when the primary is back', () => {
    let primary = true;
    const asked: string[][] = [];
    const t = setup({ config: { screeningRequired: false, ...MR }, requestFacts: (ids) => asked.push([...ids]), readsAvailable: () => primary,
      facts: (p) => (p === pubkey(101) && t.at() === T0 ? deep : { ...deep, observedAtMs: T0 }) });
    t.u.onDiscovery(disc(1, OLD)); t.u.onWatched(pubkey(101)); t.u.onEvicted(pubkey(101), 'budget', (T0 + 30 * 3_600_000) as UnixMs);
    t.advance(UNIVERSE_DEFAULTS.prefilterRetryMs); t.u.tick();
    assert.deepEqual(asked, [[pubkey(101)]]);
    primary = false;                                                                 // the read cannot be served
    for (let k = 0; k < 120; k++) { t.advance(60_000); t.u.tick(); }
    assert.equal(asked.length, 1, 'nothing asked while paused');
    const c = t.u.candidate(pubkey(101)) as CandidateRecord;
    assert.deepEqual([c.state, c.failedRetries ?? 0, c.reasons[0] === 'facts_requested'], ['evicted', 0, false]);
    primary = true;
    t.advance(60_000); t.u.tick();
    assert.deepEqual(asked, [[pubkey(101)], [pubkey(101)]], 'asked again once the primary is back');
  });
});

describe('Z09-45 (RT-14) and Z09-46: the read window survives restarts; at most one flush a minute', () => {
  const MIN = 60_000;
  /** The red team's rig: 200 pools of a set with no latest entry age, all due at once on stale facts. */
  function rt14(store: CandidateStore, config: Partial<UniverseConfig> = {}, pools = 200) {
    const asked: string[][] = [];
    let now: number = T0;
    let id = 0;
    const mk = () => createUniverse({ config: { ...UNIVERSE_DEFAULTS, screeningRequired: false, ...MR, factsRefreshPerHour: 30, factsRefreshMax: 30, ...config }, store,
      nowMs: () => now as UnixMs, newId: () => ulid(id++), wsolMint: MINTS.wsol,
      facts: () => ({ ...deep, observedAtMs: T0 as UnixMs }), requestFacts: (ps) => asked.push([...ps]),
      lists: { isWrittenOff: () => false, isUnsolicited: () => false }, publish: () => {}, log: { event: () => {} } });
    const u = mk();
    for (let i = 0; i < pools; i++) u.onDiscovery({ ...disc(i, OLD), poolId: pubkey(10_000 + i), baseMint: pubkey(50_000 + i) }, { ...deep, feeTotalBps: 500, observedAtMs: T0 as UnixMs });
    return { mk, asked, advance: (ms: number) => { now += ms; }, at: () => now };
  }

  it('the red team\'s repro: two restarts in the same hour still read at most the ceiling', () => {
    const t = rt14(new MemStore());
    t.advance(6 * 3_600_000 + 1);
    let u = t.mk(); u.tick();
    u = t.mk(); u.tick();                                                            // restart within the same hour
    u = t.mk(); u.tick();
    const n = t.asked.flat().length;
    assert.ok(n > 0 && n <= 30, `${n} pools read in one hour across 2 restarts, ceiling 30`);
  });

  it('a crash loop (a restart every 10 s for an hour) does not multiply reads or calls', () => {
    const t = rt14(new MemStore(), { factsRefreshPerHour: 300 }, 2_000);           // far more due pools than the ceiling
    t.advance(6 * 3_600_000 + 1);
    for (let k = 0; k < 360; k++) { t.mk().tick(); t.advance(10_000); }
    assert.equal(t.asked.flat().length, 300, `${t.asked.flat().length} pools`);
    assert.ok(t.asked.length <= 60, `${t.asked.length} requestFacts calls in an hour`);
  });

  it('a window that cannot be saved asks nothing; the M24 store keeps the window across a restart', async () => {
    const store = new MemStore();
    store.failWindow = true;
    const t = rt14(store);
    t.advance(6 * 3_600_000 + 1);
    t.mk().tick();
    assert.equal(t.asked.length, 0);
    const path = join(tempDir('window'), 'w.db');
    const db = openDb({ create: true, path, clock: fakeClock() });
    assert.equal((await prepareDatabase(db, { clock: fakeClock(), backupPath: `${path}.bak` })).ok, true);
    const m24 = m24CandidateStore(db, { newId: () => 'x', nowMs: () => T0 as UnixMs });
    assert.deepEqual(m24.factsWindow.load(), { ok: true, value: [] });
    assert.deepEqual(m24.factsWindow.save([[T0, 30], [T0 + MIN, 5]]), { ok: true, value: undefined });
    assert.deepEqual(m24CandidateStore(db, { newId: () => 'y', nowMs: () => T0 as UnixMs }).factsWindow.load(), { ok: true, value: [[T0, 30], [T0 + MIN, 5]] });
    // Z09-54: a corrupt row is reported, never read as empty.
    for (const bad of ['{"not":"a list"}', '[[1,2,3]]', '[["x",1]]', '[[1,-1]]']) {
      db.withTx((tx) => { tx.run('UPDATE "kv_state" SET "value_json" = ? WHERE "key" = ?', bad, 'm05.facts_window'); });
      assert.deepEqual(m24.factsWindow.load(), { ok: false, error: { code: 'E_CORRUPT' } }, bad);
    }
    db.close();
  });
});

describe('Z09-43 with the red team\'s RT-13 repro', () => {
  it('a 400 SOL pool found at age 1 min is eligible at migration + 20 min and retired only at migration + 120 min', () => {
    const t = setup({ config: { screeningRequired: false } });
    const p = pubkey(101);
    t.u.onDiscovery(disc(1, T0 - 60_000));
    const at = new Map<string, number>();
    for (let k = 1; k <= 130; k++) {
      t.advance(60_000); t.u.tick();
      const st = t.u.candidate(p)?.state as string;
      if (!at.has(st)) at.set(st, k);
    }
    assert.equal(at.get('eligible'), 19, 'eligible at migration + 20 min');
    const c = t.u.candidate(p) as CandidateRecord;
    assert.deepEqual([c.state, c.reasons, c.retryAtMs], ['prefiltered_out', ['retired=past_entry_age'], null]);
    assert.equal(c.sinceMs, T0 - 60_000 + 7_200_000, 'retired at migration + 120 min, not before');
  });
});

describe('Z09-51: queued eligible pools keep fresh facts through reads instead of a 6 h retry', () => {
  it('40 eligible PM-01 pools, 30 slots: the 10 queued stay in the queue on fresh facts until + 120 min, within the ceiling', () => {
    const MIN = 60_000;
    const store = new MemStore();
    const classes = new Map<string, string>();
    const read = new Map<string, number>();
    const askedAt: number[] = [];
    const depth = new Map([...Array(40).keys()].map((i) => [pubkey(100 + i), BigInt(100 + i) * SOL] as const));
    const depthOf = (p: string): bigint => depth.get(p) ?? 0n;
    const t = setup({ store, config: { screeningRequired: false },
      // Watched pools are polled (current facts); a queued pool's facts are as old as its last read or its discovery.
      facts: (p) => ({ ...deep, effectiveQuoteLamports: depthOf(p), observedAtMs: (classes.get(p) === 'candidate' ? t.at() : read.get(p) ?? T0) as UnixMs }),
      requestFacts: (ids) => { for (const id of ids) { read.set(id, t.at()); askedAt.push(t.at()); } } });
    const w = createWatchlist({ restoreTails: () => [], config: WATCHLIST_DEFAULTS, nowMs: () => t.at() as UnixMs, maxHoldMs: () => 0, mode: () => 'normal',
      tracker: { watch: (id, c) => { classes.set(id, c); return true; }, unwatch: (id) => { classes.delete(id); } }, universe: t.u, onEviction: () => {}, log: { event: () => {} } });
    const migration = T0 - 20 * MIN;                                                   // all 40 found at + 20 min
    for (let i = 0; i < 40; i++) t.u.onDiscovery(disc(i, migration));
    w.recompute(t.u.candidates());
    const queued = [...Array(10).keys()].map((i) => pubkey(100 + i));                // the 10 shallowest
    assert.ok(queued.every((p) => t.u.candidate(p)?.state === 'eligible' && !classes.has(p)));
    const retiredAt = new Map<string, number>();
    for (let k = 1; k <= 110; k++) {                                                   // to migration + 130 min
      t.advance(MIN); t.u.tick(); w.recompute(t.u.candidates());
      for (const p of queued) {
        const c = t.u.candidate(p) as CandidateRecord;
        if (c.state === 'eligible') assert.ok(t.at() - (read.get(p) ?? T0) <= UNIVERSE_DEFAULTS.factsMaxAgeMs, `${p} eligible on stale facts at +${k} min`);
        if (c.reasons[0]?.startsWith('retired=') === true && !retiredAt.has(p)) retiredAt.set(p, t.at());
        assert.notEqual(c.state, 'watched', 'no slot was free');
      }
    }
    // Retired only for age, at migration + 120 min; never on a 6 h retry or for failed reads.
    for (const p of queued) {
      assert.equal(retiredAt.get(p), migration + 120 * MIN, p);
      assert.deepEqual(t.u.candidate(p)?.reasons, ['retired=past_entry_age']);
    }
    assert.ok(askedAt.length > 0 && askedAt.every((x) => x < migration + 120 * MIN));
    let worst = 0;
    for (let i = 0, j = 0; j < askedAt.length; j++) { while ((askedAt[j] as number) - (askedAt[i] as number) >= 3_600_000) i++; worst = Math.max(worst, j - i + 1); }
    assert.ok(worst <= UNIVERSE_DEFAULTS.factsRefreshPerHour, `${worst} reads in an hour`);
    // The manifest counts a queued pool as eligible only while its facts were fresh: its span has gaps.
    const m = buildUniverseManifest({ dayUtc: '2026-10-16', events: store.log.map((x) => ({ poolId: x.poolId, mint: x.mint, from: x.from, to: x.to, reason: x.reason, atMs: x.atMs })),
      crossCheck: { poolsOnlyInVendor: 0, otherDexPairs: 0, knownPoolsUnderOtherDex: 0, status: 'ok' }, migrationCoverage: { chainMigrations: 40, seenByPumpPortal: 40, gapBps: 0 },
      limitSet: { id: 'pm01', paramHash: 'x' }, generatedAtMs: T0 + 86_400_000, late: false, prefilterOnly: true });
    const q0 = m.eligible.find((e) => e.poolId === queued[0]);
    assert.ok(q0 !== undefined && q0.intervals.length > 1, JSON.stringify(q0?.intervals));
  });
});

describe('Z09-52: a pool already past every entry age at discovery never becomes eligible', () => {
  it('found at migration + 121 min under PM-01: prefiltered_out, retired, not in A-24; a rediscovery keeps it out', () => {
    const store = new MemStore();
    const t = setup({ store, config: { screeningRequired: false } });
    t.u.onDiscovery(disc(1, T0 - 121 * 60_000));
    const c = t.u.candidate(pubkey(101)) as CandidateRecord;
    assert.deepEqual([c.state, c.reasons, c.retryAtMs], ['prefiltered_out', ['retired=past_entry_age'], null]);
    assert.deepEqual(store.log.map((x) => x.to), ['discovered', 'prefiltered_out']);
    t.u.onDiscovery(disc(1, T0 - 121 * 60_000));                                   // rediscovered: still out
    assert.equal(t.u.candidate(pubkey(101))?.state, 'prefiltered_out');
    const m = buildUniverseManifest({ dayUtc: '2026-10-16', events: store.log.map((x) => ({ poolId: x.poolId, mint: x.mint, from: x.from, to: x.to, reason: x.reason, atMs: x.atMs })),
      crossCheck: { poolsOnlyInVendor: 0, otherDexPairs: 0, knownPoolsUnderOtherDex: 0, status: 'ok' }, migrationCoverage: { chainMigrations: 1, seenByPumpPortal: 1, gapBps: 0 },
      limitSet: { id: 'pm01', paramHash: 'x' }, generatedAtMs: T0 + 86_400_000, late: false, prefilterOnly: true });
    assert.equal(m.a24.eligibleCount, 0);
    // Under MR-01 (no latest age) the same pool is judged on its facts as before.
    const mr = setup({ config: { screeningRequired: false, ...MR } });
    mr.u.onDiscovery(disc(1, OLD));
    assert.equal(mr.u.candidate(pubkey(101))?.state, 'eligible');
  });
});

describe('Z09-53 (RT-15): pools past the entry window make way for in-window pools', () => {
  it('30 pools of 500 SOL aged 3.5 h hold every slot; a 200 SOL pool found 1 min after migration gets one at + 20 min, and the evicted pool\'s tail runs', () => {
    const depth = new Map<string, bigint>();
    const classes = new Map<string, string>();
    const evictions: Array<{ poolId: string; reason: string; tailUntilMs: number | null }> = [];
    const t = setup({ config: { screeningRequired: false }, requestFacts: () => {}, facts: (p) => ({ ...deep, effectiveQuoteLamports: depth.get(p) ?? 0n }) });
    const w = createWatchlist({ config: WATCHLIST_DEFAULTS, nowMs: () => t.at() as UnixMs, maxHoldMs: () => 7_200_000, mode: () => 'normal',
      tracker: { watch: (id, c) => { classes.set(id, c); return true; }, unwatch: (id) => { classes.delete(id); } }, universe: t.u, depthOf: (p) => depth.get(p) ?? null,
      onEviction: (e) => evictions.push(e), restoreTails: () => [], log: { event: () => {} } });
    for (let i = 0; i < 30; i++) { depth.set(pubkey(100 + i), 500n * SOL); t.u.onDiscovery(disc(i, T0 - 30 * 60_000)); }
    w.recompute(t.u.candidates());
    t.advance(3 * 3_600_000); t.u.tick(); w.recompute(t.u.candidates());
    // No in-window pool waits: the old pools keep their slots, so recording goes on.
    assert.equal([...classes.values()].filter((c) => c === 'candidate').length, 30);
    assert.equal(evictions.length, 0);
    const young = pubkey(999);
    depth.set(young, 200n * SOL);
    t.u.onDiscovery({ ...disc(0, t.at() - 60_000), poolId: young, baseMint: pubkey(998) });
    let watchedAt: number | null = null;
    for (let k = 0; k < 130 && watchedAt === null; k++) {
      t.advance(60_000); t.u.tick(); w.recompute(t.u.candidates());
      if (t.u.candidate(young)?.state === 'watched') watchedAt = t.at();
    }
    // Found at T0 + 3 h, migrated a minute before: watched at migration + 20 min.
    assert.equal(watchedAt, T0 + 3 * 3_600_000 - 60_000 + 20 * 60_000);
    // The shallowest-first order among equals falls on the newest of the old pools; it is evicted with its tail.
    assert.equal(evictions.length, 1);
    const ev = evictions[0] as { poolId: string; reason: string; tailUntilMs: number | null };
    assert.equal(ev.reason, 'past_entry_age');
    assert.equal(classes.get(ev.poolId), 'tail', 'the evicted pool is still recorded');
    assert.equal(ev.tailUntilMs, (watchedAt as number) + 7_200_000 + 3_600_000);
    assert.equal(t.u.candidate(ev.poolId)?.state, 'evicted');
  });
});

const MIN_MS = 60_000;
describe('Z09-54: a corrupt read window fails closed', () => {
  it('the hour after start counts as used: nothing is asked for an hour, then reads resume', () => {
    const store = new MemStore();
    store.corruptWindow = true;
    const asked: string[][] = [];
    const logs: string[] = [];
    let now: number = T0;
    let id = 0;
    const u = createUniverse({ config: { ...UNIVERSE_DEFAULTS, screeningRequired: false, ...MR }, store, nowMs: () => now as UnixMs, newId: () => ulid(id++), wsolMint: MINTS.wsol,
      facts: () => ({ ...deep, observedAtMs: T0 as UnixMs }), requestFacts: (ps) => asked.push([...ps]),
      lists: { isWrittenOff: () => false, isUnsolicited: () => false }, publish: () => {}, log: { event: (_l, c) => logs.push(c) } });
    assert.ok(logs.includes('m05.facts_window_corrupt'));
    u.onDiscovery(disc(1, OLD), { ...deep, feeTotalBps: 500, observedAtMs: T0 as UnixMs });
    store.corruptWindow = false;
    now += UNIVERSE_DEFAULTS.prefilterRetryMs;                                         // due, but the start's hour is long past
    u.tick();
    assert.equal(asked.length, 1, 'six hours on, the hour charged at start has passed');
    // Started on a corrupt window with a retry due at once: nothing within the hour.
    const s2 = new MemStore();
    let t2: number = T0;
    const asked2: string[][] = [];
    const u2a = createUniverse({ config: { ...UNIVERSE_DEFAULTS, screeningRequired: false, ...MR }, store: s2, nowMs: () => t2 as UnixMs, newId: () => ulid(id++), wsolMint: MINTS.wsol,
      facts: () => ({ ...deep, observedAtMs: T0 as UnixMs }), lists: { isWrittenOff: () => false, isUnsolicited: () => false }, publish: () => {}, log: { event: () => {} } });
    u2a.onDiscovery(disc(2, OLD), { ...deep, feeTotalBps: 500, observedAtMs: T0 as UnixMs });
    t2 += UNIVERSE_DEFAULTS.prefilterRetryMs;
    s2.corruptWindow = true;
    const u2 = createUniverse({ config: { ...UNIVERSE_DEFAULTS, screeningRequired: false, ...MR }, store: s2, nowMs: () => t2 as UnixMs, newId: () => ulid(id++), wsolMint: MINTS.wsol,
      facts: () => ({ ...deep, observedAtMs: T0 as UnixMs }), requestFacts: (ps) => asked2.push([...ps]),
      lists: { isWrittenOff: () => false, isUnsolicited: () => false }, publish: () => {}, log: { event: () => {} } });
    s2.corruptWindow = false;
    for (let k = 0; k < 59; k++) { u2.tick(); t2 += MIN_MS; }
    assert.equal(asked2.length, 0, 'no read within the hour charged at start');
    t2 += 2 * MIN_MS; u2.tick();
    assert.equal(asked2.length, 1);
  });
});
