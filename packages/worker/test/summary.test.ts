// OPS-SUMMARY, worker side: counts folded from the journal (restart-safe), the day's summary, both guards with planted
// secrets in every free-text field, the signed post, and a worker that keeps trading when the watchdog is unreachable or
// refuses the post.
import { appendFileSync, existsSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifySignature } from '../../ops/src/watchdog/logic.ts';
import { SUMMARY_MAX_TRADES, SUMMARY_TOP_REASONS, checkSummary } from '../../ops/src/watchdog/summary.ts';
import type { MicroUsd } from '../../core/src/units/index.ts';
import type { HttpClient } from '../src/providers/index.ts';
import type { PaperTrade } from '../src/run/account.ts';
import {
  SUMMARY_AFTER_START_MS, SUMMARY_MIN_GAP_MS, Summarizer, SummaryClock, buildSummary, emptySummaryState, foldLine, foldNewLines, foldText, haltCode,
  nextSummaryDelay, signSummary, summaryBody, type SummaryInputs,
} from '../src/run/summary.ts';
import { ManualTimers } from '../src/scheduler/timers.ts';
import { MINT, makeWorker, passingMarket, tempState } from './worker-harness.ts';

// 2026-10-04 12:00 Melbourne (AEDT, UTC+11) = 01:00 UTC.
const NOON = Date.parse('2026-10-04T01:00:00.000Z');
const DAY = '2026-10-04';
const at = (ms: number) => new Date(ms).toISOString();
const M1 = 'So11111111111111111111111111111111111111112';
const M2 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const M3 = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const M4 = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

const line = (kind: string, ms: number, f: Record<string, unknown> = {}) => ({ seq: 1, ts: at(ms), boot: 'b', kind, ...f });
const reject = (ms: number, mint: string, gate: string, code: string) =>
  line('decision', ms, { action: 'reject', reasons: ['reject', 'U2', mint, `hard reject ${gate}`], gate_reasons: [{ gate, code, detail: 'x' }] });

const trade = (o: Partial<PaperTrade> = {}): PaperTrade => ({
  positionId: 'p1', mint: M1, openedAtMs: NOON, notional: 3_000_000n as MicroUsd, closedAtMs: NOON + 60_000, netLamports: -1_500_000n,
  netPnl: -300_000n as MicroUsd, stoppedOut: true, booked: 0n, exitReasons: ['stop'], ...o,
});
const inputs = (o: Partial<SummaryInputs> = {}): SummaryInputs => ({
  day: DAY, final: false, nowMs: NOON + 3_600_000, fold: undefined, gitSha: 'a'.repeat(40), entryRule: 'S0', recorder: 'on', uptimeS: 3600,
  trades: [], openPositions: 0, solPrice: 200_000_000n as MicroUsd, credits: [{ provider: 'helius', credits_used: 1234, monthly_credits: 1_000_000 }], ...o,
});

describe('counts from the journal', () => {
  it('counts starts, critical alerts, halts as they start, and each candidate once with its last refusal', () => {
    const s = emptySummaryState();
    const lines = [
      line('start', NOON, { git_sha: 'b'.repeat(40), entry_rule: 'S0', recorder: true }),
      line('halt', NOON + 1, { reasons: ['starting'] }),
      line('halt', NOON + 2, { reasons: ['feed helius-ws stale'] }),
      line('halt', NOON + 3, { reasons: ['feed helius-ws stale', 'owner pause (watchdog)'] }),
      line('resume', NOON + 4, { reasons: ['all critical feeds fresh, no pause'] }),
      line('halt', NOON + 5, { reasons: ['feed helius-ws stale'] }),
      line('alert', NOON + 6, { level: 'critical', code: 'position_unpriced', mint: M1 }),
      line('alert', NOON + 7, { level: 'cleared', code: 'position_unpriced', mint: M1 }),
      line('decision', NOON + 8, { reasons: ['shortlist', 'U2', M1, 'migrated'] }),
      reject(NOON + 9, M1, 'H5', 'low-liquidity'),
      reject(NOON + 10, M1, 'H7', 'top-holders'),
      reject(NOON + 11, M2, 'H7', 'top-holders'),
      line('decision', NOON + 12, { reasons: ['enter', 'U2', M3, 'notional 3'] }),
      line('entry', NOON + 13, { mint: M3, trade: 'p1', reasons: ['entry filled (paper)'] }),
      line('entry', NOON + 14, { mint: M3, trade: 'p1', reasons: ['entry filled (paper)'] }),
      // Refused first, entered later: entered, not refused.
      reject(NOON + 14, M4, 'H5', 'low-liquidity'),
      line('entry', NOON + 14, { mint: M4, trade: 'p2', reasons: ['entry filled (paper)'] }),
      line('start', NOON + 15, { git_sha: 'c'.repeat(40), entry_rule: 'S0', recorder: true }),
      line('halt', NOON + 16, { reasons: ['starting'] }),
    ];
    for (const l of lines) foldLine(s, l);
    const d = s.days[DAY]!;
    expect(d.starts).toBe(2);
    expect(d.gitSha).toBe('c'.repeat(40));
    expect(d.recorder).toBe('on');
    expect(d.alerts).toEqual({ position_unpriced: 1 });
    // starting twice (one per boot), feed-stale twice (it ended at the resume), the pause once.
    expect(d.halts).toEqual({ starting: 2, 'feed-stale': 2, 'owner-pause': 1 });
    const sum = buildSummary(inputs({ fold: d }));
    expect(sum.candidates).toEqual({ seen: 4, entered: 2, refused: 2, refused_by_reason: [{ gate: 'H7', code: 'top-holders', count: 2 }], refused_other: 0 });
  });

  it('puts each line in its Melbourne day (AEDT midnight is 13:00 UTC)', () => {
    const s = emptySummaryState();
    foldLine(s, line('start', Date.parse('2026-10-04T12:59:59.000Z'), { git_sha: 'a'.repeat(40) }));
    foldLine(s, line('start', Date.parse('2026-10-04T13:00:00.000Z'), { git_sha: 'a'.repeat(40) }));
    expect(Object.keys(s.days).sort()).toEqual(['2026-10-04', '2026-10-05']);
  });

  it('names halts by fixed codes only', () => {
    expect(haltCode('feed helius-ws dropped by drill')).toBe('feed-drill');
    expect(haltCode('feed pumpportal disconnected')).toBe('feed-disconnected');
    expect(haltCode('second price path unavailable')).toBe('second-path-unavailable');
    expect(haltCode('deployer index seeding')).toBe('seeding');
    expect(haltCode('sell-only: no new entries; the positions below are flattened')).toBe('sell-only');
    expect(haltCode('ledger and book diverged; entries off until a restart')).toBe('ledger-diverged');
    // The feed's name is never kept, whatever it holds.
    expect(haltCode('feed https://10.0.0.1 stale')).toBe('feed-stale');
    expect(haltCode('anything else: 10.0.0.1')).toBe('other');
  });
});

