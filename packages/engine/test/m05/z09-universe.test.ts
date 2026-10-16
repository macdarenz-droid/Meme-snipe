// A-M05-01 candidate state machine (card Z09): the property test over random event sequences, the age rule (C-15),
// the C-44 config rule, Phase 0, Phase 1 handlers through test doubles, and persistence over M24.
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import fc from 'fast-check';
import type { Lamports, UnixMs } from '@bot/types';
import { MINTS } from '@bot/venue/constants';
import {
  ALLOWED, checkUniverseConfig, createUniverse, isAllowed, MR_LIMITS, PM_LIMITS, STATES, UNIVERSE_DEFAULTS,
  type CandidateRecord, type CandidateStore, type PrefilterFacts, type Transition, type UniverseConfig, type UniverseDeps,
} from '../../src/m05/universe.ts';
import { CANDIDATE_TOPIC, m24CandidateStore } from '../../src/m05/store.ts';
import { openDb, type Db } from '../../src/m24/db.ts';
import { prepareDatabase } from '../../src/m24/migrate.ts';
import { createRepos } from '../../src/m24/repos.ts';
import { fakeClock, tempDir } from '../helpers.ts';
import { pubkey, ulid } from '../m24/samples.ts';

const T0 = Date.UTC(2026, 9, 16) as UnixMs;
const SOL = 1_000_000_000n;
const deep: PrefilterFacts = { venue: 'pumpswap', quoteMint: MINTS.wsol, feeTotalBps: 30, effectiveQuoteLamports: 400n * SOL };

class MemStore implements CandidateStore {
  rows = new Map<string, CandidateRecord>();
  log: Transition[] = [];
  refuse = false;
  load(): CandidateRecord[] { return [...this.rows.values()]; }
  apply(prev: CandidateRecord | null, next: CandidateRecord, t: Transition) {
    if (this.refuse) return { ok: false as const, error: { code: 'E_WRITE' as const } };
    const cur = this.rows.get(next.candidateId);
    if ((prev === null) !== (cur === undefined) || (prev !== null && cur?.version !== prev.version)) return { ok: false as const, error: { code: 'E_STATE_CHANGED' as const } };
    this.rows.set(next.candidateId, next);
    this.log.push(t);
    return { ok: true as const, value: undefined };
  }
}

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

describe('A-M05-01 acceptance', () => {
  it('property: no undefined transition; open_failed or written_off always moves the candidate to cooldown; a written-off mint is blacklisted', () => {
    const ev = fc.oneof(
      fc.record({ k: fc.constant('disc'), i: fc.integer({ min: 0, max: 4 }) }),
      fc.record({ k: fc.constantFrom('watched', 'evicted', 'signal', 'accept', 'reject', 'stale', 'fresh', 'layout', 'quarantine', 'auth', 'tick'), i: fc.integer({ min: 0, max: 4 }) }),
      fc.record({ k: fc.constant('screen'), i: fc.integer({ min: 0, max: 4 }), v: fc.constantFrom('eligible', 'rejected', 'honeypot', 'authority') }),
      fc.record({ k: fc.constant('terminal'), i: fc.integer({ min: 0, max: 4 }), v: fc.constantFrom('closed', 'open_failed', 'written_off') }),
      fc.record({ k: fc.constant('time'), ms: fc.integer({ min: 0, max: 30 * 3_600_000 }) }),
    );
    fc.assert(fc.property(fc.boolean(), fc.array(ev, { maxLength: 80 }), (screening, events) => {
      const t = setup({ config: { screeningRequired: screening } });
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
      assert.deepEqual(t.published, (t.store as MemStore).log);
    }), { numRuns: 300 });
  });

  it('a pool with no known migration has no age proof and fails the MR age prefilter (D30 parked); with the migration it passes at 24 h', () => {
    const t = setup({ config: { limits: [MR_LIMITS], screeningRequired: false } });
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
    // Evicted, then eligible again and watched.
    t.u.onEvicted(p, 'budget');
    assert.equal(t.u.candidate(p)?.state, 'evicted');
    t.u.onWatched(p);
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
    const dropped = t.u.candidates().filter((c) => c.state === 'rejected');
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
