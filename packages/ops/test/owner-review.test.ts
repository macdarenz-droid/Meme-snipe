// OWNER-REVIEW on the watchdog: /review, /rearm and /weekly show the worker's evidence and queue a confirm only for the
// trip the worker reports open; the heartbeat reply carries the queue and the worker's acknowledgements settle it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmedTrip, parseCommand, queueConfirm, reviewOf, settleAcks, sign, solText, stopText, type Heartbeat, type PendingCommand, type Review } from '../src/watchdog/logic.ts';
import { Watchdog, type DurableState, type Env } from '../src/watchdog/worker.ts';

const KEY = 'test-hmac-key-0123456789abcdef';
const SECRET = 'hook-secret';
const T0 = 1_800_000_000_000;
const KILL_AT = 1_799_990_000_000;
const R8_AT = 1_799_980_000_000;

const hb = (over: Partial<Heartbeat> = {}): Heartbeat => ({
  seq: 1, ts: T0, boot: 'b1', git_sha: 'a'.repeat(40), policy_version: 'stub', last_processed_slot: null, feed_ages_ms: {},
  open_position: null, unresolved_intents: { count: 0, oldest_age_s: null }, signer: 'not-ready', lease_epoch: null, sol_reserve: null,
  paused: false, owner_chat_id: '42', ...over,
});
const REVIEW = {
  review: { trip: `review-${R8_AT}`, evidence: { losses: 5, trades: 20, from_ms: R8_AT - 3_600_000, to_ms: R8_AT, net_lamports: '-12300000' } },
  rearm: { trip: `rearm-${KILL_AT}`, evidence: { tripped_ms: KILL_AT, equity_lamports: '140000000', nav_lamports: '130000000', nav_peak_lamports: '200000000' } },
  weekly: null,
};
const upd = (text: string, chat = 42) => JSON.stringify({ message: { chat: { id: chat }, text } });

function harness(mem = new Map<string, unknown>()) {
  const state: DurableState = {
    storage: { get: async <T>(k: string) => mem.get(k) as T | undefined, put: async (k, v) => void mem.set(k, structuredClone(v)) },
    blockConcurrencyWhile: (fn) => fn(),
  };
  const sent: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('/sendMessage')) sent.push((JSON.parse(String(init?.body)) as { text: string }).text);
    return new Response(JSON.stringify({ ok: true }));
  }));
  const env = { HEARTBEAT_HMAC_KEY: KEY, TELEGRAM_BOT_TOKEN: 'TEST-token', TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_API: 'https://tg.test' } as Env;
  const dob = new Watchdog(state, env);
  const post = (path: string, body: string, headers: Record<string, string> = {}) => dob.fetch(new Request(`https://w.test${path}`, { method: 'POST', body, headers }));
  let seq = 0;
  const beat = async (over: Partial<Heartbeat> = {}) => {
    seq++;
    const body = JSON.stringify(hb({ seq, ts: T0 + seq, ...over }));
    const t = Math.floor(Date.now() / 1000);
    const r = await post('/heartbeat', body, { 'x-zeroed-signature': `t=${t},v1=${await sign(KEY, t, 'POST', '/heartbeat', body)}` });
    return (await r.json()) as { ok: boolean; paused: boolean; commands?: { id: string; kind: string; trip: string }[] };
  };
  const tg = (text: string, chat = 42, secret = SECRET) => post('/telegram', upd(text, chat), { 'x-telegram-bot-api-secret-token': secret });
  return { mem, sent, beat, tg };
}

afterEach(() => vi.unstubAllGlobals());