describe('reading the journal', () => {
  it('hands over only whole lines, keeps the offset at a line end, resumes there and restarts on a shorter file', async () => {
    const p = join(tempState(), 'journal.jsonl');
    writeFileSync(p, `${JSON.stringify({ a: 1 })}\n${JSON.stringify({ a: 2 })}\n{"a":3`);
    const read = async (offset: number, chunk?: number) => {
      const lines: string[] = [];
      const r = await foldNewLines(p, offset, (l) => void lines.push(l), () => {}, chunk);
      return { ...r, lines };
    };
    const r1 = await read(0, 7);
    expect(r1.lines).toEqual(['{"a":1}', '{"a":2}']);
    expect(r1.offset).toBe(16);
    appendFileSync(p, '}\n{"a":4}\n');
    const r2 = await read(r1.offset);
    expect(r2.lines).toEqual(['{"a":3}', '{"a":4}']);
    truncateSync(p, 8);
    expect(await read(r2.offset)).toEqual({ reset: true, lines: ['{"a":1}'], offset: 8 });
    expect(await foldNewLines(join(tempState(), 'none'), 5, () => {})).toEqual({ offset: 5, reset: false });
  });

  it('streams a long journal chunk by chunk (lines go out before the file is read to its end)', async () => {
    const p = join(tempState(), 'journal.jsonl');
    const n = 20_000;
    writeFileSync(p, Array.from({ length: n }, (_, k) => `${JSON.stringify(line('decision', NOON + k, { reasons: ['shortlist', 'U2', M1, 'x'] }))}\n`).join(''));
    const events: string[] = [];
    let lines = 0;
    const r = await foldNewLines(p, 0, () => {
      lines += 1;
      if (lines === 1 || lines === n) events.push(`line ${lines}`);
    }, (o) => void events.push(`chunk ${o}`), 64 * 1024);
    expect(lines).toBe(n);
    // The first chunk's offset is reported after its lines and long before the last line: nothing accumulates.
    const firstChunk = events.findIndex((e) => e.startsWith('chunk'));
    expect(events[0]).toBe('line 1');
    expect(firstChunk).toBe(1);
    expect(events.indexOf(`line ${n}`)).toBeGreaterThan(firstChunk);
    expect(r.offset).toBe(readFileSync(p).length);
  });

  it('skips lines older than the kept days before parsing them', () => {
    const s = emptySummaryState();
    const cutoff = new Date(NOON - 4 * 86_400_000).toISOString();
    foldText(s, JSON.stringify(line('start', NOON - 10 * 86_400_000)), cutoff);
    // An old line is not even parsed: a broken one after its prefix changes nothing and does not throw.
    foldText(s, `{"seq":9,"ts":"${new Date(NOON - 10 * 86_400_000).toISOString()}","kind":"start",broken`, cutoff);
    foldText(s, JSON.stringify(line('start', NOON)), cutoff);
    foldText(s, 'not json', cutoff);
    expect(Object.keys(s.days)).toEqual([DAY]);
    expect(s.days[DAY]!.starts).toBe(1);
  });

  it('the Summarizer folds the host\'s whole journal from offset 0 but keeps only the recent days', async () => {
    const dir = tempState();
    const p = join(dir, 'journal.jsonl');
    const old = Array.from({ length: 5_000 }, (_, k) => `${JSON.stringify(line('start', NOON - 20 * 86_400_000 + k))}\n`).join('');
    writeFileSync(p, `${old}${JSON.stringify(line('start', NOON))}\n`);
    const sz = new Summarizer({ journalPath: p, stateDir: dir, http: (async () => ({ status: 200, header: () => null, text: '{"ok":true,"written":true}' })) as HttpClient, watchdogUrl: 'https://w.test', key: 'k', now: () => NOON, log: () => {}, live: () => inputs() });
    await sz.tick();
    expect(Object.keys(sz.state.days)).toEqual([DAY]);
    expect(sz.state.offset).toBe(readFileSync(p).length);
  });

  it('a restart neither loses nor double-counts a line (the offset is saved with the counts)', async () => {
    const dir = tempState();
    const p = join(dir, 'journal.jsonl');
    const deps = (now: number) => ({ journalPath: p, stateDir: dir, http: (async () => ({ status: 200, header: () => null, text: '{"ok":true,"written":true}' })) as HttpClient, watchdogUrl: 'https://w.test', key: 'k', now: () => now, log: () => {}, live: () => inputs() });
    appendFileSync(p, `${JSON.stringify(line('start', NOON))}\n`);
    await new Summarizer(deps(NOON)).tick();
    appendFileSync(p, `${JSON.stringify(line('start', NOON + 1))}\n`);
    const second = new Summarizer(deps(NOON + 2));
    await second.tick();
    expect(second.state.days[DAY]!.starts).toBe(2);
    expect(existsSync(join(dir, 'summary.json'))).toBe(true);
    // An unreadable summary.json never stops anything: it counts again from the journal's start.
    writeFileSync(join(dir, 'summary.json'), 'not json');
    const logs: string[] = [];
    const third = new Summarizer({ ...deps(NOON + 3), log: (l) => void logs.push(l) });
    await third.tick();
    expect(third.state.days[DAY]!.starts).toBe(2);
    expect(logs).toContain('summary.json unreadable; counting again from the journal.');
  });
});

