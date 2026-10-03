// FACTS-1d live chain volume: DATA-1c's `data-volume-DAY` releases (`volume-check-DAY.json` must pass, then
// `volume-hours-DAY.csv`) ingested as `read:chain-volume-hour`. A missing or refused day ingests nothing (unknown), each
// day is read once, and the rows give the regime the same answer live as the backtest's replay of the same rows.
import { describe, expect, it } from 'vitest';
import { TRIAL_POLICY } from '../../core/src/config/index.ts';
import { VOLUME_SERIES_START_DAY } from '../../core/src/config/time.ts';
import { RAW, VOLUME_HOURS_HEADER, dailyChainVolume, parseVolumeHoursCsv, producerOptions, type VolumeHour } from '../../core/src/facts/index.ts';
import { CURVE_VOLUME_KEY, parseCurveVolume, volumeCondition } from '../../core/src/gates/index.ts';
import { FactWorld, offchain } from '../../core/test/facts/helpers.ts';
import {
  ACTIONS_BOT, FactReaders, FactRpc, VOLUME_RETRY_MS, dayName, dayNumber, volumeCheckPassed, volumeReleaseAssets, type Ingest,
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
const csv = (day: number, lamports: (h: number) => bigint = (h) => BigInt(day % 13 + 1) * 1_000_000_000n + BigInt(h), uncovered: number[] = []) =>
  [VOLUME_HOURS_HEADER, ...Array.from({ length: 24 }, (_, h) => `${day * DAY + h * HOUR},${lamports(h)},${uncovered.includes(h) ? 0 : 1}`)].join('\n') + '\n';
const passed = (d: number) => JSON.stringify({ day: dayName(d), hours: 24, hours_covered: 24, hours_matched: 24, lamports_total: '1', mismatches: [], problems: [] });
const BOT = { login: ACTIONS_BOT.login, id: ACTIONS_BOT.id, type: 'Bot' };
type Release = Record<string, unknown> & { assets: Record<string, unknown>[] };
/** The GitHub API's release answer for day `d`, as GitHub Actions publishes it (ids: day*10+1 the CSV, +2 the check). */
const release = (d: number): Release => ({
  tag_name: `data-volume-${dayName(d)}`, author: BOT, draft: false, prerelease: false,
  assets: [
    { id: d * 10 + 1, name: `volume-hours-${dayName(d)}.csv`, state: 'uploaded', uploader: BOT },
    { id: d * 10 + 2, name: `volume-check-${dayName(d)}.json`, state: 'uploaded', uploader: BOT },
  ],
});

/**
 * A fake GitHub API: `assets` maps a day number to its CSV (absent: no release). `asked` names each request as
 * `release|hours|check:DAY`; `edit` changes a release answer, `check` the check file.
 */
const host = (assets: Map<number, string>, o: { check?: (d: number) => string; edit?: (r: Release, d: number) => Release; limitAfter?: number } = {}) => {
  const asked: string[] = [];
  const urls: string[] = [];
  const http = async (req: HttpRequest): Promise<HttpResponse> => {
    urls.push(req.url);
    if (o.limitAfter !== undefined && urls.length > o.limitAfter) return resp(403, '{"message":"API rate limit exceeded"}');
    const t = /^https:\/\/gh\.test\/r\/releases\/tags\/data-volume-(\d{4}-\d{2}-\d{2})$/.exec(req.url);
    if (t !== null) {
      const d = dayNumber(t[1]!)!;
      asked.push(`release:${t[1]}`);
      expect(req.headers?.['accept']).toBe('application/vnd.github+json');
      return assets.has(d) ? resp(200, JSON.stringify((o.edit ?? ((r) => r))(release(d), d))) : resp(404, '{"message":"Not Found"}');
    }
    const a = /^https:\/\/gh\.test\/r\/releases\/assets\/(\d+)$/.exec(req.url);
    if (a === null) return resp(404, '');
    expect(req.headers?.['accept']).toBe('application/octet-stream');
    const id = Number(a[1]);
    const d = Math.floor(id / 10);
    asked.push(`${id % 10 === 1 ? 'hours' : 'check'}:${dayName(d)}`);
    const text = assets.get(d);
    if (text === undefined) return resp(404, '');
    return resp(200, id % 10 === 1 ? text : (o.check ?? passed)(d));
  };
  return { http, asked, urls };
};

/** A window wide enough that tests are not throttled; the real limit has its own test. */
const UNTHROTTLED = { ...GITHUB_RELEASES, window: { limit: 10_000, windowMs: 3_600_000 } };

const setup = (http: (req: HttpRequest) => Promise<HttpResponse>, start: number, spec = UNTHROTTLED) => {
  const timers = new ManualTimers(start);
  const ingested: { body: FrameBody; receivedAt: number }[] = [];
  const feed: Ingest = { ingest: (_s, body, o) => ingested.push({ body, receivedAt: o.receivedAt }) };
  const rpc = new FactRpc({ url: () => 'x', http, scheduler: new Scheduler(HELIUS_FREE, { timers, creditsUsed: 0 }), timeoutMs: 1000 });
  const readers = new FactReaders({ feed, rpc, http, timers, timeoutMs: 1000, releases: { scheduler: new Scheduler(spec, { timers, creditsUsed: 0 }), base: 'https://gh.test/r' } });
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

describe('volume-hours release', () => {
  it('day names round-trip and the series start is 2026-07-20', () => {
    expect(dayName(VOLUME_SERIES_START_DAY)).toBe('2026-07-20');
    expect(dayNumber('2026-07-20')).toBe(VOLUME_SERIES_START_DAY);
    expect(dayNumber('2026-02-30')).toBeNull();
    expect(dayNumber('2026-7-20')).toBeNull();
  });

  it('the cross-check passes only for the day read, 24 hours, and empty mismatches and problems', () => {
    const d = VOLUME_SERIES_START_DAY + 5;
    const ok = JSON.parse(passed(d)) as Record<string, unknown>;
    const with_ = (x: Record<string, unknown>) => JSON.stringify({ ...ok, ...x });
    expect(volumeCheckPassed(passed(d), dayName(d))).toBe(true);
    expect(volumeCheckPassed(passed(d), dayName(d + 1))).toBe(false);
    expect(volumeCheckPassed(with_({ hours: 23 }), dayName(d))).toBe(false);
    expect(volumeCheckPassed(with_({ hours: '24' }), dayName(d))).toBe(false);
    expect(volumeCheckPassed(with_({ day: undefined }), dayName(d))).toBe(false);
    expect(volumeCheckPassed(with_({ mismatches: [{ hour: 1 }] }), dayName(d))).toBe(false);
    expect(volumeCheckPassed(with_({ problems: ['gap'] }), dayName(d))).toBe(false);
    expect(volumeCheckPassed(with_({ mismatches: undefined }), dayName(d))).toBe(false);
    expect(volumeCheckPassed(with_({ problems: undefined }), dayName(d))).toBe(false);
    expect(volumeCheckPassed('[]', dayName(d))).toBe(false);
    expect(volumeCheckPassed('null', dayName(d))).toBe(false);
    expect(volumeCheckPassed('not json', dayName(d))).toBe(false);
  });

  it('release provenance: only GitHub Actions\' own published release with both assets uploaded by it', () => {
    const d = VOLUME_SERIES_START_DAY + 5;
    const name = dayName(d);
    const json = (f: (r: Release) => Release = (r) => r) => JSON.stringify(f(release(d)));
    const other = { login: 'someone', id: 1, type: 'User' };
    expect(volumeReleaseAssets(json(), name)).toEqual({ hours: d * 10 + 1, check: d * 10 + 2 });
    expect(volumeReleaseAssets(json(), dayName(d + 1))).toBeNull();
    const refused: [string, (r: Release) => Release][] = [
      ['another author', (r) => ({ ...r, author: other })],
      ['an author with the bot\'s login but another id', (r) => ({ ...r, author: { ...BOT, id: 2 } })],
      ['an author with the bot\'s id but another login', (r) => ({ ...r, author: { ...BOT, login: 'github-actions' } })],
      ['no author', (r) => ({ ...r, author: null })],
      ['a draft', (r) => ({ ...r, draft: true })],
      ['a prerelease', (r) => ({ ...r, prerelease: true })],
      ['another tag', (r) => ({ ...r, tag_name: `data-day-${name}` })],
      ['the CSV uploaded by another account', (r) => ({ ...r, assets: [{ ...r.assets[0]!, uploader: other }, r.assets[1]!] })],
      ['the check uploaded by another account', (r) => ({ ...r, assets: [r.assets[0]!, { ...r.assets[1]!, uploader: other }] })],
      ['an asset not fully uploaded', (r) => ({ ...r, assets: [{ ...r.assets[0]!, state: 'starter' }, r.assets[1]!] })],
      ['a second asset with the same name', (r) => ({ ...r, assets: [...r.assets, { ...r.assets[0]!, id: 9 }] })],
      ['no CSV', (r) => ({ ...r, assets: [r.assets[1]!] })],
      ['no check', (r) => ({ ...r, assets: [r.assets[0]!] })],
      ['an asset without an id', (r) => ({ ...r, assets: [{ ...r.assets[0]!, id: '1' }, r.assets[1]!] })],
      ['an asset id of zero', (r) => ({ ...r, assets: [{ ...r.assets[0]!, id: 0 }, r.assets[1]!] })],
      ['no asset list', (r) => ({ ...r, assets: undefined as unknown as Release['assets'] })],
    ];
    for (const [why, f] of refused) expect(volumeReleaseAssets(json(f), name), why).toBeNull();
    expect(volumeReleaseAssets('not json', name)).toBeNull();
    expect(volumeReleaseAssets('[]', name)).toBeNull();
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
    expect(h.asked.some((u) => u.endsWith(dayName(VOLUME_SERIES_START_DAY - 1)))).toBe(false);
    expect(h.asked.some((u) => u.endsWith(dayName(today)))).toBe(false);
    expect(h.asked.slice(0, 3)).toEqual([`release:2026-07-20`, `check:2026-07-20`, `hours:2026-07-20`]);
    const n = h.asked.length;
    expect(n).toBe(120);
    expect(h.asked.filter((u) => u.startsWith('release:')).length).toBe(40);
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
    expect(h.asked.some((u) => u.endsWith(dayName(first - 1)))).toBe(false);
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
    expect(h.asked.filter((u) => u.endsWith(dayName(gone)))).toEqual([`release:${dayName(gone)}`, `release:${dayName(gone)}`, `check:${dayName(gone)}`, `hours:${dayName(gone)}`]);
    expect(dailyChainVolume(rows()).some((d) => d.day === gone)).toBe(true);
  });

  it.each([
    ['a failed cross-check', 'did not pass', { check: (d: number) => passed(d).replace('"mismatches":[]', '"mismatches":[{"hour":3}]') }],
    ['a malformed cross-check', 'did not pass', { check: () => '<html>' }],
    ['a cross-check of another day', 'did not pass', { check: (d: number) => passed(d + 1) }],
    ['a cross-check of fewer hours', 'did not pass', { check: (d: number) => passed(d).replace('"hours":24', '"hours":23') }],
    ['a release by another author', 'provenance', { edit: (r: Release) => ({ ...r, author: { login: 'mallory', id: 7, type: 'User' } }) }],
    ['an asset uploaded by another account', 'provenance', { edit: (r: Release) => ({ ...r, assets: [{ ...r.assets[0]!, uploader: { login: 'mallory', id: 7, type: 'User' } }, r.assets[1]!] }) }],
    ['a draft or prerelease', 'provenance', { edit: (r: Release, d: number) => ({ ...r, prerelease: d % 2 === 0, draft: d % 2 === 1 }) }],
  ])('refuses every day with %s: nothing ingested, unknown', async (_name, why, o) => {
    const h = host(all(VOLUME_SERIES_START_DAY, today - 1), o);
    const { readers, rows, timers } = setup(h.http, start);
    expect(await pump(readers.readChainVolume(P), timers)).toBe(false);
    expect(rows()).toEqual([]);
    expect(readers.outcomes.at(-1)).toEqual(expect.objectContaining({ ok: false, detail: expect.stringContaining(why) }));
    // A refused release is never downloaded from.
    if (why === 'provenance') expect(h.asked.every((u) => u.startsWith('release:'))).toBe(true);
  });

  it('the real limit (50 an hour) ends a pass early; the next pass after an hour goes on where it stopped', async () => {
    const h = host(all(VOLUME_SERIES_START_DAY, today - 1));
    const { readers, rows, timers } = setup(h.http, start, GITHUB_RELEASES);
    expect(await pump(readers.readChainVolume(P), timers)).toBe(false);
    expect(h.urls.length).toBe(50);
    const first = dailyChainVolume(rows()).length;
    expect(first).toBe(16);
    // The pass stopped at the refusal: one day failed, the rest were not tried.
    expect(readers.outcomes.filter((x) => !x.ok).length).toBe(1);
    timers.advance(VOLUME_RETRY_MS);
    expect(await pump(readers.readChainVolume(P), timers)).toBe(false);
    expect(dailyChainVolume(rows()).length).toBeGreaterThan(first);
    for (let k = 0; k < 3; k++) {
      timers.advance(VOLUME_RETRY_MS);
      await pump(readers.readChainVolume(P), timers);
    }
    expect(dailyChainVolume(rows()).length).toBe(40);
  });

  it('a 403 rate limit from GitHub ends the pass at once', async () => {
    const h = host(all(VOLUME_SERIES_START_DAY, today - 1), { limitAfter: 7 });
    const { readers, rows, timers } = setup(h.http, start);
    expect(await pump(readers.readChainVolume(P), timers)).toBe(false);
    expect(h.urls.length).toBe(8);
    expect(dailyChainVolume(rows()).length).toBe(2);
    expect(readers.outcomes.filter((x) => !x.ok).length).toBe(1);
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

  it('an uncovered hour is ingested as uncovered: the day stays unknown, the others are kept', async () => {
    const assets = all(VOLUME_SERIES_START_DAY, today - 1);
    assets.set(today - 3, csv(today - 3, () => 7n, [11]));
    const { readers, rows, timers } = setup(host(assets).http, start);
    expect(await pump(readers.readChainVolume(P), timers)).toBe(true);
    expect(rows().find((r) => r.hourStartMs === (today - 3) * DAY + 11 * HOUR)).toEqual({ hourStartMs: (today - 3) * DAY + 11 * HOUR, lamports: 7n, covered: false });
    const days = dailyChainVolume(rows());
    expect(days.length).toBe(39);
    expect(days.some((d) => d.day === today - 3)).toBe(false);
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
    const rows = [...all(VOLUME_SERIES_START_DAY, today - 1)].flatMap(([d, t]) => parseVolumeHoursCsv(t, d)!);
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
