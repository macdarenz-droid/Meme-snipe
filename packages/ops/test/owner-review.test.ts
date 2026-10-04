// OWNER-REVIEW on the watchdog: /review, /rearm and /weekly show the worker's evidence and queue a confirm only for the
// trip the worker reports open; the heartbeat reply carries the queue and the worker's acknowledgements settle it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMMAND_TTL_MS, confirmedTrip, parseCommand, queueConfirm, reviewOf, settleAcks, sign, signReply, solText, stopText, type Heartbeat, type PendingCommand, type Review } from '../src/watchdog/logic.ts';
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
const DAY = 1_799_938_800_000;
const OVERRIDE = { trip: `override-${DAY}-1`, evidence: { daily: 1, streak: 2, day_loss_lamports: '16000000', day_limit_lamports: '15000000', overrides: 1, day_ends_ms: DAY + 86_400_000 } };
const upd = (text: string, chat = 42) => JSON.stringify({ message: { chat: { id: chat }, text } });

function harness(mem = new Map<string, unknown>(), extraEnv: Partial<Env> = {}) {
  const state: DurableState = {
    storage: { get: async <T>(k: string) => mem.get(k) as T | undefined, put: async (k, v) => void mem.set(k, structuredClone(v)) },
    blockConcurrencyWhile: (fn) => fn(),
  };
  const sent: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('/sendMessage')) sent.push((JSON.parse(String(init?.body)) as { text: string }).text);
    return new Response(JSON.stringify({ ok: true }));
  }));
  const env = { HEARTBEAT_HMAC_KEY: KEY, TELEGRAM_BOT_TOKEN: 'TEST-token', TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_API: 'https://tg.test', ...extraEnv } as Env;
  const dob = new Watchdog(state, env);
  const post = (path: string, body: string, headers: Record<string, string> = {}) => dob.fetch(new Request(`https://w.test${path}`, { method: 'POST', body, headers }));
  let seq = 0;
  /** One signed heartbeat; the reply, its signature header and the heartbeat's own v1 are kept in `last`. */
  const last = { text: '', sig: '', v1: '' };
  const beat = async (over: Partial<Heartbeat> = {}, key = KEY) => {
    seq++;
    const body = JSON.stringify(hb({ seq, ts: T0 + seq, ...over }));
    const t = Math.floor(Date.now() / 1000);
    last.v1 = await sign(key, t, 'POST', '/heartbeat', body);
    const r = await post('/heartbeat', body, { 'x-zeroed-signature': `t=${t},v1=${last.v1}` });
    last.text = await r.text();
    last.sig = r.headers.get('x-zeroed-signature') ?? '';
    return JSON.parse(last.text) as { ok: boolean; paused: boolean; commands?: { id: string; kind: string; trip: string; at: number }[] };
  };
  const tg = (text: string, chat = 42, secret = SECRET) => post('/telegram', upd(text, chat), { 'x-telegram-bot-api-secret-token': secret });
  return { mem, sent, beat, tg, last, dob };
}

afterEach(() => vi.unstubAllGlobals());