describe('the summary', () => {
  it('lists the day\'s trades with exact paper net, sums the closed ones, and counts top reasons and the rest', () => {
    const fold = { ...emptySummaryState().days[DAY], starts: 1, recorder: 'on' as const, gitSha: null, entryRule: null, alerts: {}, halts: {}, cands: {} as Record<string, { gate: string | null; code: string | null; entered: boolean }> };
    for (let k = 0; k < SUMMARY_TOP_REASONS + 2; k++) fold.cands[`${M1.slice(0, 40)}${k}`] = { gate: 'H1', code: `c${k}`, entered: false };
    const trades = [
      trade(),
      trade({ positionId: 'p2', mint: M2, closedAtMs: NOON + 120_000, netLamports: 4_000_000n, netPnl: 800_000n as MicroUsd, stoppedOut: false, exitReasons: ['take_profit'] }),
      trade({ positionId: 'p3', mint: M3, closedAtMs: null, netLamports: null, netPnl: null, exitReasons: [] }),
      trade({ positionId: 'p0', openedAtMs: NOON - 86_400_000, closedAtMs: NOON - 86_000_000 }),
    ];
    const s = buildSummary(inputs({ fold, trades, openPositions: 1 }));
    expect(s.trades.map((t) => [t.mint, t.exit_reason, t.net_lamports, t.net_usd])).toEqual([
      [M1, 'stop', '-1500000', '-0.3'], [M2, 'take_profit', '4000000', '0.8'], [M3, null, null, null],
    ]);
    expect(s.pnl).toEqual({ closed_trades: 2, net_lamports: '2500000', net_usd: '0.5' });
    expect(s.candidates.refused_by_reason).toHaveLength(SUMMARY_TOP_REASONS);
    expect(s.candidates.refused_other).toBe(2);
    expect(s.provider_credits).toEqual([{ provider: 'helius', used_since_boot: 1234, monthly: 1_000_000 }]);
    expect(s.worker).toEqual({ git_sha: 'a'.repeat(40), entry_rule: 'S0', uptime_s: 3600, starts: 1, recorder: 'on' });
    const b = summaryBody(s);
    expect('body' in b && checkSummary(b.body).ok).toBe(true);
    // A final summary leaves out trades still open from another day.
    expect(buildSummary(inputs({ trades: [trade({ openedAtMs: NOON - 86_400_000, closedAtMs: null })], final: true })).trades).toEqual([]);
  });

  it('caps the trade list and fits the size cap, still counting every trade', () => {
    const trades = Array.from({ length: SUMMARY_MAX_TRADES + 20 }, (_, k) => trade({ positionId: `p${k}`, openedAtMs: NOON + k }));
    const s = buildSummary(inputs({ trades }));
    expect(s.trades).toHaveLength(SUMMARY_MAX_TRADES);
    expect(s.trades_dropped).toBe(20);
    const b = summaryBody(s);
    expect('body' in b).toBe(true);
    if ('body' in b) {
      const c = checkSummary(b.body);
      expect(c.ok).toBe(true);
      if (c.ok) expect(c.summary.trades.length + c.summary.trades_dropped).toBe(SUMMARY_MAX_TRADES + 20);
    }
  });
});