describe('owner review commands: parsing', () => {
  it('knows /review, /rearm and /weekly (with a bot suffix) only from the owner chat, and a confirm only as "<command> confirm <trip>"', () => {
    const u = (text: string, chat = 42) => ({ message: { chat: { id: chat }, text } });
    expect(parseCommand(u('/review'), '42')).toBe('review');
    expect(parseCommand(u('/rearm@ZeroedBot confirm rearm-1'), '42')).toBe('rearm');
    expect(parseCommand(u('/WEEKLY'), '42')).toBe('weekly');
    expect(parseCommand(u('/override'), '42')).toBe('other');
    expect(parseCommand(u('/review'), '7')).toBeNull();
    expect(confirmedTrip(u(`/rearm confirm rearm-${KILL_AT}`), '42')).toBe(`rearm-${KILL_AT}`);
    expect(confirmedTrip(u(`/rearm Confirm rearm-${KILL_AT}`), '42')).toBe(`rearm-${KILL_AT}`);
    expect(confirmedTrip(u(`/rearm confirm rearm-${KILL_AT}`, 7), '42')).toBeNull();
    expect(confirmedTrip(u(`/rearm rearm-${KILL_AT}`), '42')).toBeNull();
    expect(confirmedTrip(u(`/rearm confirm rearm-${KILL_AT} now`), '42')).toBeNull();
    expect(confirmedTrip(u('/rearm confirm kill-1'), '42')).toBeNull();
    expect(confirmedTrip(u('/rearm confirm rearm-12x'), '42')).toBeNull();
  });

  it('reads the review block field by field: a trip of another kind, a bad trip or bad evidence values are dropped', () => {
    const r = reviewOf(hb({
      review: {
        review: { trip: `rearm-${KILL_AT}`, evidence: {} },
        rearm: { trip: `rearm-${KILL_AT}`, evidence: { tripped_ms: KILL_AT, equity_lamports: '140000000', nav_lamports: '1.5', BAD: 1, nav_peak_lamports: Infinity } },
        weekly: { trip: 'weekly-x', evidence: {} },
      },
    }));
    expect(r.review).toBeNull();
    expect(r.weekly).toBeNull();
    expect(r.rearm).toEqual({ trip: `rearm-${KILL_AT}`, evidence: { tripped_ms: KILL_AT, equity_lamports: '140000000' } });
    expect(reviewOf(hb())).toEqual({ review: null, rearm: null, weekly: null });
    expect(reviewOf(hb({ review: 'x' }))).toEqual({ review: null, rearm: null, weekly: null });
  });

  it('shows lamports as exact SOL', () => {
    expect(solText('-12300000')).toBe('-0.0123 SOL');
    expect(solText('1000000000')).toBe('1 SOL');
    expect(solText('12345678901')).toBe('12.345678901 SOL');
    expect(solText('5')).toBe('0.000000005 SOL');
    expect(solText('0')).toBe('0 SOL');
    expect(solText(null)).toBe('unknown');
    expect(solText(5)).toBe('unknown');
  });

  it('a stop shows its evidence in SOL and the exact confirm line; none open says so', () => {
    const r = reviewOf(hb({ review: REVIEW }));
    const text = stopText('review', r.review);
    expect(text).toContain('5 losses in 20 trades');
    expect(text).toContain('-0.0123 SOL');
    expect(text).toContain('Melbourne');
    expect(text).toContain(`/review confirm review-${R8_AT}`);
    expect(stopText('rearm', r.rearm)).toContain('Equity 0.14 SOL, NAV 0.13 SOL, NAV peak 0.2 SOL');
    expect(stopText('weekly', r.weekly)).toBe('Weekly loss (R9): not tripped.');
  });

  it('queues a confirm only for the trip open for that command, one per command; acks settle each once', () => {
    const r: Review = reviewOf(hb({ review: REVIEW }));
    expect(queueConfirm([], r, 'review', `rearm-${KILL_AT}`, T0).queued).toBe(false);
    expect(queueConfirm([], r, 'weekly', `weekly-${KILL_AT}`, T0).queued).toBe(false);
    const a = queueConfirm([], r, 'rearm', `rearm-${KILL_AT}`, T0);
    expect(a).toEqual({ queued: true, pending: [{ id: `rearm-${KILL_AT}`, kind: 'rearm', trip: `rearm-${KILL_AT}`, at: T0 }] });
    const b = queueConfirm(a.pending, r, 'review', `review-${R8_AT}`, T0 + 1);
    expect(b.pending.map((p) => p.kind)).toEqual(['rearm', 'review']);
    expect(queueConfirm(b.pending, r, 'rearm', `rearm-${KILL_AT}`, T0 + 2).pending.map((p) => p.kind)).toEqual(['review', 'rearm']);
    const s = settleAcks(b.pending, [{ id: `rearm-${KILL_AT}`, result: 'applied' }, { id: 'other', result: 'stale' }]);
    expect(s.lines).toEqual([`Applied: /rearm for rearm-${KILL_AT}.`]);
    expect(s.pending.map((p: PendingCommand) => p.kind)).toEqual(['review']);
    expect(settleAcks(s.pending, [{ id: `review-${R8_AT}`, result: 'stale' }]).lines).toEqual([`Refused: /review for review-${R8_AT} is no longer the current trip.`]);
    expect(settleAcks(s.pending, [{ id: `review-${R8_AT}`, result: 'invalid' }]).lines[0]).toContain('not understood');
  });
});

