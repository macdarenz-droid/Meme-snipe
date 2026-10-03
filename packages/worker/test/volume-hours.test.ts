// FACTS-1d live chain volume: DATA-1c's `volume-hours-DAY.csv` release assets, checked against SHA256SUMS-DAY and
// ingested as `read:chain-volume-hour`. A missing or refused day ingests nothing (unknown), each day is read once, and
// the rows give the regime the same answer live as the backtest's replay of the same rows.
import { describe, expect, it } from 'vitest';
import { TRIAL_POLICY } from '../../core/src/config/index.ts';
import { VOLUME_SERIES_START_DAY } from '../../core/src/config/time.ts';
import { RAW, dailyChainVolume, producerOptions, type VolumeHour } from '../../core/src/facts/index.ts';
import { CURVE_VOLUME_KEY, parseCurveVolume, volumeCondition } from '../../core/src/gates/index.ts';
import { FactWorld, offchain } from '../../core/test/facts/helpers.ts';
import {
  FactReaders, FactRpc, VOLUME_HOURS_HEADER, VOLUME_RETRY_MS, dayName, dayNumber, parseVolumeHoursCsv, sha256Hex, type Ingest,
} from '../src/facts/index.ts';
import type { FrameBody } from '../src/providers/index.ts';
import type { HttpRequest, HttpResponse } from '../src/providers/http.ts';
import { GITHUB_RELEASES, HELIUS_FREE, ManualTimers, Scheduler } from '../src/scheduler/index.ts';
import { blockNetwork, settle } from './helpers.ts';

blockNetwork();

const DAY = 86_400_000;
const HOUR = 3_600_000;
const P = TRIAL_POLICY.regime;
const resp = (status: number, text: string): HttpResponse => ({ status, text, header: () => null }) as unknown as HttpResponse;
const csv = (day: number, lamports: (h: number) => bigint = (h) => BigInt(day % 13 + 1) * 1_000_000_000n + BigInt(h), skip: number[] = []) =>
  [VOLUME_HOURS_HEADER, ...Array.from({ length: 24 }, (_, h) => h).filter((h) => !skip.includes(h)).map((h) => `${day * DAY + h * HOUR},${lamports(h)}`)].join('\n') + '\n';

/** A fake release host: `assets` maps a day number to its CSV (absent: not published). */
const host = (assets: Map<number, string>, sums: (day: number, text: string) => string = (d, t) => `${sha256Hex(t)}  volume-hours-${dayName(d)}.csv\n`) => {
  const asked: string[] = [];
  const http = async (req: HttpRequest): Promise<HttpResponse> => {
    asked.push(req.url);
    const m = /\/releases\/download\/data-day-(\d{4}-\d{2}-\d{2})\/(.+)$/.exec(req.url);
    const day = m === null ? null : dayNumber(m[1]!);
    const text = day === null ? undefined : assets.get(day);
    if (m === null || day === null || text === undefined) return resp(404, 'Not Found');
    if (m[2] === `SHA256SUMS-${m[1]}`) return resp(200, sums(day, text));
    if (m[2] === `volume-hours-${m[1]}.csv`) return resp(200, text);
    return resp(404, 'Not Found');
  };
  return { http, asked };
};

const setup = (http: (req: HttpRequest) => Promise<HttpResponse>, start: number) => {
  const timers = new ManualTimers(start);
  const ingested: { body: FrameBody; receivedAt: number }[] = [];
  const feed: Ingest = { ingest: (_s, body, o) => ingested.push({ body, receivedAt: o.receivedAt }) };
  const rpc = new FactRpc({ url: () => 'x', http, scheduler: new Scheduler(HELIUS_FREE, { timers, creditsUsed: 0 }), timeoutMs: 1000 });
  const readers = new FactReaders({ feed, rpc, http, timers, timeoutMs: 1000, releases: { scheduler: new Scheduler(GITHUB_RELEASES, { timers, creditsUsed: 0 }), base: 'https://gh.test/r' } });
  const rows = () => ingested.filter((x) => x.body.type === 'offchain' && x.body.key === RAW.volumeHour).map((x) => (x.body as { value: VolumeHour }).value);
  return { timers, readers, ingested, rows };
};

const pump = async <T>(p: Promise<T>, timers: ManualTimers): Promise<T> => {
  let done = false;
  let out: T | undefined;
  void p.then((v) => { done = true; out = v; }, () => { done = true; });
  for (let k = 0; k < 5_000 && !done; k++) {
    await settle();
    timers.advance(500);
  }
  return out as T;
};