/** Values that must never reach a summary, planted in every free-text field a journal line or a trade can carry. */
const PLANTED = [
  'AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ',
  'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUV',
  '203.0.113.42', '2001:db8:85a3::8a2e:370:7334', 'zeroed.tail1234.ts.net', 'https://zeroed-abc.workers.dev/heartbeat',
  '5566778899', // a chat id
  '4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw7Tz6zAqF6GzdXUDtPvACqNAmrzu8qQpRQnhm5Ws5ZK6U2', // a 64-byte base58 secret
  '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ', 'f3b1c2d4-1111-4222-8333-944455556666', 'owner@example.com',
];

describe('secrets never reach a summary (worker side)', () => {
  it('drops or codes every planted value and the body passes both guards', () => {
    for (const secret of PLANTED) {
      const s = emptySummaryState();
      const lines = [
        line('start', NOON, { git_sha: secret, entry_rule: secret, recorder: secret, label: secret, run_id: secret, pid: secret }),
        line('halt', NOON + 1, { reasons: [secret, `feed ${secret} stale`] }),
        line('alert', NOON + 2, { level: 'critical', code: secret, mint: secret, reasons: [secret] }),
        line('decision', NOON + 3, { reasons: ['reject', secret, secret, secret], gate_reasons: [{ gate: secret, code: secret, detail: secret }] }),
        line('decision', NOON + 4, { reasons: ['reject', 'U2', M1, secret], gate_reasons: [{ gate: 'H1', code: secret, detail: secret }] }),
        line('entry', NOON + 5, { mint: secret, trade: secret, reasons: [secret] }),
        line('feed', NOON + 6, { feed: secret, detail: secret, connected: false }),
        line(secret, NOON + 7, { [secret]: secret }),
      ];
      for (const l of lines) foldLine(s, l);
      const sum = buildSummary(inputs({
        fold: s.days[DAY], gitSha: secret, entryRule: secret,
        trades: [trade({ mint: secret, exitReasons: [secret] }), trade({ positionId: 'p2', exitReasons: [secret] })],
        credits: [{ provider: secret, credits_used: 1, monthly_credits: null }],
      }));
      const b = summaryBody(sum);
      expect('body' in b, secret).toBe(true);
      if (!('body' in b)) continue;
      expect(b.body, secret).not.toContain(secret);
      expect(checkSummary(b.body).ok, secret).toBe(true);
    }
  });
});

describe('the worker-side guard', () => {
  it('refuses a summary carrying a forbidden value, and nothing is posted', async () => {
    const bad = { ...buildSummary(inputs()), alerts: [{ code: 'f3b1c2d4-1111-4222-8333-944455556666', count: 1 }] };
    expect(summaryBody(bad)).toEqual({ refused: 'forbidden pattern: uuid key' });
    expect(summaryBody({ ...bad, alerts: [{ code: 'Not A Code', count: 1 }] })).toEqual({ refused: 'not the summary shape' });
    const dir = tempState();
    const calls: string[] = [];
    const logs: string[] = [];
    const sz = new Summarizer({
      journalPath: join(dir, 'journal.jsonl'), stateDir: dir, http: (async (req) => (calls.push(req.url), { status: 200, header: () => null, text: '{}' })) as HttpClient,
      watchdogUrl: 'https://w.test', key: 'k', now: () => NOON, log: (l) => void logs.push(l), live: () => inputs(), build: () => bad,
    });
    await sz.tick();
    expect(calls).toEqual([]);
    expect(logs).toEqual([`Summary for ${DAY} not sent: forbidden pattern: uuid key.`]);
  });
});

describe('a summary that throws', () => {
  it('is caught and logged: tick resolves (journal path a directory, or the worker\'s state unreadable)', async () => {
    const dir = tempState();
    const logs: string[] = [];
    const deps = { stateDir: dir, http: (async () => ({ status: 200, header: () => null, text: '{}' })) as HttpClient, watchdogUrl: 'https://w.test', key: 'k', now: () => NOON, log: (l: string) => void logs.push(l), live: () => inputs() };
    await expect(new Summarizer({ ...deps, journalPath: dir }).tick()).resolves.toBeUndefined();
    await expect(new Summarizer({ ...deps, journalPath: join(dir, 'j'), live: () => { throw new Error('boom'); } }).tick()).resolves.toBeUndefined();
    expect(logs).toEqual(['Summary skipped: Error.', 'Summary skipped: Error.']);
  });

  it('in a running worker: logged, the next post still comes, and the worker keeps running', async () => {
    const posts: string[] = [];
    let faults = 2;
    const http: HttpClient = async (req) => {
      if (req.url.endsWith('/summary')) posts.push(req.body!);
      return { status: 200, header: () => null, text: JSON.stringify({ ok: true, paused: false, written: true }) };
    };
    const h = makeWorker({ key: 'k', http, summaryFault: () => {
      if (faults > 0) {
        faults -= 1;
        throw new Error('state unreadable');
      }
    } });
    expect(await h.worker.start()).toEqual({ ok: true });
    for (let k = 0; k < 200 && posts.length < 2; k++) await new Promise((r) => setTimeout(r, 5));
    expect(h.logs.filter((l) => l === 'Summary skipped: Error.')).toHaveLength(2);
    expect(posts.length).toBeGreaterThanOrEqual(2);
    expect(h.worker.health().reconciled).toBe(true);
    expect(await h.worker.stop()).toBe(0);
  });
});

