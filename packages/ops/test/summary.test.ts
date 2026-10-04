// OPS-SUMMARY, watchdog side: the shape and forbidden-pattern guards, the fail-closed private-repository write, and the
// /summary route (signed, replay-safe, alerting on failure, never touching the heartbeat or the pause).
import { describe, expect, it, vi } from 'vitest';
import { sign, type Heartbeat } from '../src/watchdog/logic.ts';
import { CODE_REPO, writeReports } from '../src/watchdog/reports.ts';
import { FORBIDDEN, FORBIDDEN_KEY, SHAPE_KEYS, checkSummary, forbiddenIn, isSummary, type Summary, type SummaryV1 } from '../src/watchdog/summary.ts';
import { Watchdog, type DurableState, type Env } from '../src/watchdog/worker.ts';

const KEY = 'test-hmac-key-0123456789abcdef';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export const goodSummary = (over: Partial<Summary> = {}): Summary => ({
  v: 2, day: '2026-10-04', final: false, generated_at: '2026-10-04T02:00:00.000Z', mode: 'paper',
  worker: { git_sha: 'a'.repeat(40), entry_rule: 'S0', uptime_s: 3600, starts: 1, recorder: 'on' },
  alerts: [{ code: 'position_unpriced', count: 1 }], halts: [{ code: 'feed-stale', count: 2 }],
  candidates: { seen: 3, entered: 1, refused: 2, refused_by_reason: [{ gate: 'H7', code: 'top-holders', count: 2 }], refused_other: 0 },
  trades: [{ mint: MINT, opened_at: '2026-10-04T01:00:00.000Z', closed_at: '2026-10-04T01:01:00.000Z', size_usd: '3', exit_reason: 'stop', net_lamports: '-1500000', net_usd: '-0.3' }],
  trades_dropped: 0, pnl: { closed_trades: 1, net_lamports: '-1500000', net_usd: '-0.3' }, open_positions: 0,
  provider_credits: [{ provider: 'helius', used_since_boot: 1234, monthly: 1_000_000 }],
  headline: { balance_sol: '2', equity_sol: '2.012', day_net_sol: '-0.0015', open_marked_net_sol: '-0.003', day_change_sol: '-0.0045' },
  open: {
    positions: [{ mint: MINT, opened_at: '2026-10-04T01:30:00.000Z', cost_lamports: '15000000', value_lamports: '12000000', marked_net_lamports: '-3000000' }],
    marked_net_lamports: '-3000000', unquotable: 0, unlisted: 0,
  },
  memory: { rss_min_bytes: 180_000_000, rss_max_bytes: 320_000_000, rss_last_bytes: 320_000_000, rss_change_bytes: 140_000_000 },
  ...over,
});

/** The same day as version 1 sent it (a worker not yet updated). */
const goodV1 = (): SummaryV1 => {
  const { headline: _h, open: _o, memory: _m, ...rest } = goodSummary();
  return { ...rest, v: 1 };
};

/** The same planted values as the worker side's test, one per forbidden kind. */
const PLANTED = [
  'AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ',
  'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUV', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  '203.0.113.42', '2001:db8:85a3::8a2e:370:7334', 'fe80::1', 'zeroed.tail1234.ts.net', 'https://zeroed-abc.workers.dev/heartbeat', 'api.helius.dev',
  '4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw7Tz6zAqF6GzdXUDtPvACqNAmrzu8qQpRQnhm5Ws5ZK6U2',
  '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ', 'f3b1c2d4-1111-4222-8333-944455556666', 'owner@example.com',
  'a1'.repeat(32), '-----BEGIN PRIVATE KEY-----', '5566778899',
];

