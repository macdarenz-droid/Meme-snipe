// STRATEGY-HEALTH-OBS acceptance (docs/DECISIONS.md, registered before the reducer was written). Observation only.
import { describe, expect, test } from 'vitest';
import type { Book } from '../src/lifecycle/index.ts';
import {
  HEALTH_DEFAULTS, compactHealthState, finalEpisodes, newEpisodeEvents, type EpisodeSources, healthStateFromJson, healthStateToJson, initialHealthState, lineageKey, reduceHealth, replayHealth,
  type HealthConfig, type HealthEvent, type StrategyIdentity,
} from '../src/strategy-health/index.ts';

const ID: StrategyIdentity = {
  lineageId: 'L1', strategyVersionHash: 'v1', universe: 'U1', venue: 'pumpswap', policyHash: 'p1', executionModelHash: 'x1', mode: 'paper',
};
const CFG: HealthConfig = { ...HEALTH_DEFAULTS, registered: [ID] };
const SOL = 1_000_000_000n;
const ENTRY = SOL / 10n; // 0.1 SOL fixed before the first attempt
const KEY = lineageKey(ID);

/** Event builder with a running durable sequence. */
const log = () => {
  let seq = 0;
  const events: HealthEvent[] = [];
  const api = {
    events,
    entry: (ep: string, identity = ID, entryLamports = ENTRY) => { events.push({ type: 'entry', seq: seq++, episodeId: ep, identity, entryLamports }); return api; },
    flow: (ep: string, lamports: bigint) => { events.push({ type: 'flow', seq: seq++, episodeId: ep, lamports }); return api; },
    final: (ep: string, outcome: 'closed' | 'failed-entry' | 'dropped' = 'closed') => { events.push({ type: 'final', seq: seq++, episodeId: ep, outcome }); return api; },
    /** One whole episode: spend the entry, receive entry·(1 + r), close. */
    trade: (ep: string, r: number, identity = ID) => {
      const back = (ENTRY * BigInt(Math.round((1 + r) * 1_000_000))) / 1_000_000n;
      return api.entry(ep, identity).flow(ep, -ENTRY).flow(ep, back).final(ep);
    },
  };
  return api;
};
const run = (events: readonly HealthEvent[], cfg = CFG) => replayHealth(events, cfg);