describe('the post', () => {
  it('is signed for /summary only: the watchdog accepts it there and refuses it as a heartbeat', async () => {
    const body = '{"x":1}';
    const t = 1_800_000_000;
    const h = `t=${t},v1=${signSummary('k', t, body)}`;
    expect(await verifySignature(h, 'POST', '/summary', body, 'k', t)).toBe(t);
    expect(await verifySignature(h, 'POST', '/heartbeat', body, 'k', t)).toBeNull();
  });

  it('never throws on an unreachable watchdog or a 401, and posts the day that ended once, marked final', async () => {
    const dir = tempState();
    const p = join(dir, 'journal.jsonl');
    writeFileSync(p, `${JSON.stringify(line('start', NOON))}\n`);
    const posts: { day: string; final: boolean; t: number }[] = [];
    let mode: 'down' | '401' | 'ok' = 'down';
    const http: HttpClient = async (req) => {
      if (mode === 'down') throw Object.assign(new Error('x'), { name: 'TypeError' });
      if (mode === '401') return { status: 401, header: () => null, text: '{"error":"bad signature"}' };
      const s = JSON.parse(req.body!) as { day: string; final: boolean };
      posts.push({ day: s.day, final: s.final, t: Number(/t=(\d+)/.exec(req.headers!['x-zeroed-signature']!)![1]) });
      return { status: 200, header: () => null, text: '{"ok":true,"written":true}' };
    };
    let now = NOON;
    const logs: string[] = [];
    const sz = new Summarizer({ journalPath: p, stateDir: dir, http, watchdogUrl: 'https://w.test', key: 'k', now: () => now, log: (l) => void logs.push(l), live: () => inputs() });
    await expect(sz.tick()).resolves.toBeUndefined();
    mode = '401';
    await expect(sz.tick()).resolves.toBeUndefined();
    expect(logs).toEqual([`Summary for ${DAY} not accepted: TypeError.`, `Summary for ${DAY} not accepted: HTTP 401.`]);
    // Past Melbourne midnight while the watchdog refuses: the final for the 4th waits and is sent once it answers.
    now = Date.parse('2026-10-04T13:00:30.000Z');
    await sz.tick();
    mode = 'ok';
    await sz.tick();
    await sz.tick();
    expect(posts.map((x) => [x.day, x.final])).toEqual([[DAY, true], ['2026-10-05', false], ['2026-10-05', false]]);
    // Two posts in one second get increasing signature times (the watchdog takes each once).
    expect(posts[1]!.t).toBeGreaterThan(posts[0]!.t);
  });

  it('posts on the Melbourne :00 and :30 slots (plus a minute) and just after Melbourne midnight', () => {
    // 12:00 Melbourne: the next post is 12:01; from 12:01 itself, 12:31; from 12:17, 12:31.
    expect(nextSummaryDelay(NOON, 1_800_000)).toBe(60_000);
    expect(nextSummaryDelay(NOON + 60_000, 1_800_000)).toBe(1_800_000);
    expect(nextSummaryDelay(NOON + 17 * 60_000, 1_800_000)).toBe(14 * 60_000);
    const late = Date.parse('2026-10-04T12:50:00.000Z');
    expect(nextSummaryDelay(late, 1_800_000)).toBeGreaterThanOrEqual(10 * 60_000 + 5_000);
    expect(nextSummaryDelay(late, 1_800_000)).toBeLessThanOrEqual(10 * 60_000 + 6_000);
  });
});