describe('volume-hours asset', () => {
  it('day names round-trip and the series start is 2026-07-20', () => {
    expect(dayName(VOLUME_SERIES_START_DAY)).toBe('2026-07-20');
    expect(dayNumber('2026-07-20')).toBe(VOLUME_SERIES_START_DAY);
    expect(dayNumber('2026-02-30')).toBeNull();
    expect(dayNumber('2026-7-20')).toBeNull();
  });

  it('parses covered hours; leaves out nothing it was given', () => {
    const d = VOLUME_SERIES_START_DAY + 10;
    const rows = parseVolumeHoursCsv(csv(d, () => 5n, [3]), dayName(d))!;
    expect(rows.length).toBe(23);
    expect(rows[0]).toEqual({ hourStartMs: d * DAY, lamports: 5n, covered: true });
    expect(rows.map((r) => r.hourStartMs)).not.toContain(d * DAY + 3 * HOUR);
    // An uncovered hour leaves the day unknown, never a smaller sum.
    expect(dailyChainVolume(rows)).toEqual([]);
    expect(dailyChainVolume(parseVolumeHoursCsv(csv(d, () => 5n), dayName(d))!)).toEqual([{ day: d, volumeLamports: 120n }]);
    expect(parseVolumeHoursCsv(csv(d).replace(/\n/g, '\r\n'), dayName(d))!.length).toBe(24);
  });

  it.each([
    ['a wrong header', (t: string) => t.replace(VOLUME_HOURS_HEADER, 'hour,lamports')],
    ['an hour of another day', (t: string) => t.replace(/\n(\d+),/, (_m, h: string) => `\n${Number(h) - HOUR},`)],
    ['an hour not on the hour', (t: string) => t.replace(/\n(\d+),/, (_m, h: string) => `\n${Number(h) + 1},`)],
    ['a repeated hour', (t: string) => t + t.split('\n')[1] + '\n'],
    ['a negative or decimal amount', (t: string) => t.replace(/,(\d+)\n/, ',-1\n')],
    ['an extra column', (t: string) => t.replace(/,(\d+)\n/, ',$1,1\n')],
    ['an amount above u64', (t: string) => t.replace(/,(\d+)\n/, ',18446744073709551616\n')],
    ['a blank line inside', (t: string) => t.replace('\n', '\n\n')],
    ['an hour with a leading zero', (t: string) => t.replace('\n', '\n0')],
    ['an hour in another notation', (t: string) => t.replace(/\n(\d+),/, (_m, h: string) => `\n${Number(h) / 1000}e3,`)],
  ])('refuses the whole asset with %s', (_name, mutate) => {
    const d = VOLUME_SERIES_START_DAY + 10;
    expect(parseVolumeHoursCsv(csv(d), dayName(d))).not.toBeNull();
    expect(parseVolumeHoursCsv(mutate(csv(d)), dayName(d))).toBeNull();
  });

  it('refuses a day name that is not a real date, even with no rows', () => {
    expect(parseVolumeHoursCsv(`${VOLUME_HOURS_HEADER}\n`, '2026-07-20')).toEqual([]);
    expect(parseVolumeHoursCsv(`${VOLUME_HOURS_HEADER}\n`, '2026-02-30')).toBeNull();
  });
});