/** Every string field of the shape, as a path a test can write a value into. */
const STRING_FIELDS: readonly ((s: Record<string, any>, v: string) => void)[] = [
  (s, v) => (s.day = v), (s, v) => (s.generated_at = v), (s, v) => (s.mode = v),
  (s, v) => (s.worker.git_sha = v), (s, v) => (s.worker.entry_rule = v), (s, v) => (s.worker.recorder = v),
  (s, v) => (s.alerts[0].code = v), (s, v) => (s.halts[0].code = v),
  (s, v) => (s.candidates.refused_by_reason[0].gate = v), (s, v) => (s.candidates.refused_by_reason[0].code = v),
  (s, v) => (s.trades[0].mint = v), (s, v) => (s.trades[0].opened_at = v), (s, v) => (s.trades[0].closed_at = v), (s, v) => (s.trades[0].size_usd = v),
  (s, v) => (s.trades[0].exit_reason = v), (s, v) => (s.trades[0].net_lamports = v), (s, v) => (s.trades[0].net_usd = v),
  (s, v) => (s.pnl.net_lamports = v), (s, v) => (s.pnl.net_usd = v), (s, v) => (s.provider_credits[0].provider = v),
  // A field that is not in the shape.
  (s, v) => (s.worker.host = v), (s, v) => (s.note = v), (s, v) => (s.trades[0].wallet = v),
  // Version 2: the SOL headline, open positions and memory.
  (s, v) => (s.headline.balance_sol = v), (s, v) => (s.headline.equity_sol = v), (s, v) => (s.headline.day_net_sol = v),
  (s, v) => (s.headline.open_marked_net_sol = v), (s, v) => (s.headline.day_change_sol = v), (s, v) => (s.headline.usd = v),
  (s, v) => (s.open.positions[0].mint = v), (s, v) => (s.open.positions[0].opened_at = v), (s, v) => (s.open.positions[0].cost_lamports = v),
  (s, v) => (s.open.positions[0].value_lamports = v), (s, v) => (s.open.positions[0].marked_net_lamports = v), (s, v) => (s.open.marked_net_lamports = v),
  (s, v) => (s.open.positions[0].wallet = v), (s, v) => (s.memory.host = v), (s, v) => (s.memory.rss_last_bytes = v),
];

const AMOUNT_FIELDS = new Set([13, 15, 16, 17, 18, 23, 24, 25, 26, 27, 31, 32, 33, 34]);