describe('strategy health reducer (observation only)', () => {
  test('1. same sign sequence, different amounts: different S and states', () => {
    const signs = [1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1];
    const a = log();
    const b = log();
    signs.forEach((w, i) => { a.trade(`a${i}`, w ? 0.3 : -0.02); b.trade(`b${i}`, w ? 0.01 : -0.95); });
    const ra = run(a.events);
    const rb = run(b.events);
    expect(ra.observations.map((o) => Math.sign(o.z))).toEqual(rb.observations.map((o) => Math.sign(o.z)));
    expect(ra.state.lineages[KEY]).toMatchObject({ status: 'active', observations: 20 });
    expect(ra.state.lineages[KEY]!.s).toBeLessThan(0.1);
    // B: four −95% losses push S past h/2 = 3.55 (S peaks near 3.6): watch, where R8's sign count sees nothing.
    expect(Math.max(...rb.observations.map((o) => o.s))).toBeGreaterThan(HEALTH_DEFAULTS.h / 2);
    expect(rb.observations.some((o) => o.to === 'watch')).toBe(true);
  });

  test('2. a profitable strategy that loses often stays active', () => {
    const l = log();
    // 10% of entries at +100%, 90% at −5% (mean +5.5%), 200 episodes: one win every ten.
    for (let i = 0; i < 200; i++) l.trade(`e${i}`, i % 10 === 9 ? 1 : -0.05);
    const r = run(l.events);
    expect(r.observations.filter((o) => o.z < 0)).toHaveLength(180);
    expect(r.observations.every((o) => o.to === 'active')).toBe(true);
  });

  test('3. tiny wins with severe losses reach paused while fewer than 5 of any 20 are losses', () => {
    const l = log();
    // One −95% loss in every five episodes: 4 losses per 20 (R8's review never trips), mean about −18%.
    for (let i = 0; i < 60; i++) l.trade(`e${i}`, i % 5 === 4 ? -0.95 : 0.01);
    const r = run(l.events);
    expect(r.observations.find((o) => o.to === 'paused')).toBeDefined();
    const firstPause = r.observations.findIndex((o) => o.to === 'paused');
    // S gains about 0.955 per loss less 0.015 per win: past h = 7.1 at the eighth loss (episode 40).
    expect(firstPause).toBe(39);
    const signs = r.observations.map((o) => (o.z < 0 ? 1 : 0));
    for (let i = 0; i + 20 <= signs.length; i++) expect(signs.slice(i, i + 20).reduce((x: number, y) => x + y, 0)).toBeLessThan(5);
  });

  test('4. a failed entry that paid fees and opened no position is one observation', () => {
    const fees = 15_000n;
    const r = run(log().entry('f').flow('f', -fees).flow('f', -fees).final('f', 'failed-entry').events);
    expect(r.observations).toHaveLength(1);
    expect(r.observations[0]!.z).toBe(-Number(2n * fees) / Number(ENTRY));
  });

  test('5 and 6. retries, partial fills and partial exits are one episode', () => {
    // Two failed buy attempts (fees), a partial fill and a second fill, three partial exits.
    const l = log().entry('e').flow('e', -5_000n).flow('e', -5_000n).flow('e', -ENTRY / 2n).flow('e', -ENTRY / 2n)
      .flow('e', ENTRY / 4n).flow('e', ENTRY / 4n).flow('e', ENTRY).final('e');
    const r = run(l.events);
    expect(r.observations).toHaveLength(1);
    expect(r.observations[0]!.z).toBe(Number(ENTRY / 2n - 10_000n) / Number(ENTRY));
  });

  test('7. a re-delivered event changes nothing; a conflicting one is refused', () => {
    const l = log().trade('a', -0.5);
    let st = run(l.events).state;
    for (const e of l.events) {
      const step = reduceHealth(st, e, CFG);
      expect(step).toMatchObject({ duplicate: true, observation: null });
      expect(step.state).toBe(st);
      st = step.state;
    }
    const final = l.events.at(-1)!;
    expect(() => reduceHealth(st, { ...final, outcome: 'dropped' } as HealthEvent, CFG)).toThrow(/conflicts with the event already applied/);
  });

  test('8. a restart at every durable-write boundary gives the uninterrupted transitions', () => {
    const l = log();
    for (let i = 0; i < 30; i++) l.trade(`e${i}`, i % 3 === 0 ? -0.9 : 0.05);
    l.entry('open').flow('open', -ENTRY).flow('open', ENTRY / 5n); // unfinished at the end
    const whole = run(l.events);
    for (let cut = 0; cut <= l.events.length; cut++) {
      const first = run(l.events.slice(0, cut));
      // Save, restore, and replay from an earlier checkpoint: the events after the saved sequence apply once,
      // the ones before it are re-deliveries.
      const restored = healthStateFromJson(healthStateToJson(first.state));
      const back = Math.max(0, cut - 3);
      const second = replayHealth(l.events.slice(back), CFG, restored);
      expect([...first.observations, ...second.observations]).toEqual(whole.observations);
      expect(healthStateToJson(second.state)).toBe(healthStateToJson(whole.state));
    }
  });

  test('9. an unfinished loser never vanishes', () => {
    const r = run(log().trade('a', 0.1).entry('b').flow('b', -ENTRY).flow('b', ENTRY / 10n).events);
    expect(r.state.open['b']).toMatchObject({ netLamports: -ENTRY + ENTRY / 10n, flows: 2, identity: ID });
    expect(r.state.lineages[KEY]!.observations).toBe(1);
    const restored = healthStateFromJson(healthStateToJson(r.state));
    expect(restored.open['b']!.netLamports).toBe(-ENTRY + ENTRY / 10n);
  });

  test('10. events apply in durable-sequence order; an out-of-order or unknown event is refused', () => {
    const l = log().trade('a', 0.1);
    const st = run(l.events).state;
    expect(() => reduceHealth(st, { type: 'entry', seq: 2, episodeId: 'z', identity: ID, entryLamports: ENTRY }, CFG)).toThrow(/conflicts/);
    const gap = run([{ type: 'entry', seq: 10, episodeId: 'x', identity: ID, entryLamports: ENTRY }]).state;
    expect(() => reduceHealth(gap, { type: 'entry', seq: 5, episodeId: 'y', identity: ID, entryLamports: ENTRY }, CFG)).toThrow(/durable-sequence order/);
    expect(() => run([{ type: 'flow', seq: 0, episodeId: 'nope', lamports: 1n }])).toThrow(/not open \(no entry\)/);
    expect(() => run([...log().trade('a', 0.1).events, { type: 'flow', seq: 99, episodeId: 'a', lamports: 1n }])).toThrow(/already final/);
    expect(() => run([...log().trade('a', 0.1).events, { type: 'entry', seq: 99, episodeId: 'a', identity: ID, entryLamports: ENTRY }])).toThrow(/already has an entry/);
  });

  test('11. a new version or policy inside a lineage cannot reset its history; a paused lineage requalifies', () => {
    const v2: StrategyIdentity = { ...ID, strategyVersionHash: 'v2', policyHash: 'p2' };
    const l = log();
    for (let i = 0; i < 8; i++) l.trade(`e${i}`, -0.95);
    const paused = run(l.events);
    expect(paused.state.lineages[KEY]).toMatchObject({ machine: 'paused', status: 'paused', pauses: 1 });
    l.trade('n1', 0.05, v2);
    const cfg2 = { ...CFG, registered: [ID, v2] };
    const after = run(l.events, cfg2);
    expect(after.state.lineages[KEY]).toMatchObject({ machine: 'requalifying', status: 'requalifying', identity: v2, observations: 9 });
    // Back to active after 20 clean episodes in a row, not before.
    for (let i = 0; i < 18; i++) l.trade(`c${i}`, 0.05, v2);
    expect(run(l.events, cfg2).state.lineages[KEY]!.machine).toBe('requalifying');
    l.trade('c18', 0.05, v2);
    expect(run(l.events, cfg2).state.lineages[KEY]).toMatchObject({ machine: 'active', cleanRun: 20 });
    // Another mode is another history: paper never inherits a backtest's.
    expect(lineageKey({ ...ID, mode: 'backtest' })).not.toBe(KEY);
  });

  test('12. returns below −100% are not clipped', () => {
    const r = run(log().entry('a').flow('a', -ENTRY).flow('a', -ENTRY / 20n).final('a').events);
    expect(r.observations[0]!.z).toBe(-1.05);
    expect(r.observations[0]!.s).toBeCloseTo(1.05 - HEALTH_DEFAULTS.kappa, 12);
  });

  test('13. a dropped attempt is not an observation; a dropped episode carrying fees is refused', () => {
    const r = run(log().entry('d').final('d', 'dropped').events);
    expect(r.observations).toEqual([]);
    expect(r.state.lineages[KEY]).toBeUndefined();
    expect(r.state.finished['d']).toEqual({ lineage: null, entryLamports: ENTRY, netLamports: 0n });
    expect(() => run(log().entry('d').flow('d', -5_000n).final('d', 'dropped').events)).toThrow(/a cost is never hidden/);
  });

  test('14. an unregistered identity is reported as such, its S still computed', () => {
    const other: StrategyIdentity = { ...ID, executionModelHash: 'x9' };
    const r = run(log().trade('a', -0.95, other).events);
    expect(r.state.lineages[KEY]).toMatchObject({ status: 'unregistered', machine: 'active' });
    expect(r.state.lineages[KEY]!.s).toBeCloseTo(0.945, 12);
    expect(r.observations[0]).toMatchObject({ from: null, to: 'unregistered' });
  });

  test('15. deterministic: the same events give the same output; bad config and sizes are refused', () => {
    const l = log();
    for (let i = 0; i < 40; i++) l.trade(`e${i}`, ((i * 37) % 11) / 10 - 0.6);
    expect(healthStateToJson(run(l.events).state)).toBe(healthStateToJson(run(l.events).state));
    expect(run(l.events).observations).toEqual(run(l.events).observations);
    expect(() => run(l.events, { ...CFG, h: 0 })).toThrow(/h > 0/);
    expect(() => run(l.events, { ...CFG, watchFraction: 1 })).toThrow(/watchFraction/);
    expect(() => run(l.events, { ...CFG, requalifyEpisodes: 0 })).toThrow(/requalifyEpisodes/);
    expect(() => run(log().entry('a', ID, 0n).events)).toThrow(/entry size must be positive/);
    expect(() => run([{ type: 'entry', seq: -1, episodeId: 'a', identity: ID, entryLamports: ENTRY }])).toThrow(/non-negative integer/);
  });

  test('the watch, paused and active boundaries sit exactly at h/2 and h', () => {
    // Each −50.5% episode adds 0.5 to S (z = −0.505, κ = 0.005).
    const l = log();
    for (let i = 0; i < 15; i++) l.trade(`e${i}`, -0.505);
    const states = run(l.events).observations.map((o) => [Number(o.s.toFixed(9)), o.to]);
    expect(states[6]).toEqual([3.5, 'active']);   // 3.5 < 3.55
    expect(states[7]).toEqual([4, 'watch']);
    expect(states[13]).toEqual([7, 'watch']);     // 7 < 7.1
    expect(states[14]).toEqual([7.5, 'paused']);
  });

  test('exactly h/2 is watch and exactly h is paused (κ 0, h 4, z −0.5: S lands on 2 and 4 exactly)', () => {
    const cfg = { ...CFG, kappa: 0, h: 4 };
    const l = log();
    for (let i = 0; i < 8; i++) l.entry(`e${i}`).flow(`e${i}`, -ENTRY).flow(`e${i}`, ENTRY / 2n).final(`e${i}`);
    const obs = run(l.events, cfg).observations;
    expect(obs.map((o) => o.s)).toEqual([0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4]);
    expect(obs.map((o) => o.to)).toEqual(['active', 'active', 'active', 'watch', 'watch', 'watch', 'watch', 'paused']);
  });

  test('a bad episode while requalifying restarts the count of clean episodes', () => {
    const l = log();
    for (let i = 0; i < 8; i++) l.trade(`e${i}`, -0.95);
    for (let i = 0; i < 15; i++) l.trade(`c${i}`, 0.05);
    l.trade('bad', -3.8); // S 3.805 ≥ h/2: the clean run is broken
    expect(run(l.events).state.lineages[KEY]).toMatchObject({ machine: 'requalifying', cleanRun: 0 });
    for (let i = 0; i < 19; i++) l.trade(`d${i}`, 0.05);
    // S decays below h/2 again only after the bad episode's excess is worked off; the count starts from there.
    const st = run(l.events).state.lineages[KEY]!;
    expect(st.machine).toBe('requalifying');
    expect(st.cleanRun).toBeLessThan(19);
  });
});

