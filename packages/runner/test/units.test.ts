import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { checkStartHealth, segmentAllowed, type Health } from '../src/contract.ts';
import { checkJournal } from '../src/journal.ts';
import { makePlan } from '../src/plan.ts';
import { buildReport, reportMarkdown, uptime, type RunMeta, type Sample } from '../src/report.ts';
import { scanBuffer } from '../src/scan.ts';

const J = (seq: number, boot: string, kind: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ seq, ts: new Date(1_700_000_000_000 + seq * 1000).toISOString(), boot, kind, ...extra });
const R = ['why'];
const good = [
  J(1, 'a', 'start'),
  J(2, 'a', 'reconcile', { ok: true }),
  J(3, 'a', 'decision', { reasons: R }),
  J(4, 'a', 'simulation', { trade: 't1', leg: 'entry' }),
  J(5, 'a', 'entry', { trade: 't1', reasons: R }),
  J(6, 'b', 'start'),
  J(7, 'b', 'reconcile', { ok: true }),
  J(8, 'b', 'simulation', { trade: 't1', leg: 'exit' }),
  J(9, 'b', 'exit', { trade: 't1', reasons: R }),
];

describe('journal completeness', () => {
  it('passes a complete journal across a restart', () => {
    const r = checkJournal(good.join('\n') + '\n');
    expect(r).toMatchObject({ complete: true, lines: 9, boots: 2, entries: 1, exits: 1, simulations: 2 });
  });
  it.each([
    ['a seq gap', good.filter((_, i) => i !== 3)],
    ['a repeated seq', [...good.slice(0, 5), J(5, 'b', 'start')]],
    ['an entry before reconcile', [J(1, 'a', 'start'), J(2, 'a', 'simulation', { trade: 'x', leg: 'entry' }), J(3, 'a', 'entry', { trade: 'x', reasons: R })]],
    ['an entry without its simulation', [J(1, 'a', 'start'), J(2, 'a', 'reconcile', { ok: true }), J(3, 'a', 'entry', { trade: 'x', reasons: R })]],
    ['a decision without reasons', [J(1, 'a', 'start'), J(2, 'a', 'decision', { reasons: [] })]],
    ['a boot that does not open with start', [J(1, 'a', 'start'), J(2, 'b', 'reconcile', { ok: true })]],
    ['a failed reconcile', [J(1, 'a', 'start'), J(2, 'a', 'reconcile', { ok: false }), J(3, 'a', 'simulation', { trade: 'x', leg: 'entry' }), J(4, 'a', 'entry', { trade: 'x', reasons: R })]],
  ])('fails on %s', (_, lines) => {
    expect(checkJournal(lines.join('\n')).complete).toBe(false);
  });
  it('allows a torn last line only when asked', () => {
    const torn = good.join('\n') + '\n{"seq":10,"ts":"20';
    expect(checkJournal(torn).complete).toBe(false);
    expect(checkJournal(torn, { allowTornTail: true }).complete).toBe(true);
    expect(checkJournal(['{bad', ...good].join('\n'), { allowTornTail: true }).complete).toBe(false);
  });
});

describe('drill plan', () => {
  const D = 48 * 3_600_000;
  const feeds = ['pumpportal', 'helius-ws', 'alchemy-ws'];
  const plan = makePlan({ durationMs: D, feeds });
  it('has at least 3 restarts and one drop per feed, all inside the run and in time order', () => {
    expect(plan.filter((d) => d.kind === 'restart').length).toBeGreaterThanOrEqual(3);
    expect(plan.flatMap((d) => (d.kind === 'feed' ? [d.feed] : [])).sort()).toEqual([...feeds].sort());
    expect(plan.every((d) => d.atMs > 0.04 * D && d.atMs < 0.96 * D)).toBe(true);
    expect(plan.map((d) => d.atMs)).toEqual([...plan.map((d) => d.atMs)].sort((a, b) => a - b));
  });
  it('never puts a feed drop inside a restart window', () => {
    for (const r of plan) {
      if (r.kind !== 'restart') continue;
      for (const f of plan) if (f.kind === 'feed') expect(f.atMs < r.atMs || f.atMs > r.atMs + r.windowMs + 300_000).toBe(true);
    }
  });
  it('is fixed by its inputs', () => {
    expect(makePlan({ durationMs: D, feeds: [...feeds].reverse() })).toEqual(plan);
    expect(() => makePlan({ durationMs: D, feeds, restarts: 2 })).toThrow();
  });
});

const sample = (t: number, ready: boolean, extra: Partial<Sample> = {}): Sample => ({
  t, up: ready, ready, boot: 'a', git_sha: 'c0ffee', rss_bytes: 100 * 1024 * 1024, in_trade: false, entries_halted: false,
  recorder: true, simulation: true, stub: false, feeds: 'f', feeds_down: [], ...extra,
});

