// BT-2 through the one holdout registry (src/holdout.ts): the study's sealed run uses the registry's checks, start
// record, burn and seal with one configuration per universe; G2's opened registry is stored only when every opening
// had a G1 pass; the experiment registry keeps one entry per trial.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RESEARCH_CONFIG } from '../../core/src/config/index.ts';
import { burnHoldout, openHoldout } from '../../core/src/stats/index.ts';
import {
  type HoldoutPlan, readHoldoutStore, recordHoldoutG1, recordHoldoutG2, recordTrials, registerAttempt, RULED_ALPHA, sealThroughStore, setHoldoutPlan,
} from '../src/holdout.ts';
import { openSealed } from '../src/study/sealed.ts';

const dir = mkdtempSync(join(tmpdir(), 'reg-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const h = RESEARCH_CONFIG.holdout;
const plan: HoldoutPlan = {
  fromDay: h.fromDay, entryCutoffDay: h.entryCutoffDay, tailEndDay: h.tailEndDay, familySize: 2, tieSalt: 't', alpha: RULED_ALPHA,
  decoderBoundaries: [], procedure: ['p'], details: {},
};
const window = { fromDay: h.fromDay, toDay: new Date(Date.parse(`${h.tailEndDay}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10) };
const ids = { U1: 'U1-h', U2: 'U2-h' };
const configs: Record<string, string> = { U1: 'U1-c', U2: 'U2-c' };
const counts = { candidates: 400, entries: 320, entryDays: 12 };
const requirement = { requiredTrades: 300, requiredDays: 10, nPower: 280, nPowerSeed: 7 };
let n = 0;
/** A fresh registry with the plan and attempt 1 for U1 and U2. */
const fresh = () => {
  const a = { registryPath: join(dir, `r${n++}.json`), codeCommit: 'c', datasetId: 'd' };
  setHoldoutPlan(a, plan, RESEARCH_CONFIG);
  registerAttempt(a, { index: 1, entries: [{ holdoutId: 'U1-h', universe: 'U1', configId: 'U1-c', requirement }, { holdoutId: 'U2-h', universe: 'U2', configId: 'U2-c', requirement }] });
  return a;
};
const seal = (a: ReturnType<typeof fresh>, configOf = (u: string) => configs[u]!) =>
  sealThroughStore({ ...a, byUniverse: ids, window }, configOf, join(dir, `l${n++}.db`), () => ({ ledgerHash: 'abc', counts: { U1: counts, U2: counts } }));

describe('study holdouts through the one registry', () => {
  it('seals each universe under its own configuration, passing the registered cutoff to the run', () => {
    const a = fresh();
    let cutoff = 0;
    sealThroughStore({ ...a, byUniverse: ids, window }, (u) => configs[u]!, join(dir, 'x.db'), (c) => { cutoff = c; return { ledgerHash: 'abc', counts: { U1: counts, U2: counts } }; });
    expect(cutoff).toBe(Date.parse(`${h.entryCutoffDay}T00:00:00Z`));
    const s = readHoldoutStore(a.registryPath);
    expect(s.registry.entries.map((e) => [e.holdoutId, e.seal, e.ledgerHash])).toEqual([['U1-h', 'sealed', 'abc'], ['U2-h', 'sealed', 'abc']]);
    expect(s.runs.filter((r) => r.outcome === 'sealed').map((r) => r.configId)).toEqual(['U1-c', 'U2-c']);
  });

  it('refuses a universe run under another configuration, before anything runs', () => {
    const a = fresh();
    expect(() => seal(a, (u) => (u === 'U2' ? 'U2-other' : configs[u]!))).toThrow(/U2-other is not the authorised U2-c/);
    expect(readHoldoutStore(a.registryPath).registry.entries.every((e) => e.seal === 'registered')).toBe(true);
  });

  it('burns every holdout of the attempt when the run fails', () => {
    const a = fresh();
    expect(() => sealThroughStore({ ...a, byUniverse: ids, window }, (u) => configs[u]!, join(dir, 'f.db'), () => { throw new Error('crashed'); })).toThrow(/crashed/);
    const s = readHoldoutStore(a.registryPath);
    expect(s.registry.entries.every((e) => e.burned && e.burnReason === 'run-failed')).toBe(true);
    expect(s.attempts[0]!.ended?.outcome).toBe('failed');
  });

  it('stores G2\'s registry only when every opening had a latest G1 pass, and only seal changes', () => {
    const a = fresh();
    seal(a);
    const opened = (id: string) => openHoldout(readHoldoutStore(a.registryPath).registry, id, { configId: id === 'U1-h' ? 'U1-c' : 'U2-c', ledgerHash: 'abc', requiredTrades: 300, minDays: 10, nowMs: 1, nowDay: '2026-12-01', g1Passed: true });
    const u1 = opened('U1-h');
    expect(u1.ok).toBe(true);
    expect(() => recordHoldoutG2(a, u1.registry)).toThrow(/U1-h cannot be opened: U1-h has no G1 result/);
    recordHoldoutG1(a, { holdoutId: 'U1-h', configId: 'U1-c', passed: false, evaluatedOn: 'wf' });
    expect(() => recordHoldoutG2(a, u1.registry)).toThrow(/did not pass/);
    // A burn needs no G1 pass (a mismatch burns before anything opens).
    const burned = burnHoldout(readHoldoutStore(a.registryPath).registry, 'U2-h', 'hash-mismatch', 'x').registry;
    expect(recordHoldoutG2(a, burned).registry.entries[1]!.burned).toBe(true);
    // Anything but the seal is refused.
    const b = fresh();
    seal(b);
    recordHoldoutG1(b, { holdoutId: 'U1-h', configId: 'U1-c', passed: true, evaluatedOn: 'wf' });
    const reg = readHoldoutStore(b.registryPath).registry;
    expect(() => recordHoldoutG2(b, { ...reg, entries: reg.entries.map((e) => ({ ...e, configId: 'changed' })) })).toThrow(/more than the seal/);
    expect(() => recordHoldoutG2(b, { ...reg, familySize: 3 })).toThrow(/resize/);
    const ok = openHoldout(reg, 'U1-h', { configId: 'U1-c', ledgerHash: 'abc', requiredTrades: 300, minDays: 10, nowMs: 1, nowDay: '2026-12-01', g1Passed: true });
    expect(recordHoldoutG2(b, ok.registry).registry.entries[0]!.seal).toBe('opened');
  });

  it('keeps the sealed outcomes closed without a latest G1 pass', () => {
    const a = fresh();
    seal(a);
    recordHoldoutG1(a, { holdoutId: 'U1-h', configId: 'U1-c', passed: false, evaluatedOn: 'wf' });
    expect(() => openSealed('/nonexistent/h.db', readHoldoutStore(a.registryPath), ['U1-h'])).toThrow(/stays closed: U1-h's latest G1 did not pass/);
  });

  it('keeps the experiment registry in the holdout registry: one entry per trial, a plan first, and only the pre-registered family', () => {
    const t = (tag: string, trialId = `${tag}-c`) => ({ trialId, configId: trialId, tag, evaluatedOn: 'wf', sharpe: 0.1, nTrades: 10 });
    const none = { registryPath: join(dir, `t${n++}.json`), codeCommit: 'c', datasetId: 'd' };
    expect(() => recordTrials(none, [t('U2')])).toThrow(/set the plan/);
    const a = fresh();
    recordTrials(a, [t('U2')]);
    recordTrials(a, [t('U2'), t('U1')]);
    expect(readHoldoutStore(a.registryPath).trials!.map((x) => x.trialId)).toEqual(['U2-c', 'U1-c']);
    // A plan that binds RES-4's family refuses a trial outside it, and keeps the log unchanged.
    const f = { registryPath: join(dir, `t${n++}.json`), codeCommit: 'c', datasetId: 'd' };
    setHoldoutPlan(f, { ...plan, details: { preregistration: { sha256: 'abc', ids: ['H4-U2-reclaim', 'H5-U2-exhausted-dump'] } } }, RESEARCH_CONFIG);
    recordTrials(f, [t('H4-U2-reclaim')]);
    expect(() => recordTrials(f, [t('H5-U2-exhausted-dump'), t('H7-U2-new')])).toThrow(/H7-U2-new are not in the pre-registered family/);
    expect(readHoldoutStore(f.registryPath).trials!.map((x) => x.tag)).toEqual(['H4-U2-reclaim']);
    // The family is fixed with the plan: a seventh hypothesis is a different plan, refused on this window.
    expect(() => setHoldoutPlan(f, { ...plan, details: { preregistration: { sha256: 'abd', ids: ['H4-U2-reclaim', 'H5-U2-exhausted-dump', 'H7-U2-new'] } } }, RESEARCH_CONFIG)).toThrow(/fixed once set/);
  });
});