describe('episodes from the book (step 3)', () => {
  // A minimal book: finalEpisodes reads only intents (purpose, id, spend, venue, status, fills) and positions.
  const intent = (id: string, status: string, fills: number, purpose: 'entry' | 'exit' = 'entry', positionId = `p-${id}`) => ({
    intent: { id, purpose, venue: 'pumpswap', spend: ENTRY, positionId, key: `entry:M:U1.v1.0` }, status, fills: Array.from({ length: fills }, (_, k) => ({ signature: `${id}-f${k}` })), attempts: [],
  });
  const position = (id: string, entryIntentId: string, status = 'closed') => ({ id, entryIntentId, status });
  const book = (intents: ReturnType<typeof intent>[], positions: ReturnType<typeof position>[]) =>
    ({ intents: Object.fromEntries(intents.map((i) => [i.intent.id, i])), positions: Object.fromEntries(positions.map((p) => [p.id, p])) }) as unknown as Book;
  const src = (nets: Record<string, [bigint, number] | null>, stray: Record<string, [bigint, number]> = {}): EpisodeSources => ({
    identityOf: () => ID,
    positionNet: (id) => (nets[id] ? { net: nets[id]![0], atMs: nets[id]![1] } : null),
    strayFees: (id) => (stray[id] ? { lamports: stray[id]![0], atMs: stray[id]![1] } : { lamports: 0n, atMs: 0 }),
  });

  test('late-fill positions and partial exits of one entry are one episode, final when every position is settled', () => {
    const b = book([intent('e1', 'reconciled', 2)], [position('p1', 'e1'), position('p1.o2', 'e1')]);
    expect(finalEpisodes(b, src({ p1: [-ENTRY / 2n, 50], 'p1.o2': null }))).toEqual([]);
    expect(finalEpisodes(b, src({ p1: [-ENTRY / 2n, 50], 'p1.o2': [ENTRY / 10n, 70] }))).toEqual([
      { episodeId: 'e1', identity: ID, entryLamports: ENTRY, flows: [-ENTRY / 2n, ENTRY / 10n], outcome: 'closed', atMs: 70 },
    ]);
  });

  test('an entry with no fill is final only when terminal: a failed entry if it paid fees, else dropped', () => {
    const b = book([intent('f', 'abandoned', 0), intent('d', 'cancelled', 0), intent('r', 'failed', 0), intent('x', 'reconciled', 0)], [position('pf', 'f')]);
    const eps = finalEpisodes(b, src({}, { f: [15_000n, 30] }));
    // 'failed' and an unfilled 'reconciled' may still be retried within the intent: not final.
    expect(eps.map((e) => [e.episodeId, e.outcome, e.flows])).toEqual([['d', 'dropped', []], ['f', 'failed-entry', [-15_000n]]]);
  });

  test('episodes come in the order they became final; newEpisodeEvents numbers on and skips what the state has', () => {
    const b = book([intent('a', 'reconciled', 1), intent('b', 'reconciled', 1), intent('ex', 'reconciled', 1, 'exit', 'pa')], [position('pa', 'a'), position('pb', 'b')]);
    const eps = finalEpisodes(b, src({ pa: [1n, 90], pb: [2n, 40] }));
    expect(eps.map((e) => e.episodeId)).toEqual(['b', 'a']);
    const first = replayHealth(newEpisodeEvents(initialHealthState(), eps.slice(0, 1)), CFG);
    const rest = newEpisodeEvents(first.state, eps);
    expect(rest.map((e) => [e.type, e.seq, e.episodeId])).toEqual([['entry', 3, 'a'], ['flow', 4, 'a'], ['final', 5, 'a']]);
    expect(replayHealth(rest, CFG, first.state).observations.map((o) => o.episodeId)).toEqual(['a']);
  });

  test('compaction keeps only the fingerprints of open episodes; finished episodes stay known', () => {
    const l = log().trade('a', 0.1).entry('b').flow('b', -ENTRY);
    const st = run(l.events).state;
    const c = compactHealthState(st);
    expect(Object.keys(c.seen).map(Number)).toEqual([4, 5]);
    expect(c.finished['a']).toMatchObject({ lineage: KEY, entryLamports: ENTRY });
    // The open episode carries on from the compacted state exactly as from the full one.
    const more = [{ type: 'flow', seq: 6, episodeId: 'b', lamports: ENTRY / 2n }, { type: 'final', seq: 7, episodeId: 'b', outcome: 'closed' }] as const;
    expect(replayHealth(more, CFG, c).observations).toEqual(replayHealth(more, CFG, st).observations);
    // A re-delivery of a compacted-away event is refused as out of order rather than silently ignored.
    expect(() => reduceHealth(c, l.events[0]!, CFG)).toThrow(/durable-sequence order/);
  });
});