describe('the summary guards', () => {
  it('accept the exact shape and refuse a missing, extra or mistyped field', () => {
    expect(checkSummary(JSON.stringify(goodSummary())).ok).toBe(true);
    const { pnl: _, ...missing } = goodSummary();
    expect(checkSummary(JSON.stringify(missing))).toEqual({ ok: false, reason: 'not the summary shape' });
    expect(checkSummary(JSON.stringify({ ...goodSummary(), extra: 1 })).ok).toBe(false);
    expect(checkSummary(JSON.stringify(goodSummary({ open_positions: -1 }))).ok).toBe(false);
    expect(checkSummary(JSON.stringify(goodSummary({ v: 3 as 2 }))).ok).toBe(false);
    // Version 1 from a worker not yet updated is still taken, but never a mix of the two.
    expect(checkSummary(JSON.stringify(goodV1())).ok).toBe(true);
    expect(checkSummary(JSON.stringify({ ...goodV1(), v: 2 })).ok).toBe(false);
    expect(checkSummary(JSON.stringify({ ...goodSummary(), v: 1 })).ok).toBe(false);
    // Open positions: a value and its marked net are both known or both null; a negative count or a non-integer change fails.
    const pos = goodSummary().open.positions[0]!;
    const withPos = (p: object) => JSON.stringify(goodSummary({ open: { ...goodSummary().open, positions: [{ ...pos, ...p }] } }));
    // An unquotable position: its marked net leaves the total and it is counted (the headline follows the total).
    const nullPos = JSON.stringify(goodSummary({
      headline: { ...goodSummary().headline, open_marked_net_sol: '0' },
      open: { positions: [{ ...pos, value_lamports: null, marked_net_lamports: null }], marked_net_lamports: '0', unquotable: 1, unlisted: 0 },
    }));
    expect(checkSummary(nullPos).ok).toBe(true);
    // The figures must agree with each other: total vs listed nets, unquotable vs null values, headline vs total.
    expect(checkSummary(withPos({ value_lamports: null, marked_net_lamports: null })).ok).toBe(false);
    // A total that disagrees with the listed nets, even when the headline agrees with the total.
    expect(checkSummary(JSON.stringify(goodSummary({ headline: { ...goodSummary().headline, open_marked_net_sol: '-0.002999999' }, open: { ...goodSummary().open, marked_net_lamports: '-2999999' } }))).ok).toBe(false);
    expect(checkSummary(JSON.stringify(goodSummary({ open: { ...goodSummary().open, unquotable: 1 } }))).ok).toBe(false);
    expect(checkSummary(JSON.stringify(goodSummary({ headline: { ...goodSummary().headline, open_marked_net_sol: '-0.004' } }))).ok).toBe(false);
    // With some unlisted, the total may hold more than the listed nets, but unquotable is never below the listed nulls.
    expect(checkSummary(JSON.stringify(goodSummary({ open: { ...goodSummary().open, marked_net_lamports: '-3000000', unlisted: 2, unquotable: 1 } }))).ok).toBe(true);
    expect(checkSummary(JSON.stringify(goodSummary({
      headline: { ...goodSummary().headline, open_marked_net_sol: '0' },
      open: { positions: [{ ...pos, value_lamports: null, marked_net_lamports: null }], marked_net_lamports: '0', unquotable: 0, unlisted: 3 },
    }))).ok).toBe(false);
    expect(checkSummary(withPos({ value_lamports: null })).ok).toBe(false);
    expect(checkSummary(withPos({ value_lamports: '0', marked_net_lamports: null })).ok).toBe(false);
    expect(checkSummary(JSON.stringify(goodSummary({ open: { ...goodSummary().open, unquotable: -1 } }))).ok).toBe(false);
    expect(checkSummary(JSON.stringify(goodSummary({ memory: { ...goodSummary().memory, rss_change_bytes: -5 } }))).ok).toBe(true);
    expect(checkSummary(JSON.stringify(goodSummary({ memory: { ...goodSummary().memory, rss_change_bytes: 1.5 } }))).ok).toBe(false);
    // rss counts are non-negative integers, all known or all unknown, and lowest <= last <= highest.
    const mem = (m: object) => JSON.stringify(goodSummary({ memory: { ...goodSummary().memory, ...m } }));
    for (const k of ['rss_min_bytes', 'rss_max_bytes', 'rss_last_bytes']) {
      for (const bad of [-1, 1.5, '1']) expect(checkSummary(mem({ [k]: bad })).ok, `${k}=${JSON.stringify(bad)}`).toBe(false);
    }
    expect(checkSummary(mem({ rss_min_bytes: null, rss_max_bytes: null, rss_last_bytes: null, rss_change_bytes: null })).ok).toBe(true);
    expect(checkSummary(mem({ rss_min_bytes: null })).ok).toBe(false);
    expect(checkSummary(mem({ rss_min_bytes: 400_000_000 })).ok).toBe(false);
    expect(checkSummary(mem({ rss_last_bytes: 400_000_000 })).ok).toBe(false);
    expect(checkSummary(mem({ rss_last_bytes: 100_000_000 })).ok).toBe(false);
    expect(checkSummary('not json')).toEqual({ ok: false, reason: 'not JSON' });
    expect(checkSummary(' '.repeat(70_000))).toEqual({ ok: false, reason: 'too large' });
  });

  it('refuse every planted secret in every string field and in any field outside the shape', () => {
    for (const secret of PLANTED) {
      for (const [k, set] of STRING_FIELDS.entries()) {
        // Amount fields hold digits by design: a bare number cannot be told from an amount there. The worker writes
        // them only from its own bigints (summary.ts buildSummary), never from journal text.
        if (secret === '5566778899' && AMOUNT_FIELDS.has(k)) continue;
        const s = structuredClone(goodSummary()) as unknown as Record<string, any>;
        set(s, secret);
        expect(checkSummary(JSON.stringify(s)).ok, `${secret} in field ${k}`).toBe(false);
      }
    }
  });

  it('name each forbidden kind, and never flag a mint address or a normal summary', () => {
    for (const secret of PLANTED.filter((p) => p !== '5566778899')) expect(forbiddenIn(secret), secret).not.toBeNull();
    expect(forbiddenIn(JSON.stringify(goodSummary()))).toBeNull();
    const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let k = 0; k < 3000; k++) {
      const mint = Array.from({ length: 32 + Math.floor(rnd() * 13) }, () => B58[Math.floor(rnd() * B58.length)]).join('');
      const s = goodSummary({ trades: [{ ...goodSummary().trades[0]!, mint }] });
      expect(checkSummary(JSON.stringify(s)).ok, mint).toBe(true);
    }
    expect(FORBIDDEN.length).toBeGreaterThanOrEqual(12);
  });

  it('no key of the shape is a name that could hold a secret or a host', () => {
    for (const k of SHAPE_KEYS) expect(k, k).not.toMatch(FORBIDDEN_KEY);
    for (const bad of ['owner_chat_id', 'wallet', 'api_key', 'token', 'hostname', 'ip', 'url', 'tailnet']) expect(bad).toMatch(FORBIDDEN_KEY);
    expect(isSummary(goodSummary())).toBe(true);
  });
});