describe('chain volume reader', () => {
  const today = VOLUME_SERIES_START_DAY + 40;
  const start = today * DAY + 15 * HOUR;
  const all = (from: number, to: number) => new Map(Array.from({ length: to - from + 1 }, (_, k) => [from + k, csv(from + k)]));

  it('reads every day from the series start to yesterday once, and ingests their rows', async () => {
    const h = host(all(VOLUME_SERIES_START_DAY, today - 1));
    const { readers, rows, timers } = setup(h.http, start);
    expect(await pump(readers.readChainVolume(P), timers)).toBe(true);
    expect(rows().length).toBe(40 * 24);
    expect(dailyChainVolume(rows()).map((d) => d.day)).toEqual(Array.from({ length: 40 }, (_, k) => VOLUME_SERIES_START_DAY + k));
    expect(h.asked.some((u) => u.includes(dayName(VOLUME_SERIES_START_DAY - 1)))).toBe(false);
    expect(h.asked.some((u) => u.includes(dayName(today)))).toBe(false);
    expect(h.asked.every((u) => u.startsWith('https://gh.test/r/releases/download/data-day-'))).toBe(true);
    const n = h.asked.length;
    expect(n).toBe(80);
    // A second read asks nothing for days already ingested.
    expect(await pump(readers.readChainVolume(P), timers)).toBe(true);
    expect(h.asked.length).toBe(n);
    expect(readers.outcomes.filter((o) => o.read.startsWith('chain-volume:')).every((o) => o.ok)).toBe(true);
  });

  it('starts at the 365-day cap plus the lag, not before', async () => {
    const t = VOLUME_SERIES_START_DAY + 500;
    const first = t - P.volumeLagDays - P.volumeWindowDays + 1;
    const h = host(all(first - 5, t - 1));
    const { readers, rows, timers } = setup(h.http, t * DAY + HOUR);
    expect(await pump(readers.readChainVolume(P), timers)).toBe(true);
    expect(Math.min(...rows().map((r) => r.hourStartMs))).toBe(first * DAY);
    expect(h.asked.some((u) => u.includes(dayName(first - 1)))).toBe(false);
  });

  it('a missing asset ingests nothing for that day (unknown) and is asked again only after VOLUME_RETRY_MS', async () => {
    const assets = all(VOLUME_SERIES_START_DAY, today - 1);
    const gone = today - 3;
    assets.delete(gone);
    const h = host(assets);
    const { readers, rows, timers } = setup(h.http, start);
    expect(await pump(readers.readChainVolume(P), timers)).toBe(false);
    expect(rows().some((r) => Math.floor(r.hourStartMs / DAY) === gone)).toBe(false);
    expect(readers.outcomes).toContainEqual(expect.objectContaining({ read: `chain-volume:${dayName(gone)}`, ok: false }));
    // The regime then has no volume for D-3: unknown, never zero.
    const v = { obs: { provider: 'x', slot: null, receivedAt: start, quality: [] }, days: dailyChainVolume(rows()) };
    expect(volumeCondition(v, start, P)).toEqual(expect.objectContaining({ ok: null, detail: `no curve volume for UTC day ${gone}` }));
    const n = h.asked.length;
    await pump(readers.readChainVolume(P), timers);
    expect(h.asked.length).toBe(n);
    // Published later: read on the next attempt after the retry interval.
    assets.set(gone, csv(gone));
    timers.advance(VOLUME_RETRY_MS);
    expect(await pump(readers.readChainVolume(P), timers)).toBe(true);
    expect(h.asked.filter((u) => u.includes(dayName(gone))).length).toBe(3);
    expect(dailyChainVolume(rows()).some((d) => d.day === gone)).toBe(true);
  });

  it.each([
    ['a checksum that does not match', 'checksum does not match', (d: number, t: string) => `${sha256Hex(t + 'x')}  volume-hours-${dayName(d)}.csv\n`],
    ['sums that do not list the asset', 'does not list', (d: number, t: string) => `${sha256Hex(t)}  units-${dayName(d)}.tar.part0\n`],
  ])('refuses a day with %s', async (_name, why, sums) => {
    const h = host(all(VOLUME_SERIES_START_DAY, today - 1), sums);
    const { readers, rows, timers } = setup(h.http, start);
    expect(await pump(readers.readChainVolume(P), timers)).toBe(false);
    expect(rows()).toEqual([]);
    expect(readers.outcomes.at(-1)).toEqual(expect.objectContaining({ ok: false, detail: expect.stringContaining(why) }));
  });

  it('a malformed asset ingests nothing', async () => {
    const assets = all(VOLUME_SERIES_START_DAY, today - 1);
    assets.set(today - 3, csv(today - 3).replace(VOLUME_HOURS_HEADER, 'x'));
    const { readers, rows, timers } = setup(host(assets).http, start);
    expect(await pump(readers.readChainVolume(P), timers)).toBe(false);
    expect(rows().some((r) => Math.floor(r.hourStartMs / DAY) === today - 3)).toBe(false);
    expect(rows().length).toBe(39 * 24);
    expect(readers.outcomes).toContainEqual(expect.objectContaining({ read: `chain-volume:${dayName(today - 3)}`, ok: false, detail: expect.stringContaining('malformed asset') }));
  });

  it('without a release source it reads nothing', async () => {
    const timers = new ManualTimers(start);
    const http = async () => resp(500, '');
    const rpc = new FactRpc({ url: () => 'x', http, scheduler: new Scheduler(HELIUS_FREE, { timers, creditsUsed: 0 }), timeoutMs: 1000 });
    expect(await new FactReaders({ feed: { ingest: () => undefined }, rpc, http, timers, timeoutMs: 1000 }).readChainVolume(P)).toBe(false);
  });

  it('live and backtest parity: the same rows give the same curve-volume fact and regime volume condition', async () => {
    const h = host(all(VOLUME_SERIES_START_DAY, today - 1));
    const live = setup(h.http, start);
    await pump(live.readers.readChainVolume(P), live.timers);
    const opts = producerOptions(TRIAL_POLICY);
    // Live: the rows as the reader ingested them, at their receipt time.
    const lw = new FactWorld(opts);
    live.ingested.forEach((x, i) => lw.push(offchain(RAW.volumeHour, (x.body as { value: unknown }).value, BigInt(1 + i), x.receivedAt, 'github')));
    // Backtest: the same asset rows parsed from the release, each released as its hour ends.
    const bw = new FactWorld(opts);
    const rows = [...all(VOLUME_SERIES_START_DAY, today - 1)].flatMap(([d, t]) => parseVolumeHoursCsv(t, dayName(d))!);
    rows.forEach((r, i) => bw.push(offchain(RAW.volumeHour, r, BigInt(1 + i), r.hourStartMs + HOUR)));
    const lf = parseCurveVolume(lw.last(CURVE_VOLUME_KEY))!;
    const bf = parseCurveVolume(bw.last(CURVE_VOLUME_KEY))!;
    expect(lf.days).toEqual(bf.days);
    expect(lf.days.length).toBe(40);
    const at = live.timers.now();
    const c = volumeCondition(lf, at, P);
    expect(c.ok).not.toBeNull();
    expect(c).toEqual(volumeCondition(bf, at, P));
  });
});