describe('late settlements after an episode was observed (PAPER-2; golden rule)', () => {
  const late = (seq: number, episodeId: string, lamports: bigint): HealthEvent => ({ type: 'late', seq, episodeId, lamports });

  test('a late settlement corrects the episode\'s return and the lineage is recomputed exactly; no new episode is counted', () => {
    const l = log().trade('a', 0.1);
    const before = run(l.events).state;
    const step = reduceHealth(before, late(99, 'a', -ENTRY / 2n), CFG);
    // The corrected return is 0.1 − 0.5 = −0.4: S = 0.4 − κ, exactly as if it had been known at the time.
    expect(step.observation).toMatchObject({ kind: 'correction', seq: 99, episodeId: 'a', lineage: KEY, from: 'active', to: 'active', previous: { s: 0, status: 'active', pauses: 0, z: 0.1 } });
    expect(step.observation!.z).toBeCloseTo(-0.4, 12);
    expect(step.observation!.s).toBeCloseTo(0.4 - HEALTH_DEFAULTS.kappa, 12);
    expect(step.state.lineages[KEY]).toMatchObject({ observations: 1 });
    expect(step.state.finished['a']!.netLamports).toBe(before.finished['a']!.netLamports - ENTRY / 2n);
    // The same as a run that saw the corrected return from the start.
    const direct = run(log().trade('a', -0.4).events).state.lineages[KEY]!;
    expect(step.state.lineages[KEY]!.s).toBeCloseTo(direct.s, 12);
  });

  // STATS review B1 of #200: an incremental S − Δz is wrong both ways; the reviewer's three cases, exact values.
  const zs = (...rs: number[]) => { const l = log(); rs.forEach((r, k) => l.trade(`e${k + 1}`, r)); return run(l.events).state; };
  test('B1 (a): +1, +1, then a late −2 on episode 1 is (−1, +1): S 0, no false watch', () => {
    const st = reduceHealth(zs(1, 1), late(99, 'e1', -2n * ENTRY), CFG).state.lineages[KEY]!;
    expect(st).toMatchObject({ s: 0, machine: 'active', pauses: 0 });
  });
  test('B1 (b): −3, +2, −3, then a late +3 on episode 1 is (0, +2, −3): S 2.995, decay not hidden', () => {
    const st = reduceHealth(zs(-3, 2, -3), late(99, 'e1', 3n * ENTRY), CFG).state.lineages[KEY]!;
    expect(st.s).toBeCloseTo(2.995, 12);
    expect(st).toMatchObject({ machine: 'active', pauses: 0 });
  });
  test('B1 (c): −4, +5, −1, then a late −4 on episode 1 is (−8, +5, −1): one pause, now requalifying', () => {
    const before = zs(-4, 5, -1);
    const step = reduceHealth(before, late(99, 'e1', -4n * ENTRY), CFG);
    expect(step.state.lineages[KEY]).toMatchObject({ machine: 'requalifying', pauses: 1, cleanRun: 2 });
    expect(step.state.lineages[KEY]!.s).toBeCloseTo(0.995, 12);
    expect(step.observation).toMatchObject({ kind: 'correction', to: 'requalifying', previous: { pauses: 0 } });
    expect(step.observation!.previous!.s).toBeCloseTo(before.lineages[KEY]!.s, 12);
  });

  test('a late loss can move a lineage to watch or paused, and breaks a requalifying clean run', () => {
    const l = log();
    for (let i = 0; i < 7; i++) l.trade(`e${i}`, -0.95); // S 6.615: watch
    const w = run(l.events).state;
    expect(w.lineages[KEY]!.machine).toBe('watch');
    const p = reduceHealth(w, late(99, 'e0', -ENTRY / 2n), CFG).state.lineages[KEY]!;
    expect(p).toMatchObject({ machine: 'paused', pauses: 1, status: 'paused' });
    const q = log();
    for (let i = 0; i < 8; i++) q.trade(`e${i}`, -0.95);
    for (let i = 0; i < 5; i++) q.trade(`c${i}`, 0.05);
    const r = run(q.events).state;
    expect(r.lineages[KEY]).toMatchObject({ machine: 'requalifying', cleanRun: 5 });
    expect(reduceHealth(r, late(99, 'c4', -4n * ENTRY), CFG).state.lineages[KEY]).toMatchObject({ machine: 'requalifying', cleanRun: 0 });
  });

  test('a late settlement on an open, dropped or unknown episode is refused', () => {
    const st = run(log().entry('o').entry('d').final('d', 'dropped').events).state;
    expect(() => reduceHealth(st, late(99, 'o', -1n), CFG)).toThrow(/still open: book it as a flow/);
    expect(() => reduceHealth(st, late(99, 'd', -1n), CFG)).toThrow(/was dropped/);
    expect(() => reduceHealth(st, late(99, 'zz', -1n), CFG)).toThrow(/which is unknown/);
  });

  test('newEpisodeEvents emits a late event exactly when an observed episode\'s settled net changed', () => {
    const ep = (net: bigint) => [{ episodeId: 'a', identity: ID, entryLamports: ENTRY, flows: [net], outcome: 'closed' as const, atMs: 1 }];
    const first = replayHealth(newEpisodeEvents(initialHealthState(), ep(-ENTRY / 4n)), CFG);
    expect(newEpisodeEvents(first.state, ep(-ENTRY / 4n))).toEqual([]);
    const more = newEpisodeEvents(first.state, ep(-ENTRY / 4n - 15_000n));
    expect(more).toEqual([{ type: 'late', seq: first.state.lastSeq + 1, episodeId: 'a', lamports: -15_000n }]);
    const after = replayHealth(more, CFG, first.state);
    expect(after.observations).toMatchObject([{ kind: 'correction' }]);
    expect(after.observations[0]!.z).toBe(Number(-ENTRY / 4n - 15_000n) / Number(ENTRY));
    // Applied once: the same settled net afterwards emits nothing more.
    expect(newEpisodeEvents(after.state, ep(-ENTRY / 4n - 15_000n))).toEqual([]);
  });
});