describe('report', () => {
  it('counts a gap with no samples as down time', () => {
    const s = [sample(0, true), sample(10, true), sample(20, true), sample(1000, true)];
    // Ready 0..40 (the last sample before the gap credits at most 2 intervals) and 1000..1010: 50 of 1010.
    expect(uptime(s, 10, 0, 1010)).toBeCloseTo(50 / 1010, 6);
    expect(uptime(s.map((x) => ({ ...x, ready: false })), 10, 0, 1010)).toBe(0);
  });
  const meta: RunMeta = { runId: 'r', label: 'rehearsal', commit: 'c0ffee', startedAt: 0, targetMs: 100, entry: 'e', plan: makePlan({ durationMs: 100, feeds: ['f'], restartWindowMs: 1, feedDropMs: 1 }) };
  const journal = checkJournal(good.join('\n'));
  const drills = [1, 2, 3].map((i) => ({ id: `restart-${i}`, kind: 'restart' as const, plannedAt: 0, at: 0, pass: true, midTrade: true, recoveredMs: 1, notes: [] }))
    .concat([{ id: 'feed-f', kind: 'feed' as never, plannedAt: 0, at: 0, pass: true, midTrade: undefined as never, recoveredMs: 1, notes: [], feed: 'f' } as never]);
  const samples = Array.from({ length: 11 }, (_, i) => sample(i * 10, true));
  it('passes every check on a clean run and labels the rehearsal', () => {
    const r = buildReport(meta, samples, 10, 100, journal, drills, []);
    expect(r.checks).toEqual(Object.fromEntries(Object.keys(r.checks).map((k) => [k, true])));
    expect(r.pass).toBe(true);
    expect(r.counts).toMatch(/Rehearsal: counts for none of §15 items 3, 4 or G3/);
    expect(r.counts).toMatch(/fails the 99% uptime check by design/);
    expect(reportMarkdown(r)).toContain('`c0ffee`');
  });
  it.each([
    ['stub worker', { samples: samples.map((s) => ({ ...s, stub: true })) }, 'real_worker'],
    ['recorder off', { samples: samples.map((s, i) => (i === 3 ? { ...s, recorder: false } : s)) }, 'recorder_and_simulation_from_start'],
    ['commit changed mid-run', { samples: samples.map((s, i) => (i > 5 ? { ...s, git_sha: 'beef' } : s)) }, 'one_commit'],
    ['only 2 mid-trade restarts', { drills: drills.map((d, i) => (i === 0 ? { ...d, midTrade: false } : d)) }, 'restart_drills'],
    ['uptime under 99%', { samples: samples.map((s, i) => (i === 4 ? { ...s, ready: false } : s)) }, 'uptime'],
    ['memory near the limit', { samples: samples.map((s) => ({ ...s, rss_bytes: 750 * 1024 * 1024 })) }, 'memory'],
    ['run cut short', { end: 50 }, 'duration'],
    ['feed names changed', { samples: samples.map((s, i) => (i === 7 ? { ...s, feeds: 'f,g' } : s)) }, 'feeds_fixed'],
  ])('fails on %s', (_, over: { samples?: Sample[]; drills?: typeof drills; end?: number }, check) => {
    const r = buildReport(meta, over.samples ?? samples, 10, over.end ?? 100, journal, over.drills ?? drills, []);
    expect(r.checks[check]).toBe(false);
    expect(r.pass).toBe(false);
  });
});

describe('fallback chain limits', () => {
  it('caps a run at 72 h and a chain at the jobs it needs plus 2', () => {
    expect(segmentAllowed(1, 48)).toBe(true);
    expect(segmentAllowed(11, 48)).toBe(true); // ceil(2880 / 335) = 9, plus 2
    expect(segmentAllowed(12, 48)).toBe(false);
    expect(segmentAllowed(1, 72)).toBe(true);
    expect(segmentAllowed(1, 73)).toBe(false);
    expect(segmentAllowed(0, 48)).toBe(false);
    expect(segmentAllowed(1.5, 48)).toBe(false);
    expect(segmentAllowed(1, Number.NaN)).toBe(false);
  });
});

describe('start health', () => {
  const h = { mode: 'paper', recorder: 'on', simulation: 'on', signing_key: false, feeds: { a: {} } } as unknown as Health;
  it('refuses recorder off, simulation off, a signing key, or no feeds', () => {
    expect(checkStartHealth(h).ok).toBe(true);
    expect(checkStartHealth({ ...h, recorder: 'off' }).problems).toEqual(['recorder off']);
    expect(checkStartHealth({ ...h, simulation: 'off' }).problems).toEqual(['simulation off']);
    expect(checkStartHealth({ ...h, signing_key: true } as unknown as Health).problems).toEqual(['a signing key is loaded']);
    expect(checkStartHealth({ ...h, feeds: {} }).problems).toEqual(['no feeds reported']);
  });
});

describe('secret scan', () => {
  const secret = 'hk_Zx9/+Qa=7&test-value';
  const secrets = new Map([['HELIUS_API_KEY', secret]]);
  it.each([
    ['raw', secret],
    ['in a URL', `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(secret)}`],
    ['base64', Buffer.from(secret).toString('base64')],
    ['base64url', Buffer.from(secret).toString('base64url')],
    ['hex', Buffer.from(secret).toString('hex')],
    ['JSON-escaped', JSON.stringify({ k: secret })],
  ])('finds the value %s', (_, text) => {
    expect(scanBuffer('f', Buffer.from(`x ${text} y`), secrets)).toEqual([{ path: 'f', what: 'HELIUS_API_KEY' }]);
  });
  it('looks inside gzip files', () => {
    expect(scanBuffer('f.gz', gzipSync(Buffer.from(secret)), secrets).map((f) => f.what)).toEqual(['HELIUS_API_KEY']);
  });
  it('finds a keypair-shaped array, and names only, never values', () => {
    const kp = JSON.stringify(Array.from({ length: 64 }, (_, i) => (i * 7) % 256));
    const f = scanBuffer('k.json', Buffer.from(kp), secrets);
    expect(f).toEqual([{ path: 'k.json', what: 'keypair-shaped array' }]);
    expect(JSON.stringify(f)).not.toContain(secret);
  });
  it('passes clean data, including 64-byte signatures in base58', () => {
    const clean = Buffer.from('{"sig":"5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW","n":[1,2,3]}');
    expect(scanBuffer('c', clean, secrets)).toEqual([]);
  });
});