describe('the worker keeps trading when the summary fails', () => {
  for (const failure of ['unreachable', '401', 'throws'] as const) {
    it(`with the watchdog ${failure}: entries, journal and the position go on, and the stop is clean`, async () => {
      const summaries: string[] = [];
      const http: HttpClient = async (req) => {
        if (req.url.endsWith('/summary')) {
          summaries.push(req.body!);
          if (failure === 'unreachable') throw Object.assign(new Error('x'), { name: 'TypeError' });
          return { status: 401, header: () => null, text: '{"error":"bad signature"}' };
        }
        return { status: 200, header: () => null, text: JSON.stringify({ ok: true, paused: false }) };
      };
      const h = makeWorker({ key: 'k', http, ...(failure === 'throws' ? { summaryFault: () => { throw new Error('boom'); } } : {}) });
      expect(await h.worker.reconcile()).toEqual({ ok: true });
      const m = await passingMarket(h, { heldPoolFacts: true });
      await m.run(4_000, 100, () => m.pool());
      await h.worker.summaryNow();
      const seqBefore = h.worker.health().journal_seq;
      await m.run(10_000, 400, () => {
        m.slot();
        m.pool();
      });
      await h.worker.summaryNow();
      expect(h.worker.health().journal_seq).toBeGreaterThan(seqBefore);
      expect(Object.values(h.worker.apiInputs().book.positions).some((p) => String(p.mint) === String(MINT) && p.status === 'open')).toBe(true);
      if (failure === 'throws') {
        expect(summaries).toEqual([]);
        expect(h.logs.filter((l) => l === 'Summary skipped: Error.')).toHaveLength(2);
      } else {
        expect(summaries.length).toBeGreaterThanOrEqual(2);
        expect(h.logs.some((l) => l.startsWith('Summary for ') && l.includes('not accepted'))).toBe(true);
        // The summary that was refused was valid and named the entry.
        const c = checkSummary(summaries.at(-1)!);
        expect(c.ok).toBe(true);
        if (c.ok) expect(c.summary.candidates.entered).toBe(1);
      }
      expect(await h.worker.stop()).toBe(0);
      const journal = readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8');
      expect(journal).toContain('"kind":"stop"');
    });
  }
});

describe('the summary timer', () => {
  it('posts again after each post while the worker runs, and stops with it', async () => {
    const posts: string[] = [];
    const http: HttpClient = async (req) => {
      if (req.url.endsWith('/summary')) posts.push(req.body!);
      return { status: 200, header: () => null, text: JSON.stringify({ ok: true, paused: false, written: true }) };
    };
    const h = makeWorker({ key: 'k', http });
    expect(await h.worker.start()).toEqual({ ok: true });
    for (let k = 0; k < 200 && posts.length < 3; k++) await new Promise((r) => setTimeout(r, 5));
    expect(posts.length).toBeGreaterThanOrEqual(3);
    await h.worker.stop();
    // A post already in flight may finish; nothing starts after that.
    await new Promise((r) => setTimeout(r, 50));
    const after = posts.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(posts.length).toBe(after);
  });
});