type Call = { url: string; method: string; body?: string; auth?: string };
const github = (meta: { private?: unknown; full_name?: unknown } | number, existing: Record<string, string> = {}) => {
  const calls: Call[] = [];
  const f = async (url: string, init: RequestInit): Promise<Response> => {
    const method = init.method ?? 'GET';
    calls.push({ url, method, ...(init.body === undefined ? {} : { body: String(init.body) }), auth: (init.headers as Record<string, string>)['authorization'] ?? '' });
    if (/\/repos\/[^/]+\/[^/]+$/.test(url)) return typeof meta === 'number' ? new Response('{}', { status: meta }) : Response.json(meta);
    const path = url.split('/contents/')[1]!;
    if (method === 'GET') return path in existing ? Response.json({ sha: existing[path] }) : new Response('{}', { status: 404 });
    return new Response('{}', { status: existing[path] === undefined ? 201 : 200 });
  };
  return { calls, f };
};
const ENV = { DATA_REPO: 'macdarenz-droid/zeroed-data', REPORTS_TOKEN: 'tok' };

describe('the reports repository (fail closed)', () => {
  it('writes the day and latest.json to a private repository, with the sha when a file exists', async () => {
    const g = github({ private: true, full_name: 'macdarenz-droid/zeroed-data' }, { 'reports/latest.json': 'abc' });
    expect(await writeReports(ENV, '2026-10-04', '{"x":1}', g.f)).toEqual({ ok: true });
    const puts = g.calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => c.url.split('/contents/')[1])).toEqual(['reports/2026-10-04.json', 'reports/latest.json']);
    expect(JSON.parse(puts[0]!.body!)).toEqual({ message: 'Summary 2026-10-04', content: btoa('{"x":1}\n') });
    expect(JSON.parse(puts[1]!.body!).sha).toBe('abc');
    expect(g.calls.every((c) => c.auth === 'Bearer tok')).toBe(true);
    // A late final for an older day leaves latest.json alone.
    const g2 = github({ private: true, full_name: 'macdarenz-droid/zeroed-data' });
    await writeReports(ENV, '2026-10-03', '{}', g2.f, 1000, false);
    expect(g2.calls.filter((c) => c.method === 'PUT').map((c) => c.url.split('/contents/')[1])).toEqual(['reports/2026-10-03.json']);
  });

  it('writes nothing to a public, unreadable, renamed or unnamed repository, or to this code repository in any case', async () => {
    const cases: [Partial<typeof ENV>, Parameters<typeof github>[0], RegExp][] = [
      [ENV, { private: false, full_name: ENV.DATA_REPO }, /not private/],
      [ENV, { full_name: ENV.DATA_REPO }, /not private/],
      [ENV, { private: true, full_name: 'macdarenz-droid/other' }, /another repository/],
      [ENV, 404, /HTTP 404/],
      [ENV, 401, /HTTP 401/],
      [{ ...ENV, DATA_REPO: CODE_REPO }, { private: true, full_name: CODE_REPO }, /public code repository/],
      [{ ...ENV, DATA_REPO: 'MACDARENZ-DROID/meme-SNIPE' }, { private: true, full_name: CODE_REPO }, /public code repository/],
      [{ ...ENV, DATA_REPO: 'macdarenz-droid/alias' }, { private: true, full_name: CODE_REPO }, /another repository/],
      [{ REPORTS_TOKEN: 'tok' }, { private: true, full_name: ENV.DATA_REPO }, /DATA_REPO is not set/],
      [{ ...ENV, DATA_REPO: 'https://github.com/x/y' }, { private: true, full_name: ENV.DATA_REPO }, /not owner\/name/],
      [{ DATA_REPO: ENV.DATA_REPO }, { private: true, full_name: ENV.DATA_REPO }, /REPORTS_TOKEN is not set/],
    ];
    for (const [env, meta, reason] of cases) {
      const g = github(meta);
      const r = await writeReports(env, '2026-10-04', '{}', g.f);
      expect(r.ok, String(reason)).toBe(false);
      if (!r.ok) {
        expect(r.reason).toMatch(reason);
        expect(r.reason).not.toContain('tok');
      }
      expect(g.calls.filter((c) => c.method !== 'GET' || c.url.includes('/contents/')), String(reason)).toEqual([]);
      // This code repository by name, unset or malformed: refused before any request, the token never sent.
      if (env.DATA_REPO === undefined || env.DATA_REPO.toLowerCase() === CODE_REPO.toLowerCase() || env.DATA_REPO.includes(':')) expect(g.calls, String(reason)).toEqual([]);
    }
    // A repository that does not answer is a failure too, with no write.
    const r = await writeReports(ENV, '2026-10-04', '{}', async () => Promise.reject(new TypeError('down')));
    expect(r).toEqual({ ok: false, reason: 'repository check did not answer' });
  });
});