describe('owner review commands: parsing', () => {
  it('knows /review, /rearm and /weekly (with a bot suffix) only from the owner chat, and a confirm only as "<command> confirm <trip>"', () => {
    const u = (text: string, chat = 42) => ({ message: { chat: { id: chat }, text } });
    expect(parseCommand(u('/review'), '42')).toBe('review');
    expect(parseCommand(u('/rearm@ZeroedBot confirm rearm-1'), '42')).toBe('rearm');
    expect(parseCommand(u('/WEEKLY'), '42')).toBe('weekly');
    expect(parseCommand(u('/override'), '42')).toBe('override');
    expect(parseCommand(u('/overrides'), '42')).toBe('other');
    expect(confirmedTrip(u(`/override confirm override-${DAY}-0`), '42')).toBe(`override-${DAY}-0`);
    expect(confirmedTrip(u(`/override confirm override-${DAY}`), '42')).toBeNull();
    expect(confirmedTrip(u(`/override confirm override-${DAY}-12345`), '42')).toBeNull();
    expect(parseCommand(u('/review'), '7')).toBeNull();
    // No paired chat yet: nothing is a command, not even from a chat with an empty id.
    expect(parseCommand(u('/review'), '')).toBeNull();
    expect(parseCommand({ message: { chat: {}, text: '/rearm' } }, '')).toBeNull();
    expect(confirmedTrip({ message: { chat: {}, text: `/rearm confirm rearm-${KILL_AT}` } }, '')).toBeNull();
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
    expect(reviewOf(hb())).toEqual({ review: null, rearm: null, weekly: null, override: null });
    expect(reviewOf(hb({ review: 'x' }))).toEqual({ review: null, rearm: null, weekly: null, override: null });
    // An override trip has its own form (the day and its overrides); another kind's form is dropped.
    expect(reviewOf(hb({ review: { override: OVERRIDE } })).override).toEqual(OVERRIDE);
    expect(reviewOf(hb({ review: { override: { ...OVERRIDE, trip: `override-${DAY}` } } })).override).toBeNull();
    expect(reviewOf(hb({ review: { rearm: { ...OVERRIDE } } })).rearm).toBeNull();
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
    const o = stopText('override', reviewOf(hb({ review: { override: OVERRIDE } })).override);
    expect(o).toContain('daily loss and 2 losses in a row');
    expect(o).toContain('Day loss 0.016 SOL (daily limit 0.015 SOL)');
    expect(o).toContain('Overrides today: 1');
    expect(o).toContain('The weekly loss, the kill switch and the loss review still apply.');
    expect(o).toContain(`/override confirm override-${DAY}-1`);
    expect(stopText('override', null)).toBe('Day stop (R7, R8 streak): not tripped.');
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
    expect(r1.commands).toEqual([{ id: `rearm-${KILL_AT}`, kind: 'rearm', trip: `rearm-${KILL_AT}`, at: expect.any(Number) }]);
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
    expect(h.sent.at(-1)).toBe('Commands: /pause, /status, /review, /rearm, /weekly, /override');
  });

  it('/override shows the day stop and queues its confirm like the others', async () => {
    const h = harness();
    await h.beat({ review: { ...REVIEW, override: OVERRIDE } });
    await h.tg('/override');
    expect(h.sent.at(-1)).toContain(`/override confirm override-${DAY}-1`);
    await h.tg(`/override confirm override-${DAY}-0`);
    expect(h.sent.at(-1)).toContain('Not queued');
    await h.tg(`/override confirm override-${DAY}-1`);
    expect(h.sent.at(-1)).toContain('Queued');
    expect((await h.beat({ review: { ...REVIEW, override: OVERRIDE } })).commands?.map((c) => c.trip)).toEqual([`override-${DAY}-1`]);
  });

  it('a stale acknowledgement tells the owner the trip was refused', async () => {
    const h = harness();
    await h.beat({ review: REVIEW });
    await h.tg(`/review confirm review-${R8_AT}`);
    await h.beat({ review: REVIEW, acked: [{ id: `review-${R8_AT}`, result: 'stale' }] });
    expect(h.sent.at(-1)).toBe(`Refused: /review for review-${R8_AT} is no longer the current trip.`);
    expect(h.mem.get('owner_cmds')).toEqual([]);
  });
  it('signs every heartbeat reply with the key that verified it, bound to that heartbeat, through a key rotation too', async () => {
    const h = harness(new Map(), { HEARTBEAT_HMAC_KEY_A: 'offered-key-0123456789abcdef' });
    const r = await h.beat({ review: REVIEW });
    expect(r).toEqual({ ok: true, paused: false });
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(h.last.sig)!;
    expect(m[2]).toBe(await signReply(KEY, Number(m[1]), '/heartbeat', h.last.v1, h.last.text));
    // Bound to the heartbeat: the same reply under another heartbeat's signature does not verify.
    expect(m[2]).not.toBe(await signReply(KEY, Number(m[1]), '/heartbeat', '0'.repeat(64), h.last.text));
    // The server beats with the offered key: the reply is signed with that key, and the offer becomes active.
    await h.beat({ review: REVIEW }, 'offered-key-0123456789abcdef');
    const n = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(h.last.sig)!;
    expect(n[2]).toBe(await signReply('offered-key-0123456789abcdef', Number(n[1]), '/heartbeat', h.last.v1, h.last.text));
    expect(h.mem.get('ring:HEARTBEAT_HMAC_KEY')).toMatchObject({ active: 'A' });
  });

  it('a confirm not delivered within 15 minutes expires with a line; one already sent waits for the worker, which may answer expired', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(T0);
      const h = harness();
      await h.beat({ review: REVIEW });
      await h.tg(`/rearm confirm rearm-${KILL_AT}`);
      await h.tg(`/review confirm review-${R8_AT}`);
      // The review confirm is sent; the worker then goes quiet.
      vi.setSystemTime(T0 + 60_000);
      expect((await h.beat({ review: REVIEW })).commands?.map((c) => [c.kind, c.at])).toEqual([['rearm', T0], ['review', T0]]);
      await h.tg(`/rearm confirm rearm-${KILL_AT}`);
      // At exactly 15 minutes nothing expires.
      vi.setSystemTime(T0 + 60_000 + COMMAND_TTL_MS);
      await h.dob.check(Date.now());
      expect((h.mem.get('owner_cmds') as PendingCommand[]).map((p) => p.kind)).toEqual(['review', 'rearm']);
      vi.setSystemTime(T0 + 60_000 + COMMAND_TTL_MS + 1);
      await h.dob.check(Date.now());
      // The rearm confirm (re-sent at +1 min, never delivered) expires; the review one was delivered and waits.
      expect(h.sent.at(-1)).toBe(`Expired: /rearm for rearm-${KILL_AT} was not delivered within 15 minutes. Send it again.`);
      expect((h.mem.get('owner_cmds') as PendingCommand[]).map((p) => p.kind)).toEqual(['review']);
      // The worker answers expired: the owner is told to send it again.
      await h.beat({ review: REVIEW, acked: [{ id: `review-${R8_AT}`, result: 'expired' }] });
      expect(h.sent.at(-1)).toBe(`Expired: /review for review-${R8_AT} reached the worker more than 15 minutes after the confirm. Send it again.`);
      expect(h.mem.get('owner_cmds')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
