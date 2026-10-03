// FACTS-1d live chain volume: DATA-1c's `data-volume-DAY` releases, listed through the GitHub API (provenance checked),
// downloaded from github.com against their sha256 digests, ingested as `read:chain-volume-hour` and kept in the state
// dir. A missing, refused or tampered day ingests nothing usable (unknown), a restart reads only new days, and the rows
// give the regime the same answer live as the backtest's replay of the same rows.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRIAL_POLICY } from '../../core/src/config/index.ts';
import { VOLUME_SERIES_START_DAY } from '../../core/src/config/time.ts';
import { RAW, VOLUME_HOURS_HEADER, dailyChainVolume, parseVolumeHoursCsv, producerOptions, type VolumeHour } from '../../core/src/facts/index.ts';
import { CURVE_VOLUME_KEY, parseCurveVolume, volumeCondition } from '../../core/src/gates/index.ts';
import { FactWorld, offchain } from '../../core/test/facts/helpers.ts';
import {
  ACTIONS_BOT, FactReaders, FactRpc, VOLUME_RETRY_MS, dayName, dayNumber, fileChainVolumeStore, sha256Hex, volumeCheckPassed, volumeReleaseAssets,
  type ChainVolumeStore, type Ingest, type StoredVolumeDay,
} from '../src/facts/index.ts';
import type { FrameBody } from '../src/providers/index.ts';
import type { HttpRequest, HttpResponse } from '../src/providers/http.ts';
import { GITHUB_DOWNLOADS, GITHUB_RELEASES, HELIUS_FREE, ManualTimers, Scheduler } from '../src/scheduler/index.ts';
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
const API = 'https://api.test/r';
const WEB = 'https://gh.test/r';
type Release = Record<string, unknown> & { assets: Record<string, unknown>[] };
const url = (d: number, name: string) => `${WEB}/releases/download/data-volume-${dayName(d)}/${name}`;
/** The API's release object for day `d` as GitHub Actions publishes it (ids: day*10+1 the CSV, +2 the check). */
const release = (d: number, csvText: string, checkText: string = passed(d)): Release => ({
  tag_name: `data-volume-${dayName(d)}`, author: BOT, draft: false, prerelease: true,
  assets: [
    { id: d * 10 + 1, name: `volume-hours-${dayName(d)}.csv`, state: 'uploaded', uploader: BOT, digest: `sha256:${sha256Hex(csvText)}`, browser_download_url: url(d, `volume-hours-${dayName(d)}.csv`) },
    { id: d * 10 + 2, name: `volume-check-${dayName(d)}.json`, state: 'uploaded', uploader: BOT, digest: `sha256:${sha256Hex(checkText)}`, browser_download_url: url(d, `volume-check-${dayName(d)}.json`) },
  ],
});

interface HostOptions {
  /** The check file served for a day (default: passed). */
  readonly check?: (d: number) => string;
  /** Changes a listed release. */
  readonly edit?: (r: Release, d: number) => Release;
  /** Changes the bytes served for an asset after its digest was listed. */
  readonly serve?: (text: string, d: number, name: string) => string;
  /** Other releases listed before the volume ones (data-day, preview...). */
  readonly others?: number;
  /** API requests answered before a 403 rate limit. */
  readonly limitAfter?: number;
}

