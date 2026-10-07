// RED TEAM C round 2: planted-future-marker probe for DEDUP-PER-WATCH (live-feed.ts shed / #standIn / #shedKeys,
// canonical.ts echoEvents, PR #264). The live feed holds frames per slot and releases them by slot; shedding drops held
// first copies and puts an echo back as a stand-in, or remembers the key so a later copy is promoted whole. A leak would
// be an event released before the frame that carries it arrived, or a frame arriving later (in wall-clock order) that
// changes an event, a fact or a release already made, or a recording whose replay releases an event earlier than live.
// The probe scripts a live run with echoes, a shed with a stand-in, a shed with no stand-in (shed key), and late
// echoes; the plant is every frame arriving after the wall-clock moment M (late echoes on a released slot, a new
// transaction whose signature carries the marker, a second shed, a promoted copy). Checks:
//   - causality: every release happens at or after its frame was ingested (stand-ins: their body's first arrival);
//   - before M, the frames recorded, the events released, and the facts the producer makes from them are identical
//     with and without the plant, and none carries the marker;
//   - the recording replays (replayRecorded) to exactly the live releases, and its prefix before M equals the clean run.
import { describe, expect, it } from 'vitest';
import { type PoolState } from '../../../core/src/amm/index.ts';
import { encodeBase58 } from '../../../core/src/chain/index.ts';
import { OFF_CHAIN, compareEvents, reaches, type MarketEvent } from '../../../core/src/engine/index.ts';
import { STREAMS } from '../../../core/src/facts/index.ts';
import { FactWorld } from '../../../core/test/facts/helpers.ts';
import { swapLog } from '../../../core/test/facts/swaps.ts';
import { DEFAULT_LIVE_FEED, LiveFeed, replayRecorded, type Frame, type FrameBody, type Release } from '../../src/providers/index.ts';
import { parseTyped, typedText } from '../../src/run/json.ts';
import { blockNetwork } from '../helpers.ts';

blockNetwork();

const addr = (n: number): string => encodeBase58(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : 7 + i)));
const A = { mint: addr(1), pool: addr(2) };
const B = { mint: addr(3), pool: addr(4) };
const C = { mint: addr(21), pool: addr(22) };
const VIA = (p: { pool: string }) => `logs:${p.pool}`;
const CREATOR = addr(5);
const SUPPLY = 1_000_000_000_000_000n;
const PRE: PoolState = { baseReserve: 200_000_000_000_000n, quoteVault: 85_000_000_000n, virtualQuoteReserves: 0n };
const S0 = 1_000n;
const T0 = 1_791_100_000_000;
const at = (slot: bigint): number => T0 + Number(slot - S0) * 400;
const S = S0 + 5n;
// Signatures: base58 text of 64 bytes; the marker one carries the token in its text.
const TOKEN = 'FutureMarkerRedTeamC';
const sig = (n: number): string => encodeBase58(Uint8Array.from({ length: 64 }, (_, i) => (i === 0 ? n : (i * 7 + n) % 251)));
const SIG_X = sig(1);
const SIG_Y = sig(2);
const SIG_U = sig(3);
const SIG_V = `${TOKEN}${sig(4).slice(TOKEN.length)}`;

let k = 0;
const life = (program: 'pump' | 'pump_amm', name: string, data: Record<string, unknown>, mint: string, slot: bigint): MarketEvent => ({
  kind: 'market', id: `ev:life${k}:00000:00000`, moment: { slot, txIndex: 2 ** 32 + k, ixIndex: 1, receivedAt: at(slot) },
  key: `${program}:${name}:${mint}`,
  value: { event: { program, name, data, signature: `life${k++}`, slot, txIndex: 0, outerIx: 0, innerIx: 0 }, txSlot: slot, blockTime: null, source: 'helius', backfilled: false, seq: k },
});
const fact = (key: string, value: unknown, slot: bigint): MarketEvent =>
  ({ kind: 'market', id: `${key}#${k++}`, moment: { slot, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: at(slot) }, key, value: { value, source: 'helius', backfilled: false, seq: k } });