// SUMMARY-CLOCK: the posts follow the Melbourne wall clock, not the process's start, and a start soon after a post does
// not post again. Each worker process is a Summarizer and a SummaryClock on the same state directory (summary.json),
// stopped when the next one starts, on one manual clock moved in small steps.
describe('SUMMARY-CLOCK: a worker that restarts still posts', () => {
  // 2026-10-05 18:00 Melbourne (AEDT, UTC+11).
  const EVENING = Date.parse('2026-10-05T07:00:00.000Z');
  const HALF = 1_800_000;
  type Post = { day: string; final: boolean; at: number };

  const simulate = async (o: { from: number; hours: number; everyMs: number; stepMs: number; guard?: boolean }) => {
    const dir = tempState();
    const timers = new ManualTimers(o.from);
    const posts: Post[] = [];
    const http: HttpClient = async (req) => {
      const b = JSON.parse(req.body!) as { day: string; final: boolean; generated_at: string };
      posts.push({ day: b.day, final: b.final, at: Date.parse(b.generated_at) });
      return { status: 200, header: () => null, text: '{"ok":true,"written":true}' };
    };
    // Each step waits for the posts it started (file and HTTP work is real I/O), so a process stops between posts.
    const inflight: Promise<void>[] = [];
    const flush = async () => {
      while (inflight.length > 0) await inflight.shift();
    };
    const end = o.from + o.hours * 3_600_000;
    let starts = 0;
    while (timers.now() < end) {
      starts++;
      // Each process writes its start line, as the worker does (the day's counts the final post is made from).
      appendFileSync(join(dir, 'journal.jsonl'), `${JSON.stringify({ seq: starts, ts: at(timers.now()), boot: `b${starts}`, kind: 'start', git_sha: 'a'.repeat(40), entry_rule: 'S0', recorder: true })}\n`);
      const sz = new Summarizer({
        journalPath: join(dir, 'journal.jsonl'), stateDir: dir, http, watchdogUrl: 'https://w.test', key: 'k', now: () => timers.now(), log: () => {},
        live: () => inputs(),
      });
      const clock = new SummaryClock({ timers, everyMs: HALF, tick: () => {
        const p = sz.tick();
        inflight.push(p);
        return p;
      }, lastPostedMs: () => (o.guard === false ? null : sz.lastPostedMs) });
      clock.start();
      const stopAt = Math.min(end, timers.now() + o.everyMs);
      while (timers.now() < stopAt) {
        timers.advance(Math.min(o.stepMs, stopAt - timers.now()));
        await flush();
      }
      clock.stop();
      await flush();
    }
    return { posts, starts };
  };
  /** Every :01 and :31 Melbourne in [from, to). */
  const slots = (from: number, to: number) => {
    const out: number[] = [];
    for (let t = from - (from % HALF) + 60_000; t < to; t += HALF) if (t >= from) out.push(t);
    return out;
  };

  it('restarted every 20 minutes for 6 hours, it posts at every half-hour it is up', async () => {
    const { posts, starts } = await simulate({ from: EVENING, hours: 6, everyMs: 20 * 60_000, stepMs: 5_000 });
    expect(starts).toBe(18);
    const want = slots(EVENING, EVENING + 6 * 3_600_000);
    expect(want).toHaveLength(12);
    for (const t of want) expect(posts.some((p) => p.at === t), new Date(t).toISOString()).toBe(true);
    // Plus the one after the first start (nothing posted before it); the later starts are within 10 minutes of a post
    // or 3 minutes after one: 18:03 is 2 minutes after 18:01, so it is skipped too.
    expect(posts.every((p) => !p.final)).toBe(true);
  });

  it('restarted every 5 seconds, it posts at most once per 10 minutes, and still on the half-hours', async () => {
    const { posts, starts } = await simulate({ from: EVENING, hours: 2, everyMs: 5_000, stepMs: 1_000 });
    expect(starts).toBe(1440);
    for (const t of slots(EVENING, EVENING + 2 * 3_600_000)) expect(posts.some((p) => p.at === t), new Date(t).toISOString()).toBe(true);
    for (let k = 1; k < posts.length; k++) expect(posts[k]!.at - posts[k - 1]!.at).toBeGreaterThanOrEqual(SUMMARY_MIN_GAP_MS);
  });

  it('restarted every 4 minutes, a start posts 3 minutes in only when nothing was taken in the 10 minutes before (kept in summary.json)', async () => {
    const { posts } = await simulate({ from: EVENING, hours: 2, everyMs: 4 * 60_000, stepMs: 5_000 });
    const onSlot = (t: number) => t % HALF === 60_000;
    const afterStart = posts.filter((p) => !onSlot(p.at));
    expect(afterStart.length).toBeGreaterThan(0);
    for (const p of afterStart) {
      expect((p.at - EVENING) % (4 * 60_000)).toBe(SUMMARY_AFTER_START_MS);
      const before = posts.filter((q) => q.at < p.at).at(-1);
      if (before !== undefined) expect(p.at - before.at).toBeGreaterThanOrEqual(SUMMARY_MIN_GAP_MS);
    }
    for (const t of slots(EVENING, EVENING + 2 * 3_600_000)) expect(posts.some((p) => p.at === t)).toBe(true);
    // Without the check every start would post: the check is what holds it to one per 10 minutes.
    const unguarded = await simulate({ from: EVENING, hours: 2, everyMs: 4 * 60_000, stepMs: 5_000, guard: false });
    const gaps = unguarded.posts.slice(1).map((p, k) => p.at - unguarded.posts[k]!.at);
    expect(Math.min(...gaps)).toBeLessThan(SUMMARY_MIN_GAP_MS);
  });

  it('across Melbourne midnight, restarting or not, the day that ended gets exactly one final post, first after midnight', async () => {
    // 2026-10-05 22:00 to 2026-10-06 02:00 Melbourne.
    const from = Date.parse('2026-10-05T11:00:00.000Z');
    const midnight = Date.parse('2026-10-05T13:00:00.000Z');
    for (const everyMs of [20 * 60_000, 4 * 3_600_000]) {
      const { posts } = await simulate({ from, hours: 4, everyMs, stepMs: 5_000 });
      const finals = posts.filter((p) => p.final);
      expect(finals.map((p) => [p.day, p.final]), `restart every ${everyMs} ms`).toEqual([['2026-10-05', true]]);
      // Just after midnight; a process that starts at midnight itself posts it on the first slot, 00:01.
      expect(finals[0]!.at).toBe(everyMs === 20 * 60_000 ? midnight + 60_000 : midnight + 5_000);
      expect(posts.filter((p) => p.at >= midnight)[0]).toEqual(finals[0]);
      expect(posts.filter((p) => p.at >= midnight).slice(1).every((p) => p.day === '2026-10-06' && !p.final)).toBe(true);
    }
  });
});