// The Durable Object with in-memory storage; fetch serves Telegram and a scripted GitHub.
function harness(env: Partial<Env>, meta: Parameters<typeof github>[0] = { private: true, full_name: 'macdarenz-droid/zeroed-data' }) {
  const mem = new Map<string, unknown>();
  const state: DurableState = {
    storage: { get: async <T>(k: string) => mem.get(k) as T | undefined, put: async (k, v) => void mem.set(k, structuredClone(v)) },
    blockConcurrencyWhile: (fn) => fn(),
  };
  const telegram: string[] = [];
  const g = github(meta);
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/sendMessage')) {
      telegram.push((JSON.parse(String(init?.body)) as { text: string }).text);
      return Response.json({ ok: true });
    }
    if (u.startsWith('https://gh.test')) return g.f(u, init ?? {});
    return Response.json({ ok: true });
  }));
  const dob = new Watchdog(state, { HEARTBEAT_HMAC_KEY: KEY, TELEGRAM_BOT_TOKEN: 'TEST-token', TELEGRAM_API: 'https://tg.test', GITHUB_API: 'https://gh.test', CHAIN_RPC_URL: '', ...env } as Env);
  const signed = async (path: string, body: string, t: number, signPath = path) =>
    dob.fetch(new Request(`https://w.test${path}`, { method: 'POST', body, headers: { 'x-zeroed-signature': `t=${t},v1=${await sign(KEY, t, 'POST', signPath, body)}` } }));
  return { mem, dob, signed, telegram, g };
}

const hb = (seq: number, ts: number): Heartbeat => ({
  seq, ts, boot: 'b1', git_sha: 'a'.repeat(40), policy_version: 'p', last_processed_slot: null, feed_ages_ms: {}, open_position: null,
  unresolved_intents: { count: 0, oldest_age_s: null }, signer: 'none', lease_epoch: null, sol_reserve: null, paused: false, owner_chat_id: '42',
});