/** A fake GitHub: `assets` maps a day number to its CSV (absent: not published). `asked` names each request. */
const host = (assets: Map<number, string>, o: HostOptions = {}) => {
  const asked: string[] = [];
  let api = 0;
  const http = async (req: HttpRequest): Promise<HttpResponse> => {
    const l = /^https:\/\/api\.test\/r\/releases\?per_page=100&page=(\d+)$/.exec(req.url);
    if (l !== null) {
      asked.push(`list:${l[1]}`);
      api++;
      if (o.limitAfter !== undefined && api > o.limitAfter) return resp(403, '{"message":"API rate limit exceeded"}');
      expect(req.headers?.['accept']).toBe('application/vnd.github+json');
      const all = [
        ...Array.from({ length: o.others ?? 0 }, (_, k) => ({ tag_name: `data-day-x${k}`, author: BOT, draft: false, prerelease: true, assets: [] })),
        ...[...assets].sort((a, b) => b[0] - a[0]).map(([d, t]) => (o.edit ?? ((r) => r))(release(d, t, (o.check ?? passed)(d)), d)),
      ];
      const page = Number(l[1]);
      return resp(200, JSON.stringify(all.slice((page - 1) * 100, page * 100)));
    }
    const g = /^https:\/\/gh\.test\/r\/releases\/download\/data-volume-(\d{4}-\d{2}-\d{2})\/(volume-(hours|check)-\d{4}-\d{2}-\d{2}\.(csv|json))$/.exec(req.url);
    if (g === null) return resp(404, '');
    const d = dayNumber(g[1]!)!;
    asked.push(`${g[3]}:${g[1]}`);
    const csvText = assets.get(d);
    if (csvText === undefined) return resp(404, '');
    const text = g[3] === 'hours' ? csvText : (o.check ?? passed)(d);
    return resp(200, (o.serve ?? ((t) => t))(text, d, g[2]!));
  };
  return { http, asked, apiCalls: () => api };
};

/** A window wide enough that tests are not throttled; the real limits have their own test. */
const UNTHROTTLED = { window: { limit: 10_000, windowMs: 3_600_000 } };

const memoryStore = (): ChainVolumeStore & { readonly days: Map<string, StoredVolumeDay> } => {
  const days = new Map<string, StoredVolumeDay>();
  return { days, load: () => [...days.values()].map((d) => structuredClone(d)), save: (d) => void days.set(d.tag, structuredClone(d)) };
};