// SUMMARY-CLOCK follow-up (supervisor review of #208): no second post a minute after the day-end post, and two
// survivors pinned: a host clock behind last_posted_ms, and last_posted_ms kept when the journal is replaced.
describe('SUMMARY-CLOCK: around midnight and odd clocks', () => {
  const HALF = 1_800_000;
  const MIDNIGHT = Date.parse('2026-10-05T13:00:00.000Z');
  const dirWith = () => {
    const dir = tempState();
    writeFileSync(join(dir, 'journal.jsonl'), `${JSON.stringify({ seq: 1, ts: at(MIDNIGHT - 3_600_000), boot: 'b', kind: 'start', git_sha: 'a'.repeat(40), entry_rule: 'S0', recorder: true })}\n`);
    return dir;
  };

  it('a worker up across midnight posts the day-end final at 00:00:05 and skips the 00:01 slot; the next is 00:31', async () => {
    const dir = dirWith();
    const timers = new ManualTimers(MIDNIGHT - 10 * 60_000);
    const posts: { final: boolean; at: number }[] = [];
    const http: HttpClient = async (req) => {
      const b = JSON.parse(req.body!) as { final: boolean; generated_at: string };
      posts.push({ final: b.final, at: Date.parse(b.generated_at) });
      return { status: 200, header: () => null, text: '{"ok":true,"written":true}' };
    };
    const sz = new Summarizer({ journalPath: join(dir, 'journal.jsonl'), stateDir: dir, http, watchdogUrl: 'https://w.test', key: 'k', now: () => timers.now(), log: () => {}, live: () => inputs() });
    const inflight: Promise<void>[] = [];
    const clock = new SummaryClock({ timers, everyMs: HALF, tick: () => {
      const p = sz.tick();
      inflight.push(p);
      return p;
    }, lastPostedMs: () => sz.lastPostedMs });
    clock.start();
    while (timers.now() < MIDNIGHT + 40 * 60_000) {
      timers.advance(5_000);
      while (inflight.length > 0) await inflight.shift();
    }
    clock.stop();
    const after = posts.filter((p) => p.at >= MIDNIGHT - 60_000);
    expect(after).toEqual([{ final: true, at: MIDNIGHT + 5_000 }, { final: false, at: MIDNIGHT + 5_000 }, { final: false, at: MIDNIGHT + HALF + 60_000 }]);
  });

  it('when the watchdog refused the day-end post, the 00:01 slot still posts the final', async () => {
    // A process started at 23:52 posts at 23:55 (3 minutes in); the watchdog refuses every post from midnight to
    // 00:00:30. The 23:55 post is under 10 minutes before 00:01 but before midnight, so 00:01 is not skipped.
    const simulateAround = async () => {
      const dir = dirWith();
      const timers = new ManualTimers(MIDNIGHT - 8 * 60_000);
      const posts: { final: boolean; at: number }[] = [];
      const http: HttpClient = async (req) => {
        const b = JSON.parse(req.body!) as { final: boolean; generated_at: string };
        if (Date.parse(b.generated_at) < MIDNIGHT + 30_000 && Date.parse(b.generated_at) >= MIDNIGHT) return { status: 503, header: () => null, text: '{}' };
        posts.push({ final: b.final, at: Date.parse(b.generated_at) });
        return { status: 200, header: () => null, text: '{"ok":true,"written":true}' };
      };
      const sz = new Summarizer({ journalPath: join(dir, 'journal.jsonl'), stateDir: dir, http, watchdogUrl: 'https://w.test', key: 'k', now: () => timers.now(), log: () => {}, live: () => inputs() });
      const inflight: Promise<void>[] = [];
      const clock = new SummaryClock({ timers, everyMs: HALF, tick: () => {
        const p = sz.tick();
        inflight.push(p);
        return p;
      }, lastPostedMs: () => sz.lastPostedMs });
      clock.start();
      while (timers.now() < MIDNIGHT + 10 * 60_000) {
        timers.advance(5_000);
        while (inflight.length > 0) await inflight.shift();
      }
      clock.stop();
      return posts;
    };
    const posts = await simulateAround();
    expect(posts[0]).toEqual({ final: false, at: MIDNIGHT - 5 * 60_000 });
    expect(posts.filter((p) => p.final)).toEqual([{ final: true, at: MIDNIGHT + 60_000 }]);
  });

  it('a host clock behind last_posted_ms never holds back the post after a start', async () => {
    // 00:05: the next slot is 00:31, so the only run in the first 3 minutes is the one after the start.
    const timers = new ManualTimers(MIDNIGHT + 5 * 60_000);
    let ticks = 0;
    const clock = new SummaryClock({ timers, everyMs: HALF, tick: async () => void ticks++, lastPostedMs: () => MIDNIGHT + 3_600_000 });
    clock.start();
    timers.advance(SUMMARY_AFTER_START_MS - 1);
    expect(ticks).toBe(0);
    timers.advance(1);
    expect(ticks).toBe(1);
    clock.stop();
  });

  it('a replaced journal keeps last_posted_ms, so a start right after still holds its post back', async () => {
    const dir = dirWith();
    const p = join(dir, 'journal.jsonl');
    let now = MIDNIGHT + 3_600_000;
    let up = true;
    const http: HttpClient = async () => (up ? { status: 200, header: () => null, text: '{"ok":true,"written":true}' } : { status: 503, header: () => null, text: '{}' });
    const sz = new Summarizer({ journalPath: p, stateDir: dir, http, watchdogUrl: 'https://w.test', key: 'k', now: () => now, log: () => {}, live: () => inputs() });
    await sz.tick();
    expect(sz.lastPostedMs).toBe(MIDNIGHT + 3_600_000);
    // The journal is replaced by a shorter one; this run counts again from its start and its post is refused.
    writeFileSync(p, '');
    up = false;
    now += 60_000;
    await sz.tick();
    expect(sz.state.offset).toBe(0);
    expect(sz.lastPostedMs).toBe(MIDNIGHT + 3_600_000);
    const again = new Summarizer({ journalPath: p, stateDir: dir, http, watchdogUrl: 'https://w.test', key: 'k', now: () => now, log: () => {}, live: () => inputs() });
    expect(again.lastPostedMs).toBe(MIDNIGHT + 3_600_000);
  });
});