describe('/summary on the watchdog', () => {
  it('takes only a signature made for /summary, each time once, and writes the checked body', async () => {
    const h = harness(ENV);
    const t = Math.floor(Date.now() / 1000);
    const body = JSON.stringify(goodSummary());
    expect((await h.dob.fetch(new Request('https://w.test/summary', { method: 'POST', body }))).status).toBe(401);
    expect((await h.signed('/summary', body, t, '/heartbeat')).status).toBe(401);
    const ok = await h.signed('/summary', body, t);
    expect(await ok.json()).toEqual({ ok: true, written: true });
    expect(h.g.calls.filter((c) => c.method === 'PUT')).toHaveLength(2);
    expect((await h.signed('/summary', body, t)).status).toBe(409);
    vi.unstubAllGlobals();
  });

  it('a failed write alerts once as "summary", clears on the next good write, and never touches the heartbeat or the pause', async () => {
    const h = harness(ENV, { private: false, full_name: ENV.DATA_REPO });
    const now = Date.now();
    const t = Math.floor(now / 1000);
    await h.signed('/heartbeat', JSON.stringify(hb(1, now)), t);
    h.mem.set('paused', { at: 1 });
    const r = await h.signed('/summary', JSON.stringify(goodSummary()), t + 1);
    expect(await r.json()).toEqual({ ok: true, written: false });
    expect(h.g.calls.filter((c) => c.method === 'PUT')).toEqual([]);
    expect((await h.dob.check(now)).sent).toEqual(['ALERT Daily summary not written: DATA_REPO is not private.']);
    // The heartbeat still goes through and still carries the pause.
    expect(await (await h.signed('/heartbeat', JSON.stringify(hb(2, now + 1)), t + 2)).json()).toEqual({ ok: true, paused: true });
    // Fixed (private now): the next summary writes and the alert clears.
    h.g.calls.length = 0;
    const fixed = harness(ENV);
    for (const [k, v] of h.mem) fixed.mem.set(k, v);
    expect(await (await fixed.signed('/summary', JSON.stringify(goodSummary()), t + 3)).json()).toEqual({ ok: true, written: true });
    expect((await fixed.dob.check(now)).sent).toEqual(['CLEARED Daily summary not written: DATA_REPO is not private.']);
    vi.unstubAllGlobals();
  });

  it('refuses a body with a planted secret (400) and alerts; with nothing set up it writes nothing and stays quiet', async () => {
    const h = harness(ENV);
    const t = Math.floor(Date.now() / 1000);
    const bad = JSON.stringify(goodSummary({ worker: { ...goodSummary().worker, entry_rule: 'zeroed-tail1234-ts-net' } })).replace('zeroed-tail1234-ts-net', 'x.ts.net');
    expect((await h.signed('/summary', bad, t)).status).toBe(400);
    expect(h.g.calls).toEqual([]);
    expect((await h.dob.check(Date.now())).sent).toEqual(['ALERT Daily summary not written: refused (not the summary shape).']);
    vi.unstubAllGlobals();
    const quiet = harness({});
    expect(await (await quiet.signed('/summary', JSON.stringify(goodSummary()), t)).json()).toEqual({ ok: true, written: false });
    expect(quiet.g.calls).toEqual([]);
    expect((await quiet.dob.check(Date.now())).sent).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('a token without DATA_REPO alerts; with neither set, a stored failure is cleared and nothing alerts', async () => {
    const h = harness({ REPORTS_TOKEN: 'tok' });
    const t = Math.floor(Date.now() / 1000);
    expect(await (await h.signed('/summary', JSON.stringify(goodSummary()), t)).json()).toEqual({ ok: true, written: false });
    expect((await h.dob.check(Date.now())).sent).toEqual(['ALERT Daily summary not written: DATA_REPO is not set.']);
    vi.unstubAllGlobals();
    // The setup removed: the next summary clears the stored failure, and the alert clears with it.
    const off = harness({});
    for (const [k, v] of h.mem) off.mem.set(k, v);
    expect(await (await off.signed('/summary', JSON.stringify(goodSummary()), t + 1)).json()).toEqual({ ok: true, written: false });
    expect(off.mem.get('summary_failure')).toBeNull();
    expect((await off.dob.check(Date.now())).sent).toEqual(['CLEARED Daily summary not written: DATA_REPO is not set.']);
    expect((await off.dob.check(Date.now())).sent).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('latest.json moves only forward: a late final for an earlier day writes only its own file', async () => {
    const h = harness(ENV);
    const t = Math.floor(Date.now() / 1000);
    await h.signed('/summary', JSON.stringify(goodSummary({ day: '2026-10-05' })), t);
    h.g.calls.length = 0;
    await h.signed('/summary', JSON.stringify(goodSummary({ day: '2026-10-04', final: true })), t + 1);
    expect(h.g.calls.filter((c) => c.method === 'PUT').map((c) => c.url.split('/contents/')[1])).toEqual(['reports/2026-10-04.json']);
    vi.unstubAllGlobals();
  });
});
