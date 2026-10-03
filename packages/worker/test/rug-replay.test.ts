// RUG-1 on real chain data: a known rug and a known non-rug (fixtures/rug-replay.json, fetched from the public RPC
// by fixtures/fetch-rug-fixtures.ts) go through DEC-1, FEED-1's canonical events and the labeller, as live would see
// them: from logs, from fetched transactions, and from both at once.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recordFromRpc, type RpcTransactionBase64 } from '../../core/src/chain/index.ts';
import { RUG_CONFIG } from '../../core/src/config/index.ts';
import { compareMoments, type MarketEvent } from '../../core/src/engine/index.ts';
import { RugLabeller, type RugLabel } from '../../core/src/gates/index.ts';
import { eventsOfFrame, rankIn, type Frame, type FrameBody } from '../src/providers/canonical.ts';

interface Case {
  readonly name: 'rug' | 'non-rug';
  readonly mint: string;
  readonly transactions: readonly (RpcTransactionBase64 & { readonly signature: string })[];
}
const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'rug-replay.json'), 'utf8')) as { meta: { fetchedAt: string }; cases: Case[] };
const byName = (name: Case['name']) => FIXTURE.cases.find((c) => c.name === name)!;

type Mode = 'logs' | 'tx' | 'both';
/** Every frame of the case in arrival order (logs at processed, then the fetched transaction), released in moment order. */
const released = (c: Case, mode: Mode): MarketEvent[] => {
  const ranks = new Map<bigint, Map<string, number>>();
  const events: MarketEvent[] = [];
  let seq = 0;
  for (const t of c.transactions) {
    const rec = recordFromRpc(t.signature, t, null);
    const bodies: FrameBody[] = [];
    if (mode !== 'tx') bodies.push({ type: 'logs', signature: t.signature, slot: rec.slot, err: rec.err, via: 'pump', logs: rec.logMessages ?? [] });
    if (mode !== 'logs') bodies.push({ type: 'tx', record: rec });
    for (const body of bodies) {
      seq++;
      const f: Frame = { seq, receivedAt: (rec.blockTime ?? 0) * 1_000 + seq, source: 'helius', backfilled: false, place: { at: 'chain', slot: rec.slot }, duplicate: false, body };
      const r = ranks.get(rec.slot) ?? new Map<string, number>();
      ranks.set(rec.slot, r);
      rankIn(r, f);
      for (const e of eventsOfFrame(f, r)) if (e.kind === 'market') events.push(e);
    }
  }
  return events.sort((a, b) => compareMoments(a.moment, b.moment));
};

const label = (c: Case, mode: Mode) => {
  const l = new RugLabeller(RUG_CONFIG);
  const out: { readonly fact: MarketEvent; readonly by: MarketEvent }[] = [];
  const events = released(c, mode);
  for (const e of events) for (const fact of l.observe(e)) out.push({ fact, by: e });
  return { out, events, unjudged: l.unjudged };
};
const sigOf = (e: MarketEvent) => e.id.split(':')[1];

describe('a known rug (3sNm…pump, launched 2026-10-02)', () => {
  const c = byName('rug');

  it('is a creator dump at the deployer\'s sale of 5.06% of supply, 126 s after launch', () => {
    const { out } = label(c, 'tx');
    expect(out).toHaveLength(1);
    const v = out[0]!.fact.value as RugLabel;
    expect(v).toMatchObject({ mint: c.mint, creator: 'GaMPRt9yhnhRAB134imiwkmXAtVYkcTtZFzF1nBeqw6H', rule: 'creator-dump', version: RUG_CONFIG.version });
    expect(v.detail).toBe('the deployer sold 50591814205825 of 1000000000000000 tokens within 126000 ms of launch');
    expect(sigOf(out[0]!.by)).toBe('4f4YRWURmxFMtdrWB4EoYiodfBSawRrwnHQV3B9LZqtT2VJEtK9as4yDBfah9JmDkr615suRt9DtXGESji1CJUxq');
    expect(out[0]!.fact.moment).toEqual(out[0]!.by.moment);
  });

  it('is labelled the same from logs, from transactions, and from both at once (each sale counted once)', () => {
    const tx = label(c, 'tx').out.map((x) => x.fact.value as RugLabel);
    for (const mode of ['logs', 'both'] as const) {
      const got = label(c, mode).out.map((x) => x.fact.value as RugLabel);
      expect(got.map((v) => [v.rule, v.creator, v.detail, v.atMs, v.slot])).toEqual(tx.map((v) => [v.rule, v.creator, v.detail, v.atMs, v.slot]));
    }
  });

  it('is not a rug before that sale', () => {
    const { out, events } = label(c, 'both');
    const at = out[0]!.by.moment;
    const l = new RugLabeller(RUG_CONFIG);
    for (const e of events) {
      if (compareMoments(e.moment, at) >= 0) break;
      expect(l.observe(e)).toEqual([]);
    }
  });
});

describe.each(FIXTURE.cases.filter((c) => c.name === 'non-rug').map((c) => [c.mint, c] as const))('a known non-rug (%s, whole first day replayed)', (_, c) => {

  it('gets no label in any mode, and every transaction decodes', () => {
    for (const mode of ['logs', 'tx', 'both'] as const) {
      const { out, events, unjudged } = label(c, mode);
      expect(out).toEqual([]);
      expect(unjudged.size).toBe(0);
      expect(events.some((e) => e.key.endsWith(`CreateEvent:${c.mint}`))).toBe(true);
    }
  });

  it('was fetched whole, more than 24 h after launch', () => {
    const launch = Math.min(...c.transactions.map((t) => t.blockTime ?? Infinity)) * 1_000;
    expect(Date.parse(FIXTURE.meta.fetchedAt) - launch).toBeGreaterThan(RUG_CONFIG.collapse.windowMs);
    expect(Date.parse(FIXTURE.meta.fetchedAt) - launch).toBeGreaterThan(RUG_CONFIG.creatorDump.windowMs);
  });
});