/** The three coins migrated to their pools, each pool on its own watch from S0. */
const opened = (): FactWorld => {
  const all: MarketEvent[] = [];
  for (const p of [A, B, C]) {
    const stamp = BigInt(Math.floor(at(S0) / 1000));
    all.push(
      fact(`coverage:${STREAMS.trades(p.pool)}:start`, { fromSlot: S0, via: VIA(p) }, S0 - 2n),
      life('pump', 'CompleteEvent', { mint: p.mint, timestamp: stamp }, p.mint, S0 - 1n),
      life('pump_amm', 'CreatePoolEvent', { timestamp: stamp, baseMint: p.mint, pool: p.pool, poolQuoteAmount: PRE.quoteVault, poolBaseAmount: PRE.baseReserve }, p.mint, S0),
      life('pump', 'CompletePumpAmmMigrationEvent', { mint: p.mint, pool: p.pool, timestamp: stamp }, p.mint, S0),
    );
  }
  return new FactWorld().push(...all.sort(compareEvents));
};

const buy = (p: { pool: string }, slot: bigint, pre = PRE) => swapLog({ pool: p.pool, coinCreator: CREATOR, supply: SUPPLY, pre, side: 'buy', base: 1_000_000_000n, atMs: at(slot) });

type Step = { readonly t: number; readonly plant?: true } & (
  | { readonly kind: 'logs'; readonly provider: 'helius' | 'alchemy'; readonly body: FrameBody }
  | { readonly kind: 'shed'; readonly via: string }
  | { readonly kind: 'tick'; readonly slot: bigint }
);
const logs = (signature: string, slot: bigint, via: string, lines: string[]): FrameBody => ({ type: 'logs', signature, slot, err: null, via, logs: lines, commitment: 'confirmed' });

/** The script. X touches A and B (A's copy first, B's an echo; A shed: B's echo stands in). U touches A and C (A shed with no C copy held: a shed key). */
const script = (): Step[] => {
  const x = [...buy(A, S).logs, ...buy(B, S).logs];
  const yB = buy(B, S + 2n, buy(B, S).after);
  const u = [...buy(A, S + 1n, buy(A, S).after).logs, ...buy(C, S + 1n).logs];
  const v = [...buy(A, S + 4n).logs, ...buy(B, S + 4n).logs];
  const M = at(S + 3n) + 50;
  return [
    { t: at(S), kind: 'logs', provider: 'helius', body: logs(SIG_X, S, VIA(A), x) },
    { t: at(S) + 1, kind: 'logs', provider: 'helius', body: logs(SIG_X, S, VIA(B), x) },
    { t: at(S) + 2, kind: 'logs', provider: 'alchemy', body: logs(SIG_X, S, VIA(A), x) },
    { t: at(S) + 3, kind: 'logs', provider: 'helius', body: logs(SIG_U, S + 1n, VIA(A), u) },
    { t: at(S) + 4, kind: 'shed', via: VIA(A) },
    { t: at(S + 1n), kind: 'tick', slot: S + 1n },
    { t: at(S + 2n), kind: 'logs', provider: 'helius', body: logs(SIG_Y, S + 2n, VIA(B), yB.logs) },
    { t: at(S + 3n), kind: 'tick', slot: S + 3n },
    // ---- after M: the plant ----
    { t: M, plant: true, kind: 'logs', provider: 'helius', body: logs(SIG_X, S, VIA(C), x) }, // late echo, slot released
    { t: M + 1, plant: true, kind: 'logs', provider: 'helius', body: logs(SIG_U, S + 1n, VIA(C), u) }, // shed key: promoted or lost
    { t: M + 2, plant: true, kind: 'logs', provider: 'helius', body: logs(SIG_V, S + 4n, VIA(A), v) },
    { t: M + 3, plant: true, kind: 'logs', provider: 'helius', body: logs(SIG_V, S + 4n, VIA(B), v) },
    { t: M + 4, plant: true, kind: 'shed', via: VIA(A) },
    { t: M + 5, plant: true, kind: 'logs', provider: 'alchemy', body: logs(SIG_V, S + 4n, VIA(A), v) },
    { t: at(S + 6n), plant: true, kind: 'tick', slot: S + 6n },
  ];
};
const M_AT = at(S + 3n) + 50;

interface Live {
  readonly frames: Frame[];
  readonly releases: Release[];
  readonly out: { t: number; e: MarketEvent }[];
  readonly violations: string[];
}