const setup = (http: (req: HttpRequest) => Promise<HttpResponse>, start: number, o: { real?: boolean; store?: ChainVolumeStore; alerts?: string[]; timers?: ManualTimers } = {}) => {
  const timers = o.timers ?? new ManualTimers(start);
  const ingested: { body: FrameBody; receivedAt: number }[] = [];
  const feed: Ingest = { ingest: (_s, body, x) => ingested.push({ body, receivedAt: x.receivedAt }) };
  const rpc = new FactRpc({ url: () => 'x', http, scheduler: new Scheduler(HELIUS_FREE, { timers, creditsUsed: 0 }), timeoutMs: 1000 });
  const sched = (spec: typeof GITHUB_RELEASES) => new Scheduler(o.real === true ? spec : { ...spec, ...UNTHROTTLED }, { timers, creditsUsed: 0 });
  const readers = new FactReaders({
    feed, rpc, http, timers, timeoutMs: 1000,
    releases: {
      api: { scheduler: sched(GITHUB_RELEASES), base: API }, downloads: { scheduler: sched(GITHUB_DOWNLOADS), base: WEB },
      ...(o.store === undefined ? {} : { store: o.store }), ...(o.alerts === undefined ? {} : { alert: (d: string) => void o.alerts!.push(d) }),
    },
  });
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

  it('release provenance: only GitHub Actions\' own published prerelease, both assets uploaded by it, with digests and this repository\'s download URLs', () => {
    const d = VOLUME_SERIES_START_DAY + 5;
    const name = dayName(d);
    const r0 = release(d, 'csv', 'check');
    const other = { login: 'someone', id: 1, type: 'User' };
    const asset = (k: 0 | 1, x: Record<string, unknown>) => (r: Release): Release => ({ ...r, assets: r.assets.map((a, i) => (i === k ? { ...a, ...x } : a)) });
    expect(volumeReleaseAssets(r0, name, WEB)).toEqual({
      hours: { id: d * 10 + 1, sha256: sha256Hex('csv'), url: url(d, `volume-hours-${name}.csv`) },
      check: { id: d * 10 + 2, sha256: sha256Hex('check'), url: url(d, `volume-check-${name}.json`) },
    });
    expect(volumeReleaseAssets(r0, dayName(d + 1), WEB)).toBeNull();
    expect(volumeReleaseAssets(r0, name, 'https://gh.test/other')).toBeNull();
    const refused: [string, (r: Release) => Release][] = [
      ['another author', (r) => ({ ...r, author: other })],
      ['an author with the bot\'s login but another id', (r) => ({ ...r, author: { ...BOT, id: 2 } })],
      ['an author with the bot\'s id but another login', (r) => ({ ...r, author: { ...BOT, login: 'github-actions' } })],
      ['no author', (r) => ({ ...r, author: null })],
      ['a draft', (r) => ({ ...r, draft: true })],
      ['a full release (publish-volume.sh makes a prerelease)', (r) => ({ ...r, prerelease: false })],
      ['no prerelease flag', (r) => ({ ...r, prerelease: undefined })],
      ['another tag', (r) => ({ ...r, tag_name: `data-day-${name}` })],
      ['the CSV uploaded by another account', asset(0, { uploader: other })],
      ['the check uploaded by another account', asset(1, { uploader: other })],
      ['an asset not fully uploaded', asset(0, { state: 'starter' })],
      ['a second asset with the same name', (r) => ({ ...r, assets: [...r.assets, { ...r.assets[0]!, id: 9 }] })],
      ['no CSV', (r) => ({ ...r, assets: [r.assets[1]!] })],
      ['no check', (r) => ({ ...r, assets: [r.assets[0]!] })],
      ['an asset without an id', asset(0, { id: '1' })],
      ['an asset id of zero', asset(0, { id: 0 })],
      ['no asset list', (r) => ({ ...r, assets: undefined as unknown as Release['assets'] })],
      ['the CSV without a digest', asset(0, { digest: undefined })],
      ['the check without a digest', asset(1, { digest: null })],
      ['a digest that is not sha256', asset(0, { digest: `md5:${'a'.repeat(32)}` })],
      ['a digest in capitals', asset(0, { digest: `sha256:${sha256Hex('csv').toUpperCase()}` })],
      ['a 64-digit digest of another algorithm', asset(0, { digest: `blake3:${sha256Hex('csv')}` })],
      ['a download URL elsewhere', asset(0, { browser_download_url: 'https://evil.test/volume-hours.csv' })],
      ['the check\'s download URL elsewhere', asset(1, { browser_download_url: url(d, `volume-hours-${name}.csv`) })],
    ];
    for (const [why, f] of refused) expect(volumeReleaseAssets(f(release(d, 'csv', 'check')), name, WEB), why).toBeNull();
    expect(volumeReleaseAssets(null, name, WEB)).toBeNull();
    expect(volumeReleaseAssets([], name, WEB)).toBeNull();
  });
});

