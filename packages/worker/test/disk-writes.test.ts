// DISK-GUARD: the worker's own appends on a full disk. The journal and the deployer index's saved file count a line
// that does not fit instead of throwing (the worker keeps exiting positions), and say what they lost once there is room:
// a journal `coverage_gap` line the runner reads as missing evidence, and a bounded coverage gap that keeps H14 uncovered across
// the lost range after a restart.
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AsOfStore, SimClock, type MarketEvent, type Moment } from '../../core/src/engine/index.ts';
import { createsCoverage } from '../../core/src/gates/index.ts';
import { checkJournal } from '../../runner/src/journal.ts';
import { DeployerStore, STORE_GAP_VIA } from '../src/run/deployer-store.ts';
import { Journal } from '../src/run/journal.ts';

const tmp = mkdtempSync(join(tmpdir(), 'zeroed-disk-writes-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const dir = (): string => mkdtempSync(join(tmp, `d${(n += 1)}-`));

const enospc = (): Error => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
/** An append that fails with ENOSPC while `full.on`; with `full.part`, it first writes that many characters (a short write). */
const appendWith = (full: { on: boolean; part?: number }) => (path: string, text: string): void => {
  if (!full.on) return appendFileSync(path, text);
  if (full.part !== undefined) appendFileSync(path, text.slice(0, full.part));
  throw enospc();
};
const lines = (path: string) => readFileSync(path, 'utf8').split('\n').filter((l) => l !== '');

describe('journal on a full disk', () => {
  it('counts lines that do not fit, consumes seqs, and writes a coverage_gap before the next line that fits', () => {
    const path = join(dir(), 'journal.jsonl');
    const full = { on: false };
    let told = 0;
    let now = Date.parse('2026-10-05T01:00:00Z');
    const j = new Journal(path, 'b1', () => now, { append: appendWith(full), onNoSpace: () => (told += 1) });
    j.write('start', {});
    full.on = true;
    now += 1000;
    j.write('decision', { reasons: ['a'] });
    j.write('decision', { reasons: ['b'] });
    expect(j.seq).toBe(3);
    expect(j.failing).toBe(true);
    expect(told).toBe(1);
    full.on = false;
    now += 1000;
    j.write('decision', { reasons: ['c'] });
    expect(j.failing).toBe(false);
    const got = lines(path).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(got.map((l) => [l['seq'], l['kind']])).toEqual([[1, 'start'], [4, 'coverage_gap'], [5, 'decision']]);
    expect(got[1]).toMatchObject({ stream: 'journal', lost: 2, known_lost: 2, from_seq: 2, to_seq: 3, from_ts: '2026-10-05T01:00:01.000Z', to_ts: '2026-10-05T01:00:02.000Z', reason: 'journal events not written: no space left on device' });
    // The runner reports both the consumed sequence gap and the explicit missing evidence.
    const r = checkJournal(readFileSync(path, 'utf8'));
    expect(r.complete).toBe(false);
    expect(r.problems).toEqual(['seq 4 where 2 expected', 'seq 4: journal evidence missing (2 events)']);
    expect(new Journal(path, 'b2', () => now).seq).toBe(5);
  });

  it('retry writes the pending gap alone once there is room, and nothing when none is pending', () => {
    const path = join(dir(), 'journal.jsonl');
    const full = { on: false };
    const j = new Journal(path, 'b1', () => 0, { append: appendWith(full) });
    expect(j.retry()).toBe(true);
    j.write('start', {});
    full.on = true;
    j.write('stop', {});
    expect(j.retry()).toBe(false);
    full.on = false;
    expect(j.retry()).toBe(true);
    expect(lines(path).map((l) => (JSON.parse(l) as { kind: string }).kind)).toEqual(['start', 'coverage_gap']);
  });

  it('a short write leaves a fragment: the gap starts on its own line, so the next lines stay whole', () => {
    const path = join(dir(), 'journal.jsonl');
    const full = { on: false, part: 10 };
    const j = new Journal(path, 'b1', () => 0, { append: appendWith(full) });
    j.write('start', {});
    full.on = true;
    j.write('decision', { reasons: ['a'] });
    full.on = false;
    j.write('stop', {});
    const raw = lines(path);
    expect(raw).toHaveLength(3);
    const got = raw.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(got.map((l) => [l['seq'], l['kind']])).toEqual([[1, 'start'], [3, 'coverage_gap'], [4, 'stop']]);
    expect(got[1]).toMatchObject({ stream: 'journal', lost: 1, known_lost: 1, from_seq: 2, to_seq: 2 });
    // The short fragment is repaired and every surviving line parses; restart keeps consumed seqs.
    expect(new Journal(path, 'b2', () => 0).seq).toBe(4);
  });

  it('any other write error is thrown as before', () => {
    const path = join(dir(), 'journal.jsonl');
    const j = new Journal(path, 'b1', () => 0, {
      append: () => {
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      },
    });
    expect(() => j.write('start', {})).toThrow('EIO');
    expect(j.failing).toBe(false);
  });
});

const at = (slot: bigint, receivedAt: number): Moment => ({ slot, txIndex: 0, ixIndex: 0, receivedAt });
const DAY = 86_400_000;
const T0 = Date.parse('2026-10-01T00:00:00Z');
const create = (k: number, m: Moment): MarketEvent => ({
  kind: 'market', id: `c${k}`, moment: m, key: `pump:CreateEvent:sig${k}`,
  value: { event: { name: 'CreateEvent', program: 'pump', data: { mint: `M${k}`, creator: 'D', timestamp: Math.floor(m.receivedAt / 1000) } } },
});
const start: MarketEvent = { kind: 'market', id: 's', moment: at(1n, T0), key: 'coverage:creates:start', value: { value: { fromSlot: 1n, via: 'logs:pump' }, source: 'worker', backfilled: false, seq: 0 } };

/** H14's coverage from saved coverage facts, as the seeded engine reads them. */
const coverageOf = (saved: readonly MarketEvent[], now: Moment, windowStartMs: number) => {
  const clock = new SimClock({ slot: 0n, txIndex: 0, ixIndex: 0, receivedAt: Number.MIN_SAFE_INTEGER });
  const store = new AsOfStore(clock);
  for (const e of saved) {
    clock.advanceTo(e.moment);
    store.record(e.key, e.value, e.moment, e.id);
  }
  clock.advanceTo(now);
  return createsCoverage((k, f, t) => store.history(k, f, t), now, windowStartMs);
};

describe('deployer index file on a full disk', () => {
  it('counts lines that do not fit, then saves bounded creates and rugs gaps over the lost range before the next line', () => {
    const d = dir();
    const full = { on: false };
    let told = 0;
    const s = new DeployerStore(d, undefined, { append: appendWith(full), onNoSpace: () => (told += 1) });
    s.keep(start);
    s.keep(create(1, at(100n, T0 + DAY)));
    full.on = true;
    s.keep(create(2, at(200n, T0 + 2 * DAY)));
    s.keep(create(3, at(300n, T0 + 3 * DAY)));
    expect(s.failing).toBe(true);
    expect(told).toBe(2);
    full.on = false;
    s.keep(create(4, at(400n, T0 + 4 * DAY)));
    expect(s.failing).toBe(true);
    const saved = new DeployerStore(d).load(0);
    expect(saved.creates.map((e) => e.id)).toEqual(['c1', 'c4']);
    const gaps = saved.coverage.filter((e) => e.key.endsWith(':gap') && (e.value as { value: { toSlot: bigint | null } }).value.toSlot !== null);
    expect(saved.coverage.filter((e) => e.key.endsWith(':gap') && (e.value as { value: { toSlot: bigint | null } }).value.toSlot === null).map((e) => e.key)).toEqual(['coverage:creates:gap', 'coverage:rugs:gap']);
    expect(gaps.map((e) => e.key)).toEqual(['coverage:creates:gap', 'coverage:rugs:gap']);
    for (const g of gaps) {
      expect(g.moment).toEqual(at(400n, T0 + 4 * DAY));
      expect(g.value).toEqual({ value: { fromSlot: 200n, toSlot: 400n, reason: '2 saved line(s) lost: no space left on the device', via: STORE_GAP_VIA }, source: 'worker', backfilled: false, seq: 0 });
    }
    // Seeded from this file, H14 is not covered for a window that holds the gap, and covered again once the look-back
    // passes it.
    expect(coverageOf(saved.coverage, at(500n, T0 + 5 * DAY), T0 + DAY / 2)).toEqual({ covered: false, detail: expect.stringContaining(`${STORE_GAP_VIA}-uncertain`) });
    expect(coverageOf(saved.coverage, at(500n, T0 + 20 * DAY), T0 + 5 * DAY)).toEqual({ covered: false, detail: expect.stringContaining(`${STORE_GAP_VIA}-uncertain`) });
    // Without the loss the same window is covered: the gap is what makes it not.
    expect(coverageOf([start], at(500n, T0 + 5 * DAY), T0 + DAY / 2)).toEqual({ covered: true, fromMs: T0 });
  });

  it('a short write leaves a fragment: load skips it and keeps the gaps and the lines after it', () => {
    const d = dir();
    const full = { on: false, part: 15 };
    const s = new DeployerStore(d, undefined, { append: appendWith(full) });
    s.keep(start);
    full.on = true;
    s.keep(create(2, at(200n, T0 + 2 * DAY)));
    full.on = false;
    s.keep(create(3, at(300n, T0 + 3 * DAY)));
    s.keep(create(4, at(400n, T0 + 4 * DAY)));
    const saved = new DeployerStore(d).load(0);
    expect(saved.creates.map((e) => e.id)).toEqual(['c3', 'c4']);
    expect(saved.coverage.filter((e) => e.key.endsWith(':gap') && (e.value as { value: { toSlot: bigint | null } }).value.toSlot !== null).map((e) => (e.value as { value: { fromSlot: bigint; toSlot: bigint } }).value)).toEqual([
      expect.objectContaining({ fromSlot: 200n, toSlot: 300n }), expect.objectContaining({ fromSlot: 200n, toSlot: 300n }),
    ]);
  });

  it('events the index does not read are not written, and any other write error is thrown as before', () => {
    const d = dir();
    const s = new DeployerStore(d, undefined, {
      append: () => {
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      },
    });
    s.keep({ kind: 'market', id: 'x', moment: at(1n, T0), key: 'chain:slot', value: { slot: 1n } });
    expect(() => s.keep(create(1, at(100n, T0)))).toThrow('EIO');
    expect(s.failing).toBe(true);
    expect(new DeployerStore(d).failing).toBe(true);
  });

  it('cut to the look-back keeps every coverage fact and the creates inside it', () => {
    const d = dir();
    const s = new DeployerStore(d);
    s.keep(start);
    for (let k = 1; k <= 5; k++) s.keep(create(k, at(BigInt(k * 100), T0 + k * DAY)));
    const before = readFileSync(join(d, 'deployers.jsonl'), 'utf8').length;
    s.load(T0 + 3 * DAY, { keepCreates: false });
    expect(readFileSync(join(d, 'deployers.jsonl'), 'utf8').length).toBeLessThan(before);
    expect(new DeployerStore(d).load(0).creates.map((e) => e.id)).toEqual(['c3', 'c4', 'c5']);
    expect(new DeployerStore(d).load(0).coverage.map((e) => e.id)).toEqual(['s']);
  });
});