const live = (steps: readonly Step[]): Live => {
  const frames: Frame[] = [];
  const releases: Release[] = [];
  const out: { t: number; e: MarketEvent }[] = [];
  const violations: string[] = [];
  const ingestedAt = new Map<number, number>();
  /** First arrival of each body (signature@via), for stand-ins made at shed time from an echo that came earlier. */
  let now = 0;
  const feed = new LiveFeed({
    ...DEFAULT_LIVE_FEED, horizonSlots: 0,
    onFrame: (f) => {
      frames.push(f);
      ingestedAt.set(f.seq, now);
    },
    onRelease: (_e, r) => releases.push(r),
  });
  const drain = (t: number) => {
    for (let e = feed.next(); e !== null; e = feed.next()) {
      const r = releases.at(-1)!;
      const came = ingestedAt.get(r.frameSeq);
      if (came === undefined || came > t) violations.push(`event ${e.id} released at ${t} before its frame ${r.frameSeq} arrived (${came})`);
      if (e.kind === 'market') out.push({ t, e });
    }
  };
  for (const s of steps) {
    now = s.t;
    if (s.kind === 'logs') feed.ingest(s.provider, s.body, { receivedAt: s.t });
    else if (s.kind === 'shed') feed.shed((via) => via === s.via);
    else {
      feed.ingest('helius', { type: 'slot', slot: s.slot, parent: s.slot - 1n, root: null }, { receivedAt: s.t });
      feed.advance(s.t + 1);
    }
    drain(s.t + 1);
  }
  return { frames, releases, out, violations };
};

const factsOf = (events: readonly MarketEvent[]): string[] => {
  const w = opened();
  const start = w.released.length;
  w.push(...events);
  return w.released.slice(start).filter((e) => e.id.includes('~')).map((e) => typedText({ id: e.id, key: e.key, moment: e.moment, value: e.value }));
};

describe('RED TEAM C: DEDUP-PER-WATCH echoes, stand-ins and shed keys never release the future early', () => {
  const all = script();
  const clean = all.filter((s) => s.plant !== true);

  it('the script is a real test: echoes, a stand-in, a shed key and a late echo all occur, and the plant releases events', () => {
    const p = live(all);
    expect(p.frames.some((f) => f.echo === true)).toBe(true);
    // A stand-in: a frame for SIG_X on B's watch, not an echo, made after the shed.
    expect(p.frames.some((f) => f.body.type === 'logs' && f.body.signature === SIG_X && f.body.via === VIA(B) && f.echo !== true && !f.duplicate)).toBe(true);
    expect(p.frames.some((f) => f.lost === true || (f.body.type === 'logs' && f.body.signature === SIG_U && f.body.via === VIA(C) && f.echo !== true))).toBe(true);
    expect(p.out.some(({ e }) => reaches(e, TOKEN))).toBe(true);
    expect(p.out.length).toBeGreaterThan(live(clean).out.length);
  });

  it('no event is released before its frame arrived', () => {
    expect(live(all).violations).toEqual([]);
    expect(live(clean).violations).toEqual([]);
  });

  it('before M, frames, releases and facts are identical with and without the plant, and carry no marker', () => {
    const p = live(all);
    const c = live(clean);
    const pre = <T extends { t: number }>(xs: readonly T[]) => xs.filter((x) => x.t < M_AT);
    const pe = pre(p.out).map(({ e }) => e);
    const ce = pre(c.out).map(({ e }) => e);
    expect(pe.length).toBeGreaterThanOrEqual(5);
    expect(typedText(pe)).toBe(typedText(ce));
    for (const e of pe) expect(reaches(e, TOKEN)).toBe(false);
    expect(typedText(p.frames.slice(0, c.frames.length))).toBe(typedText(c.frames));
    expect(typedText(p.releases.slice(0, pe.length))).toBe(typedText(c.releases.slice(0, ce.length)));
    // Facts made from the released events, before M, are identical; and no fact before M carries the marker.
    const pf = factsOf(pe);
    expect(pf).toEqual(factsOf(ce));
    for (const f of pf) expect(f.includes(TOKEN)).toBe(false);
    // The plant changes facts after M (the probe is not vacuous).
    expect(factsOf(p.out.map(({ e }) => e))).not.toEqual(factsOf(c.out.map(({ e }) => e)));
  });

  it('the recording replays to exactly the live releases, and its prefix before M equals the clean run', () => {
    const p = live(all);
    const c = live(clean);
    const frames = p.frames.map((f) => parseTyped(typedText(f)) as Frame);
    const rp = replayRecorded(frames, p.releases.map((x) => parseTyped(typedText(x)) as Release));
    const replayed: MarketEvent[] = [];
    for (let e = rp.feed.next(); e !== null; e = rp.feed.next()) if (e.kind === 'market') replayed.push(e);
    expect(typedText(replayed)).toBe(typedText(p.out.map(({ e }) => e)));
    const n = c.out.filter(({ t }) => t < M_AT).length;
    expect(typedText(replayed.slice(0, n))).toBe(typedText(c.out.filter(({ t }) => t < M_AT).map(({ e }) => e)));
  });
});