describe('chain volume reader', () => {
  const today = VOLUME_SERIES_START_DAY + 40;
  const start = today * DAY + 15 * HOUR;
  const all = (from: number, to: number) => new Map(Array.from({ length: to - from + 1 }, (_, k) => [from + k, csv(from + k)]));

  it('lists once, then downloads each day from the series start to yesterday once and ingests its rows', async () => {
    const h = host(all(VOLUME_SERIES_START_DAY, today - 1), { others: 30 });
    const { readers, rows, timers } = setup(h.http, start);
    expect(await pump(readers.readChainVolume(P), timers)).toBe(true);
    expect(rows().length).toBe(40 * 24);
    expect(dailyChainVolume(rows()).map((d) => d.day)).toEqual(Array.from({ length: 40 }, (_, k) => VOLUME_SERIES_START_DAY + k));
    expect(h.asked.slice(0, 3)).toEqual(['list:1', 'check:2026-07-20', 'hours:2026-07-20']);
    expect(h.asked.length).toBe(1 + 80);
    expect(h.apiCalls()).toBe(1);
    // The next pass lists again (to see a changed release) and downloads nothing.
    expect(await pump(readers.readChainVolume(P), timers)).toBe(true);
    expect(h.asked.slice(81)).toEqual(['list:1']);
    expect(readers.outcomes.filter((o) => o.read.startsWith('chain-volume:')).every((o) => o.ok)).toBe(true);
  });

  it('pages through the release list (100 a page) and reads every listed day', async () => {
    const h = host(all(VOLUME_SERIES_START_DAY, today - 1), { others: 90 });
    const { readers, rows, timers } = setup(h.http, start);
    expect(await pump(readers.readChainVolume(P), timers)).toBe(true);
    expect(h.asked.filter((a) => a.startsWith('list:'))).toEqual(['list:1', 'list:2']);
    expect(dailyChainVolume(rows()).length).toBe(40);
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

  it('a day not published ingests nothing (unknown) and is tried again only after VOLUME_RETRY_MS', async () => {
    const assets = all(VOLUME_SERIES_START_DAY, today - 1);
    const gone = today - 3;
    assets.delete(gone);
    const h = host(assets);
    const { readers, rows, timers } = setup(h.http, start);
    expect(await pump(readers.readChainVolume(P), timers)).toBe(false);
    expect(rows().some((r) => Math.floor(r.hourStartMs / DAY) === gone)).toBe(false);
    expect(readers.outcomes).toContainEqual({ read: `chain-volume:${dayName(gone)}`, ok: false, detail: `github: ${dayName(gone)} volume unknown: not published` });
    // The regime then has no volume for D-3: unknown, never zero.
    const v = { obs: { provider: 'x', slot: null, receivedAt: start, quality: [] }, days: dailyChainVolume(rows()) };
    expect(volumeCondition(v, start, P)).toEqual(expect.objectContaining({ ok: null, detail: `no curve volume for UTC day ${gone}` }));
    const failed = readers.outcomes.filter((o) => !o.ok).length;
    assets.set(gone, csv(gone));
    await pump(readers.readChainVolume(P), timers);
    expect(readers.outcomes.filter((o) => !o.ok).length).toBe(failed);
    expect(h.asked.filter((u) => u.endsWith(dayName(gone)))).toEqual([]);
    // Published later: read on the first pass after the retry interval.
    timers.advance(VOLUME_RETRY_MS);
    expect(await pump(readers.readChainVolume(P), timers)).toBe(true);
    expect(h.asked.filter((u) => u.endsWith(dayName(gone)))).toEqual([`check:${dayName(gone)}`, `hours:${dayName(gone)}`]);
    expect(dailyChainVolume(rows()).some((d) => d.day === gone)).toBe(true);
  });

  const otherAccount = { login: 'mallory', id: 7, type: 'User' };
  it.each<[string, string, HostOptions]>([
    ['a failed cross-check', 'did not pass', { check: (d) => passed(d).replace('"mismatches":[]', '"mismatches":[{"hour":3}]') }],
    ['a malformed cross-check', 'did not pass', { check: () => '<html>' }],
    ['a cross-check of another day', 'did not pass', { check: (d) => passed(d + 1) }],
    ['a cross-check of fewer hours', 'did not pass', { check: (d) => passed(d).replace('"hours":24', '"hours":23') }],
    ['a release by another author', 'provenance', { edit: (r) => ({ ...r, author: otherAccount }) }],
    ['an asset uploaded by another account', 'provenance', { edit: (r) => ({ ...r, assets: [{ ...r.assets[0]!, uploader: otherAccount }, r.assets[1]!] }) }],
    ['a full release, not the prerelease publish-volume.sh makes', 'provenance', { edit: (r) => ({ ...r, prerelease: false }) }],
    ['a draft', 'provenance', { edit: (r) => ({ ...r, draft: true }) }],
    ['an asset without a digest', 'provenance', { edit: (r) => ({ ...r, assets: [{ ...r.assets[0]!, digest: undefined }, r.assets[1]!] }) }],
    ['a CSV whose bytes do not match its digest', 'digest', { serve: (t, _d, name) => (name.endsWith('.csv') ? t.replace(/,(\d+),1\n/, ',9$1,1\n') : t) }],
    ['a check whose bytes do not match its digest', 'digest', { serve: (t, _d, name) => (name.endsWith('.json') ? `${t} ` : t) }],
    ['a release listed twice', 'provenance', {}],
  ])('refuses every day with %s: nothing ingested, unknown', async (name, why, o) => {
    const assets = all(VOLUME_SERIES_START_DAY, today - 1);
    let h = host(assets, o);
    if (name === 'a release listed twice') {
      const base = host(assets);
      h = { ...base, http: async (req) => {
        const r = await base.http(req);
        if (!req.url.includes('per_page')) return r;
        const list = JSON.parse(r.text) as unknown[];
        return resp(200, JSON.stringify([...list, ...list]));
      } };
    }
    const { readers, rows, timers } = setup(h.http, start);
    expect(await pump(readers.readChainVolume(P), timers)).toBe(false);
    expect(rows()).toEqual([]);
    expect(readers.outcomes.at(-1)).toEqual(expect.objectContaining({ ok: false, detail: expect.stringContaining(why) }));
    // A release whose provenance fails is never downloaded from.
    if (why === 'provenance' || why === 'not published') expect(h.asked.every((u) => u.startsWith('list:'))).toBe(true);
  });

  it('a malformed CSV ingests nothing for its day', async () => {
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

  it('a rate-limited release list ends the pass with nothing read', async () => {
    const h = host(all(VOLUME_SERIES_START_DAY, today - 1), { limitAfter: 0 });
    const { readers, rows, timers } = setup(h.http, start);
    expect(await pump(readers.readChainVolume(P), timers)).toBe(false);
    expect(h.asked).toEqual(['list:1']);
    expect(rows()).toEqual([]);
    expect(readers.outcomes).toEqual([expect.objectContaining({ read: 'chain-volume:list', ok: false })]);
  });

  it('with the real limits, a first start without a store reads the whole window in one pass on one API call', async () => {
    const h = host(all(VOLUME_SERIES_START_DAY, today - 1));
    const { readers, rows, timers } = setup(h.http, start, { real: true });
    expect(await pump(readers.readChainVolume(P), timers)).toBe(true);
    expect(h.apiCalls()).toBe(1);
    expect(dailyChainVolume(rows()).length).toBe(40);
    // Hourly passes stay far inside the 50 an hour.
    for (let k = 0; k < 24; k++) {
      timers.advance(HOUR);
      await pump(readers.readChainVolume(P), timers);
    }
    expect(h.apiCalls()).toBe(25);
  });

  it('a restart with the store re-checks the kept days and downloads only new ones', async () => {
    const assets = all(VOLUME_SERIES_START_DAY, today - 1);
    const dir = mkdtempSync(join(tmpdir(), 'chain-volume-'));
    const h = host(assets);
    const a = setup(h.http, start, { store: fileChainVolumeStore(dir) });
    expect(await pump(a.readers.readChainVolume(P), a.timers)).toBe(true);
    expect(readdirSync(dir).filter((f) => f.endsWith('.json')).length).toBe(40);
    // A day later the worker restarts: one more day is published.
    const later = start + DAY;
    assets.set(today, csv(today));
    const before = h.asked.length;
    const b = setup(h.http, later, { store: fileChainVolumeStore(dir) });
    expect(await pump(b.readers.readChainVolume(P), b.timers)).toBe(true);
    expect(h.asked.slice(before)).toEqual(['list:1', `check:${dayName(today)}`, `hours:${dayName(today)}`]);
    expect(dailyChainVolume(b.rows()).length).toBe(41);
    expect(b.readers.outcomes.filter((o) => o.detail.endsWith('from the store')).length).toBe(40);
  });

  it('a kept day whose text no longer matches its digest is ignored and downloaded again', async () => {
    const assets = all(VOLUME_SERIES_START_DAY, today - 1);
    const dir = mkdtempSync(join(tmpdir(), 'chain-volume-'));
    const h = host(assets);
    const a = setup(h.http, start, { store: fileChainVolumeStore(dir) });
    await pump(a.readers.readChainVolume(P), a.timers);
    const f = join(dir, `data-volume-${dayName(today - 3)}.json`);
    const rec = JSON.parse(readFileSync(f, 'utf8')) as StoredVolumeDay;
    writeFileSync(f, JSON.stringify({ ...rec, hours: { ...rec.hours, text: rec.hours.text.replace(/,(\d+),1\n/, ',1,1\n') } }));
    writeFileSync(join(dir, `data-volume-${dayName(today - 4)}.json`), '{not json');
    const before = h.asked.length;
    const b = setup(h.http, start, { store: fileChainVolumeStore(dir) });
    expect(await pump(b.readers.readChainVolume(P), b.timers)).toBe(true);
    expect(h.asked.slice(before)).toEqual(['list:1', `check:${dayName(today - 4)}`, `hours:${dayName(today - 4)}`, `check:${dayName(today - 3)}`, `hours:${dayName(today - 3)}`]);
    expect(dailyChainVolume(b.rows())).toEqual(dailyChainVolume(a.rows()));
  });

  it('kept records that do not hold are ignored and their days downloaded again', async () => {
    const assets = all(VOLUME_SERIES_START_DAY, today - 1);
    const store = memoryStore();
    const h = host(assets);
    const a = setup(h.http, start, { store });
    await pump(a.readers.readChainVolume(P), a.timers);
    const tag = (d: number) => `data-volume-${dayName(d)}`;
    const rec = (d: number) => store.days.get(tag(d))!;
    const bad = [today - 2, today - 3, today - 4, today - 5];
    // The check text changed (digest no longer matches).
    store.days.set(tag(bad[0]!), { ...rec(bad[0]!), check: { ...rec(bad[0]!).check, text: `${rec(bad[0]!).check.text} ` } });
    // The check is another day's, with a matching digest.
    const other = passed(bad[1]! + 1);
    store.days.set(tag(bad[1]!), { ...rec(bad[1]!), check: { ...rec(bad[1]!).check, text: other, sha256: sha256Hex(other) } });
    // The record names another day's release.
    store.days.set(tag(bad[2]!), { ...rec(bad[2]!), tag: tag(bad[2]! + 1) });
    store.days.delete(tag(bad[3]!));
    store.days.set(`${tag(bad[3]!)}x`, { ...rec(bad[2]!), tag: tag(bad[3]!), day: dayName(bad[3]!) + 'x' });
    // A day before the window is never read from the store.
    const o = VOLUME_SERIES_START_DAY - 1;
    const old: StoredVolumeDay = { tag: tag(o), day: dayName(o), hours: { id: o * 10 + 1, sha256: sha256Hex(csv(o)), text: csv(o) }, check: { id: o * 10 + 2, sha256: sha256Hex(passed(o)), text: passed(o) }, tampered: false };
    store.days.set(old.tag, old);
    const before = h.asked.length;
    const b = setup(h.http, start, { store });
    expect(await pump(b.readers.readChainVolume(P), b.timers)).toBe(true);
    const fetched = h.asked.slice(before).filter((u) => u.startsWith('hours:')).map((u) => u.slice(6)).sort();
    expect(fetched).toEqual(bad.map((d) => dayName(d)).sort());
    expect(b.readers.outcomes.filter((o) => o.detail.endsWith('from the store')).length).toBe(36);
    expect(b.rows().some((r) => r.hourStartMs < VOLUME_SERIES_START_DAY * DAY)).toBe(false);
    expect(dailyChainVolume(b.rows())).toEqual(dailyChainVolume(a.rows()));
  });

  it('the file store keeps one file per tag and skips a file whose name and tag differ', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chain-volume-'));
    const st = fileChainVolumeStore(dir);
    const rec: StoredVolumeDay = { tag: 'data-volume-2026-08-01', day: '2026-08-01', hours: { id: 1, sha256: 'a', text: 'x' }, check: { id: 2, sha256: 'b', text: 'y' }, tampered: false };
    st.save(rec);
    expect(readdirSync(dir)).toEqual(['data-volume-2026-08-01.json']);
    expect(st.load()).toEqual([rec]);
    writeFileSync(join(dir, 'data-volume-2026-08-02.json'), JSON.stringify(rec));
    expect(st.load()).toEqual([rec]);
  });

  it('a release list that is not a list ends the pass', async () => {
    const h = host(all(VOLUME_SERIES_START_DAY, today - 1));
    const http = async (req: HttpRequest) => (req.url.includes('per_page') ? resp(200, '{"message":"x"}') : h.http(req));
    const { readers, rows, timers } = setup(http, start);
    expect(await pump(readers.readChainVolume(P), timers)).toBe(false);
    expect(rows()).toEqual([]);
    expect(readers.outcomes).toEqual([{ read: 'chain-volume:list', ok: false, detail: 'github: release list is not an array' }]);
  });

  it('a verified day whose listed digest later changes becomes unknown for good, with an alert', async () => {
    const assets = all(VOLUME_SERIES_START_DAY, today - 1);
    const store = memoryStore();
    const alerts: string[] = [];
    const bad = today - 3;
    let forged = false;
    const h = host(assets, { edit: (r, d) => (forged && d === bad ? { ...r, assets: [{ ...r.assets[0]!, digest: `sha256:${'0'.repeat(64)}` }, r.assets[1]!] } : r) });
    const a = setup(h.http, start, { store, alerts });
    await pump(a.readers.readChainVolume(P), a.timers);
    expect(dailyChainVolume(a.rows()).some((d) => d.day === bad)).toBe(true);
    forged = true;
    a.timers.advance(HOUR);
    expect(await pump(a.readers.readChainVolume(P), a.timers)).toBe(false);
    expect(alerts).toEqual([`${dayName(bad)} volume unknown: release data-volume-${dayName(bad)} changed after it was verified`]);
    // The day's hours were ingested again as uncovered, so the producer drops it.
    expect(dailyChainVolume(a.rows()).some((d) => d.day === bad)).toBe(false);
    const w = new FactWorld(producerOptions(TRIAL_POLICY));
    a.ingested.forEach((x, i) => w.push(offchain(RAW.volumeHour, (x.body as { value: unknown }).value, BigInt(1 + i), x.receivedAt)));
    expect(parseCurveVolume(w.last(CURVE_VOLUME_KEY))!.days.some((d) => d.day === bad)).toBe(false);
    expect(store.days.get(`data-volume-${dayName(bad)}`)!.tampered).toBe(true);
    // Never downloaded again, in this process or after a restart, even if the listing goes back.
    forged = false;
    const before = h.asked.length;
    a.timers.advance(2 * VOLUME_RETRY_MS);
    await pump(a.readers.readChainVolume(P), a.timers);
    const b = setup(h.http, start + 3 * HOUR, { store });
    expect(await pump(b.readers.readChainVolume(P), b.timers)).toBe(false);
    expect(h.asked.slice(before).filter((u) => u.endsWith(dayName(bad)))).toEqual([]);
    expect(dailyChainVolume(b.rows()).some((d) => d.day === bad)).toBe(false);
    expect(dailyChainVolume(b.rows()).length).toBe(39);
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