describe('owner review commands: the Durable Object', () => {
  it('shows, queues, survives a restart, goes out in the reply until acknowledged, and tells the owner the result once', async () => {
    const h = harness();
    await h.beat({ review: REVIEW });
    await h.tg('/rearm');
    expect(h.sent.at(-1)).toContain(`/rearm confirm rearm-${KILL_AT}`);
    // Each command clears only its own stop: the kill trip under /review is refused here, before the worker.
    await h.tg(`/review confirm rearm-${KILL_AT}`);
    expect(h.sent.at(-1)).toContain('Not queued');
    await h.tg(`/rearm confirm rearm-${KILL_AT - 1}`);
    expect(h.sent.at(-1)).toContain('Not queued');
    expect(h.mem.get('owner_cmds')).toBeUndefined();
    await h.tg(`/rearm confirm rearm-${KILL_AT}`);
    expect(h.sent.at(-1)).toContain('Queued');
    // A restart of the Durable Object between the confirm and the next heartbeat keeps the command.
    const after = harness(h.mem);
    const r1 = await after.beat({ review: REVIEW, seq: 10, ts: T0 + 10 });
    expect(r1.commands).toEqual([{ id: `rearm-${KILL_AT}`, kind: 'rearm', trip: `rearm-${KILL_AT}` }]);
    // Not acknowledged yet (the worker was not ready): sent again.
    expect((await after.beat({ review: REVIEW, seq: 11, ts: T0 + 11 })).commands).toHaveLength(1);
    const r2 = await after.beat({ review: { ...REVIEW, rearm: null }, acked: [{ id: `rearm-${KILL_AT}`, result: 'applied' }], seq: 12, ts: T0 + 12 });
    expect(r2.commands).toBeUndefined();
    expect(after.sent).toEqual([`Applied: /rearm for rearm-${KILL_AT}.`]);
    // The worker keeps acknowledging it; the owner hears it once.
    await after.beat({ review: { ...REVIEW, rearm: null }, acked: [{ id: `rearm-${KILL_AT}`, result: 'applied' }], seq: 13, ts: T0 + 13 });
    expect(after.sent).toHaveLength(1);
    // Applied: the stop is no longer open, so the same confirm is not queued again.
    await after.tg(`/rearm confirm rearm-${KILL_AT}`);
    expect(after.sent.at(-1)).toContain('Not queued');
    expect(after.mem.get('owner_cmds')).toEqual([]);
  });

  it('a stranger, a wrong webhook secret or a heartbeat without a review block queues nothing', async () => {
    const h = harness();
    await h.beat({ review: REVIEW });
    await h.tg(`/rearm confirm rearm-${KILL_AT}`, 7);
    expect((await h.tg(`/rearm confirm rearm-${KILL_AT}`, 42, 'wrong')).status).toBe(401);
    expect(h.mem.get('owner_cmds')).toBeUndefined();
    expect(h.sent).toEqual([]);
    await h.beat();
    await h.tg(`/rearm confirm rearm-${KILL_AT}`);
    expect(h.sent.at(-1)).toContain('Not queued');
    await h.tg('/review');
    expect(h.sent.at(-1)).toBe('Loss review (R8): not tripped.');
    await h.tg('/help');
    expect(h.sent.at(-1)).toBe('Commands: /pause, /status, /review, /rearm, /weekly');
  });

  it('a stale acknowledgement tells the owner the trip was refused', async () => {
    const h = harness();
    await h.beat({ review: REVIEW });
    await h.tg(`/review confirm review-${R8_AT}`);
    await h.beat({ review: REVIEW, acked: [{ id: `review-${R8_AT}`, result: 'stale' }] });
    expect(h.sent.at(-1)).toBe(`Refused: /review for review-${R8_AT} is no longer the current trip.`);
    expect(h.mem.get('owner_cmds')).toEqual([]);
  });
});
