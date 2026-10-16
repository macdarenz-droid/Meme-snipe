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
import { MemStore } from './mem-store.ts';
import { buildUniverseManifest } from '../../src/m05/manifest.ts';
import { createWatchlist, WATCHLIST_DEFAULTS } from '../../src/m05/watchlist.ts';
import { openDb, type Db } from '../../src/m24/db.ts';
import { prepareDatabase } from '../../src/m24/migrate.ts';
import { createRepos } from '../../src/m24/repos.ts';
import { fakeClock, tempDir } from '../helpers.ts';
import { pubkey, ulid } from '../m24/samples.ts';

const T0 = Date.UTC(2026, 9, 16) as UnixMs;
const SOL = 1_000_000_000n;
const deep: PrefilterFacts = { venue: 'pumpswap', quoteMint: MINTS.wsol, feeTotalBps: 30, effectiveQuoteLamports: 400n * SOL };

function setup(o: { config?: Partial<UniverseConfig>; facts?: (p: string) => PrefilterFacts | null; store?: CandidateStore; idBase?: number } = {}) {
  let now: number = T0;
  let id = o.idBase ?? 0;
  const store = o.store ?? new MemStore();
  const published: Transition[] = [];
  const logs: string[] = [];
  const writtenOff = new Set<string>();
  const deps: UniverseDeps = {
    config: { ...UNIVERSE_DEFAULTS, ...o.config }, store, nowMs: () => now as UnixMs, newId: () => ulid(id++), wsolMint: MINTS.wsol,
    facts: o.facts ?? (() => deep), lists: { isWrittenOff: (m) => writtenOff.has(m), isUnsolicited: () => false },
    publish: (t) => published.push(t), log: { event: (_l, c) => logs.push(c) },
  };
  const u = createUniverse(deps);
  return { u, store, published, logs, writtenOff, advance: (ms: number) => { now += ms; }, at: () => now };
}
const disc = (i: number, migratedAtMs: number | null = T0 - 2 * 86_400_000) => ({ poolId: pubkey(100 + i), baseMint: pubkey(200 + i), quoteMint: MINTS.wsol, venue: 'pumpswap', verifiedOnChain: true, migratedAtMs: migratedAtMs as UnixMs | null });

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
    let f: PrefilterFacts = { ...deep, feeTotalBps: 126 };
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
    t.advance(1); t.u.tick();
    assert.equal(t.u.candidate(pubkey(100))?.state, 'eligible');
    assert.equal(t.u.candidate(pubkey(100))?.depthLamports, 400n * SOL);
    // A rediscovery of a prefiltered pool re-evaluates it at once; no facts → prefiltered_out (no_snapshot).
    const n = setup({ config: { screeningRequired: false }, facts: () => null });
    n.u.onDiscovery(disc(0));
    assert.deepEqual(n.u.candidate(pubkey(100))?.reasons, ['no_snapshot']);
    n.u.onDiscovery(disc(0), deep);
    assert.equal(n.u.candidate(pubkey(100))?.state, 'eligible');
    // Unverified discoveries and another mint on the same pool are ignored; one candidate per pool.
    n.u.onDiscovery({ ...disc(5), verifiedOnChain: false });
    assert.equal(n.u.candidate(pubkey(105)), null);
    n.u.onDiscovery({ ...disc(0), baseMint: pubkey(999) });
    assert.equal(n.u.candidates().length, 1);
  });

  it('Phase 1 path through test doubles: screening → eligible → watched → signalled → in_position → cooldown → watched', () => {
    const t = setup();
    const p = pubkey(100);
    t.u.onDiscovery(disc(0));
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
    t.u.onEvicted(p, 'budget', (t.at() + 3_600_000) as UnixMs);
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
    let f: PrefilterFacts | null = deep;
    const t = setup({ facts: () => f });
    const [a, b] = [pubkey(100), pubkey(101)];
    for (const i of [0, 1]) t.u.onDiscovery(disc(i));
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
    assert.equal(again.u.candidate(pubkey(100))?.migratedAtMs, T0 - 2 * 86_400_000);
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
    let f: PrefilterFacts | null = deep;
    const store = new MemStore();
    const t = setup({ store, facts: () => f });
    t.u.onDiscovery(disc(1));
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
    const t = setup({ store, facts: () => ({ ...deep, feeTotalBps: 500 }) });
    t.u.onDiscovery(disc(1));
    t.advance(21_600_000); t.u.tick();
    const due = (store.get(pubkey(101)) as CandidateRecord).retryAtMs;
    assert.equal(due, t.at() + 21_600_000);
    const t2 = setup({ store, idBase: 900, facts: () => ({ ...deep, feeTotalBps: 500 }) });
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
    let f: PrefilterFacts | null = deep;
    const t = setup({ config: { screeningRequired: false }, facts: () => f });
    t.u.onDiscovery(disc(1));
    const p = pubkey(101);
    const w = createWatchlist({ config: WATCHLIST_DEFAULTS, nowMs: () => t.at() as UnixMs, maxHoldMs: () => 0, mode: () => 'normal',
      tracker: { watch: () => true, unwatch: () => {} }, universe: t.u, onEviction: () => {}, log: { event: () => {} } });
    w.recompute(t.u.candidates());
    t.u.onSignal(p); t.u.onRiskDecision(p, true); t.u.onPositionTerminal(p, 'closed');
    f = { ...deep, feeTotalBps: 500 };
    t.advance(1_800_001); t.u.tick();
    assert.equal(t.u.candidate(p)?.state, 'evicted');
    w.recompute([...t.u.candidates(), t.u.candidate(p) as CandidateRecord]);
    assert.equal(t.u.candidate(p)?.state, 'evicted');
    t.advance(21_600_000); t.u.tick();
    assert.equal(t.u.candidate(p)?.state, 'evicted');                               // its retry still fails the prefilter
    f = deep;
    t.advance(21_600_000); t.u.tick();
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
    const w = createWatchlist({ config: { ...WATCHLIST_DEFAULTS, maxWatched: 1 }, nowMs: () => t.at() as UnixMs, maxHoldMs: () => 0, mode: () => 'normal',
      tracker: { watch: (id) => { order.push(id); return true; }, unwatch: () => {} }, universe: { onWatched: () => true, onEvicted: () => {} },
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
      facts: () => deep, lists: { isWrittenOff: () => false, isUnsolicited: () => false }, publish: () => {}, log: { event: () => {} } });
    const cuts: Array<{ poolId: string; atMs: number; reason: string; tailUntilMs: number | null }> = [];
    const w = createWatchlist({ config: { ...WATCHLIST_DEFAULTS, maxWatched: 1, tailMaxPools: 1 }, nowMs: () => now as UnixMs, maxHoldMs: () => 0, mode: () => 'normal',
      tracker: { watch: () => true, unwatch: () => {} }, universe: u, onEviction: (e) => cuts.push(e), log: { event: () => {} } });
    for (const i of [1, 2]) u.onDiscovery(disc(i));
    w.recompute(u.candidates());                                                    // pool 101 or 102 watched
    now += 13;
    const w0 = createWatchlist({ config: { ...WATCHLIST_DEFAULTS, maxWatched: 1, tailMaxPools: 1 }, nowMs: () => now as UnixMs, maxHoldMs: () => 0, mode: () => 'normal',
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
