import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MAX_LISTED, chunkLines, evaluate, isNewer, limitsFrom, parseCommand, parseHeartbeat, planAlerts, sign, statusText, takeLease, unsent, verifySignature, type Heartbeat, type Stored } from '../src/watchdog/logic.ts';
import worker, { Watchdog, type DurableState, type Env } from '../src/watchdog/worker.ts';

const KEY = 'test-hmac-key-0123456789abcdef';
const L = limitsFrom({});
const T0 = 1_800_000_000_000;

const hb = (over: Partial<Heartbeat> = {}): Heartbeat => ({
  seq: 1,
  ts: T0,
  boot: 'b1',
  git_sha: 'a'.repeat(40),
  policy_version: 'stub',
  last_processed_slot: null,
  feed_ages_ms: {},
  open_position: null,
  unresolved_intents: { count: 0, oldest_age_s: null },
  signer: 'not-ready',
  lease_epoch: null,
  sol_reserve: null,
  paused: false,
  ...over,
});
const stored = (h: Heartbeat, receivedAt = T0): Stored => ({ hb: h, receivedAt });
const noChain = { slot: null, heldMints: null };

describe('heartbeat signature', () => {
  it('matches the host side (node:crypto HMAC over "t\\nMETHOD\\npath\\nbody")', async () => {
    const body = '{"seq":1}';
    const t = 1_800_000_000;
    expect(await sign(KEY, t, 'POST', '/heartbeat', body)).toBe(createHmac('sha256', KEY).update(`${t}\nPOST\n/heartbeat\n${body}`).digest('hex'));
  });

  it('accepts a fresh signature and refuses tampering, another route, a wrong key, skew and malformed headers', async () => {
    const body = '{"seq":1}';
    const t = 1_800_000_000;
    const h = `t=${t},v1=${await sign(KEY, t, 'POST', '/heartbeat', body)}`;
    expect(await verifySignature(h, 'POST', '/heartbeat', body, KEY, t)).toBe(t);
    expect(await verifySignature(h, 'POST', '/heartbeat', body + ' ', KEY, t)).toBeNull();
    expect(await verifySignature(h, 'POST', '/resume', body, KEY, t)).toBeNull();
    expect(await verifySignature(h, 'POST', '/heartbeat', body, 'other-key', t)).toBeNull();
    expect(await verifySignature(h, 'POST', '/heartbeat', body, KEY, t + 301)).toBeNull();
    expect(await verifySignature(h, 'POST', '/heartbeat', body, '', t)).toBeNull();
    expect(await verifySignature(null, 'POST', '/heartbeat', body, KEY, t)).toBeNull();
    expect(await verifySignature(`t=${t},v1=zz`, 'POST', '/heartbeat', body, KEY, t)).toBeNull();
  });

  it('a heartbeat is newer only if later in time, and from a new boot or a higher sequence', () => {
    const prev = stored(hb({ seq: 5, ts: T0, boot: 'b1' }));
    expect(isNewer(prev, hb({ seq: 6, ts: T0 + 1, boot: 'b1' }))).toBe(true);
    expect(isNewer(prev, hb({ seq: 4, ts: T0 + 1, boot: 'b1' }))).toBe(false);
    expect(isNewer(prev, hb({ seq: 1, ts: T0 + 1, boot: 'b2' }))).toBe(true);
    expect(isNewer(prev, hb({ seq: 1, ts: T0, boot: 'b2' }))).toBe(false);
    expect(isNewer(prev, hb({ seq: 9, ts: T0 - 1, boot: 'b0' }))).toBe(false);
  });

  it('rejects bodies that are not heartbeats', () => {
    expect(parseHeartbeat('not json')).toBeNull();
    expect(parseHeartbeat('{"seq":"1"}')).toBeNull();
    expect(parseHeartbeat(JSON.stringify(hb()))).not.toBeNull();
  });
});

describe('checks', () => {
  it('says nothing before the first heartbeat, and nothing for a healthy one', () => {
    expect(evaluate(undefined, T0, L, noChain)).toEqual([]);
    expect(evaluate(stored(hb()), T0 + 30_000, L, noChain)).toEqual([]);
  });

  it('flags a heartbeat older than 90 s', () => {
    expect(evaluate(stored(hb()), T0 + 90_000, L, noChain)).toEqual([]);
    expect(evaluate(stored(hb()), T0 + 91_000, L, noChain).map((a) => a.key)).toEqual(['heartbeat']);
  });

  it('flags slot lag against the independent RPC', () => {
    const s = stored(hb({ last_processed_slot: 1000 }));
    expect(evaluate(s, T0, L, { slot: 1150, heldMints: null })).toEqual([]);
    expect(evaluate(s, T0, L, { slot: 1151, heldMints: null }).map((a) => a.key)).toEqual(['slot_lag']);
  });

  it('flags on-chain position mismatches both ways', () => {
    const pos = { mint: 'MintA', qty: 1, entry: 1, stop: 0.5, mark: 1, last_exit_attempt_ts: null };
    expect(evaluate(stored(hb({ open_position: pos })), T0, L, { slot: null, heldMints: [] }).map((a) => a.key)).toEqual(['position:MintA']);
    expect(evaluate(stored(hb()), T0, L, { slot: null, heldMints: ['MintB'] }).map((a) => a.key)).toEqual(['position_unreported']);
    expect(evaluate(stored(hb({ open_position: pos })), T0, L, { slot: null, heldMints: ['MintA'] })).toEqual([]);
  });

  it('flags a breached stop with no exit attempt in 60 s', () => {
    const pos = (last: number | null) => ({ mint: 'MintA', qty: 1, entry: 1, stop: 0.5, mark: 0.4, last_exit_attempt_ts: last });
    expect(evaluate(stored(hb({ open_position: pos(null) })), T0, L, noChain).map((a) => a.key)).toEqual(['stop:MintA']);
    expect(evaluate(stored(hb({ open_position: pos(T0 - 30_000) })), T0, L, noChain)).toEqual([]);
    expect(evaluate(stored(hb({ open_position: pos(T0 - 61_000) })), T0, L, noChain).map((a) => a.key)).toEqual(['stop:MintA']);
  });

  it('checks the stop of every open position, not only the first (ALERT-EXIT N3)', () => {
    const a = { mint: 'MintA', qty: 1, entry: 1, stop: 0.5, mark: 0.9, last_exit_attempt_ts: null };
    const b = { mint: 'MintB', qty: 1, entry: 1, stop: 0.5, mark: 0.4, last_exit_attempt_ts: null };
    // The second position is below its stop; the first is fine.
    expect(evaluate(stored(hb({ open_position: a, open_positions: [a, b] })), T0, L, noChain)).toEqual([
      { key: 'stop:MintB', text: 'MintB is below its stop with no exit attempt in the last 60 s.' },
    ]);
    // Both below: one alert each.
    expect(evaluate(stored(hb({ open_position: a, open_positions: [{ ...a, mark: 0.4 }, b] })), T0, L, noChain).map((x) => x.key)).toEqual(['stop:MintA', 'stop:MintB']);
    // Every reported mint is matched against the wallet.
    expect(evaluate(stored(hb({ open_position: a, open_positions: [a, { ...b, mark: 1 }] })), T0, L, { slot: null, heldMints: ['MintA'] }).map((x) => x.key)).toEqual(['position:MintB']);
    expect(evaluate(stored(hb({ open_position: a, open_positions: [a, { ...b, mark: 1 }] })), T0, L, { slot: null, heldMints: ['MintA', 'MintB'] })).toEqual([]);
    // An older sender without the list: its one position still counts.
    expect(evaluate(stored(hb({ open_position: { ...a, mark: 0.4 } })), T0, L, noChain).map((x) => x.key)).toEqual(['stop:MintA']);
    expect(statusText(stored(hb({ open_position: a, open_positions: [a, b] })), T0, null, {}, null)).toContain('Positions: MintA, stop 0.5; MintB, stop 0.5.');
  });

  it(`reads at most ${MAX_LISTED} open positions and critical lines, and says what it cut`, () => {
    const p = (i: number) => ({ mint: `M${i}`, qty: 1, entry: 1, stop: 0.5, mark: 1, last_exit_attempt_ts: null });
    const big = parseHeartbeat(JSON.stringify(hb({ open_positions: Array.from({ length: 70 }, (_, i) => p(i)), critical: Array.from({ length: 80 }, (_, i) => `c${i}`) })))!;
    expect(big.open_positions).toHaveLength(MAX_LISTED);
    expect(big.critical).toHaveLength(MAX_LISTED);
    expect(big.critical!.slice(-2)).toEqual([`70 open positions reported, only the first ${MAX_LISTED} are checked`, `18 more critical alerts (see the app)`]);
    expect(big.critical![61]).toBe('c61');
    const small = parseHeartbeat(JSON.stringify(hb({ open_positions: [p(1)], critical: ['c'] })))!;
    expect(small.critical).toEqual(['c']);
    expect(small.open_positions).toHaveLength(1);
  });

  it('chunks lines on their boundaries, and cuts only a line longer than a message', () => {
    expect(chunkLines(['a', 'b', 'c'], 3)).toEqual({ texts: ['a\nb', 'c'], ends: [2, 3] });
    expect(chunkLines(['abcdefg', 'h'], 3)).toEqual({ texts: ['abc', 'def', 'g', 'h'], ends: [0, 0, 1, 2] });
    expect(chunkLines([], 3)).toEqual({ texts: [], ends: [] });
  });

  it('flags old unresolved intents, a low reserve and an unreachable signer', () => {
    const keys = evaluate(stored(hb({ unresolved_intents: { count: 2, oldest_age_s: 91 }, sol_reserve: 0.01, signer: 'unreachable' })), T0, L, noChain).map((a) => a.key);
    expect(keys).toEqual(['intent', 'reserve', 'signer']);
  });
});

describe('alert dedupe and escalation', () => {
  it('flags the worker\'s own critical alerts (WATCH-1), and nothing for an empty or missing list', () => {
    const a = evaluate(stored(hb({ critical: ['MintA: no fresh price (timeout)'] })), T0, L, noChain);
    expect(a).toEqual([{ key: 'worker_critical:MintA: no fresh price', text: 'Worker critical: MintA: no fresh price (timeout).' }]);
    expect(evaluate(stored(hb({ critical: [] })), T0, L, noChain)).toEqual([]);
    expect(evaluate(stored(hb()), T0, L, noChain)).toEqual([]);
  });

  it('one alert per critical line, so a new one is pushed at once while another is up (ALERT-EXIT B1)', () => {
    const watch = 'MintA: no fresh price (timeout)';
    const blocked = 'MintB: exit blocked, position p:MintB:1 (no quote: no-liquidity)';
    const first = planAlerts({}, evaluate(stored(hb({ critical: [watch] })), T0, L, noChain), T0, L);
    expect(first.lines).toEqual([`ALERT Worker critical: ${watch}.`]);
    // A minute later an exit is blocked: it is sent now, not at the first alert's repeat.
    const second = planAlerts(first.next, evaluate(stored(hb({ critical: [watch, blocked] })), T0 + 60_000, L, noChain), T0 + 60_000, L);
    expect(second.lines).toEqual([`ALERT Worker critical: ${blocked}.`]);
    // A changed reason is the same alert: no new push, the text follows.
    const third = planAlerts(second.next, evaluate(stored(hb({ critical: ['MintA: no fresh price (HTTP 429)', blocked] })), T0 + 90_000, L, noChain), T0 + 90_000, L);
    expect(third.lines).toEqual([]);
    expect(third.next['worker_critical:MintA: no fresh price']!.text).toBe('Worker critical: MintA: no fresh price (HTTP 429).');
  });

  it('sends once, repeats every 5 min in the first hour, then hourly, and always sends a cleared line', () => {
    const a = [{ key: 'heartbeat', text: 'No heartbeat.' }];
    const r1 = planAlerts({}, a, T0, L);
    expect(r1.lines).toEqual(['ALERT No heartbeat.']);
    const r2 = planAlerts(r1.next, a, T0 + 60_000, L);
    expect(r2.lines).toEqual([]);
    const r3 = planAlerts(r2.next, a, T0 + 300_000, L);
    expect(r3.lines).toEqual(['STILL No heartbeat. (since 5 min)']);
    let cur = r3.next;
    let sent = 1;
    for (let m = 6; m <= 60; m++) sent += planAlerts(cur, a, T0 + m * 60_000, L).lines.length > 0 ? ((cur = planAlerts(cur, a, T0 + m * 60_000, L).next), 1) : 0;
    expect(sent).toBe(11); // minutes 5, 10, ..., 55; from the hour mark on, one an hour after the last
    expect(planAlerts(cur, a, T0 + 65 * 60_000, L).lines).toEqual([]);
    expect(planAlerts(cur, a, T0 + 114 * 60_000, L).lines).toEqual([]);
    const r4 = planAlerts(cur, a, T0 + 115 * 60_000, L);
    expect(r4.lines).toEqual(['STILL No heartbeat. (since 115 min)']);
    expect(planAlerts(r4.next, a, T0 + 174 * 60_000, L).lines).toEqual([]);
    expect(planAlerts(r4.next, [], T0 + 121 * 60_000, L).lines).toEqual(['CLEARED No heartbeat.']);
  });
});

describe('telegram commands', () => {
  const msg = (chat: number, text: string) => ({ message: { chat: { id: chat }, text } });
  it('accepts only /pause and /status, only from the owner chat', () => {
    expect(parseCommand(msg(42, '/pause'), '42')).toBe('pause');
    expect(parseCommand(msg(42, '/status@Zeroed_alerts_bot'), '42')).toBe('status');
    expect(parseCommand(msg(42, '/resume'), '42')).toBe('other');
    expect(parseCommand(msg(42, '/withdraw all'), '42')).toBe('other');
    expect(parseCommand(msg(7, '/pause'), '42')).toBeNull();
    expect(parseCommand(msg(42, '/pause'), '')).toBeNull();
    expect(parseCommand({}, '42')).toBeNull();
  });

  it('status shows a missing heartbeat plainly', () => {
    expect(statusText(undefined, T0, null, {}, null)).toContain('Heartbeat: none received yet.');
  });
});

describe('lease', () => {
  it('renews for the holder, refuses others until expiry, then raises the epoch', () => {
    const a = takeLease(null, 'primary', 30, T0);
    expect(a).toMatchObject({ granted: true, lease: { holder: 'primary', epoch: 1 } });
    expect(takeLease(a.lease, 'primary', 30, T0 + 10_000).lease?.epoch).toBe(1);
    expect(takeLease(a.lease, 'standby', 30, T0 + 10_000).granted).toBe(false);
    expect(takeLease(a.lease, 'standby', 30, T0 + 31_000)).toMatchObject({ granted: true, lease: { holder: 'standby', epoch: 2 } });
    expect(takeLease(null, 'bad holder!', 30, T0).granted).toBe(false);
  });
});

// The Durable Object with an in-memory storage and a recording fetch for Telegram and RPC.
function harness(env: Partial<Env> = {}, hangRpc = false) {
  const mem = new Map<string, unknown>();
  const state: DurableState = {
    storage: { get: async <T>(k: string) => mem.get(k) as T | undefined, put: async (k, v) => void mem.set(k, structuredClone(v)) },
    blockConcurrencyWhile: (fn) => fn(),
  };
  const sent: { chat_id: string; text: string }[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/sendMessage')) sent.push(JSON.parse(String(init?.body)));
    if (hangRpc && u.includes('rpc.test')) return new Promise<Response>(() => {});
    return new Response(JSON.stringify({ ok: true }));
  });
  vi.stubGlobal('fetch', fetchMock);
  const fullEnv = { HEARTBEAT_HMAC_KEY: KEY, TELEGRAM_BOT_TOKEN: 'TEST-token', TELEGRAM_WEBHOOK_SECRET: 'hook-secret', TELEGRAM_API: 'https://tg.test', ...env } as Env;
  const dob = new Watchdog(state, fullEnv);
  const post = async (path: string, body: string, headers: Record<string, string> = {}) => dob.fetch(new Request(`https://w.test${path}`, { method: 'POST', body, headers }));
  const signed = async (path: string, body: string, t = Math.floor(Date.now() / 1000), signPath = path) => post(path, body, { 'x-zeroed-signature': `t=${t},v1=${await sign(KEY, t, 'POST', signPath, body)}` });
  return { mem, sent, dob, post, signed };
}

describe('Durable Object', () => {
  it('stores a signed heartbeat, refuses unsigned and replayed ones', async () => {
    const h = harness();
    const body = JSON.stringify(hb({ seq: 5 }));
    expect((await h.post('/heartbeat', body)).status).toBe(401);
    const ok = await h.signed('/heartbeat', body);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, paused: false });
    expect((await h.signed('/heartbeat', body)).status).toBe(409);
    vi.unstubAllGlobals();
  });

  it('learns the owner chat only from a signed heartbeat; before that, commands get no answer', async () => {
    const h = harness();
    const upd = JSON.stringify({ message: { chat: { id: 42 }, text: '/pause' } });
    await h.post('/telegram', upd, { 'x-telegram-bot-api-secret-token': 'hook-secret' });
    expect(h.mem.get('paused')).toBeUndefined();
    expect(h.sent).toEqual([]);
    await h.post('/heartbeat', JSON.stringify(hb({ owner_chat_id: '7' })));
    expect(h.mem.get('owner_chat')).toBeUndefined();
    await h.signed('/heartbeat', JSON.stringify(hb({ owner_chat_id: '42' })));
    expect(h.mem.get('owner_chat')).toBe('42');
    vi.unstubAllGlobals();
  });

  it('/pause from the owner sets the flag the worker reads; strangers and a wrong webhook secret change nothing', async () => {
    const h = harness();
    await h.signed('/heartbeat', JSON.stringify(hb({ seq: 0, owner_chat_id: '42' })));
    const upd = (chat: number, text: string) => JSON.stringify({ message: { chat: { id: chat }, text } });
    expect((await h.post('/telegram', upd(42, '/pause'), { 'x-telegram-bot-api-secret-token': 'wrong' })).status).toBe(401);
    await h.post('/telegram', upd(7, '/pause'), { 'x-telegram-bot-api-secret-token': 'hook-secret' });
    expect(h.mem.get('paused')).toBeUndefined();
    expect(h.sent).toEqual([]);
    await h.post('/telegram', upd(42, '/pause'), { 'x-telegram-bot-api-secret-token': 'hook-secret' });
    expect(h.mem.get('paused')).toMatchObject({ at: expect.any(Number) });
    const r = await h.signed('/heartbeat', JSON.stringify(hb({ seq: 3, ts: T0 + 3 })));
    expect(await r.json()).toEqual({ ok: true, paused: true });
    await h.post('/telegram', upd(42, '/status'), { 'x-telegram-bot-api-secret-token': 'hook-secret' });
    expect(h.sent.at(-1)?.text).toContain('Entries: paused');
    expect(h.sent.every((m) => m.chat_id === '42')).toBe(true);
    // Only a signed request from the host clears it, each signature once, and never a heartbeat's.
    expect((await h.post('/resume', '{}')).status).toBe(401);
    const hbBody = JSON.stringify(hb({ seq: 4, ts: T0 + 4 }));
    expect((await h.signed('/resume', hbBody, undefined, '/heartbeat')).status).toBe(401);
    expect(h.mem.get('paused')).toMatchObject({ at: expect.any(Number) });
    const t = Math.floor(Date.now() / 1000);
    expect((await h.signed('/resume', '{}', t)).status).toBe(200);
    expect(h.mem.get('paused')).toBeNull();
    await h.post('/telegram', upd(42, '/pause'), { 'x-telegram-bot-api-secret-token': 'hook-secret' });
    expect((await h.signed('/resume', '{}', t)).status).toBe(401);
    expect(h.mem.get('paused')).toMatchObject({ at: expect.any(Number) });
    vi.unstubAllGlobals();
  });

  it('cron check alerts on a stale heartbeat once, then clears when beats return', async () => {
    const h = harness({ CHAIN_RPC_URL: '' });
    await h.signed('/heartbeat', JSON.stringify(hb({ seq: 1, owner_chat_id: '42' })));
    const stale = h.mem.get('hb') as Stored;
    h.mem.set('hb', { ...stale, receivedAt: Date.now() - 120_000 });
    expect((await h.dob.check(Date.now())).sent).toEqual([expect.stringMatching(/^ALERT No heartbeat for 12\d s/)]);
    expect((await h.dob.check(Date.now())).sent).toEqual([]);
    await h.signed('/heartbeat', JSON.stringify(hb({ seq: 2, ts: T0 + 2 })));
    expect((await h.dob.check(Date.now())).sent).toEqual([expect.stringMatching(/^CLEARED /)]);
    vi.unstubAllGlobals();
  });

  it('a hung RPC never silences the stale-heartbeat alert', async () => {
    const h = harness({ CHAIN_RPC_URL: 'https://rpc.test', CHAIN_TIMEOUT_MS: '50' }, true);
    await h.signed('/heartbeat', JSON.stringify(hb({ seq: 1, owner_chat_id: '42', wallet: 'So11111111111111111111111111111111111111112' })));
    const st = h.mem.get('hb') as Stored;
    h.mem.set('hb', { ...st, receivedAt: Date.now() - 120_000 });
    const r = await h.dob.check(Date.now());
    expect(r.sent).toEqual([expect.stringMatching(/^ALERT No heartbeat/)]);
    expect(h.sent.at(-1)?.text).toMatch(/^ALERT No heartbeat/);
    vi.unstubAllGlobals();
  });

  // ALERT-EXIT review (ops, blocking): Telegram refuses a message over 4,096 characters, and a send that fails must
  // never leave its lines marked sent.
  const incident = (n: number) => Array.from({ length: n }, (_, i) => `Mint${String(i).padStart(2, '0')}${'x'.repeat(150)}: exit blocked, position p${i} (no quote: no-liquidity)`);

  it('a batch over 4,096 characters goes out as several messages on line boundaries, every line once', async () => {
    const h = harness({ CHAIN_RPC_URL: '' });
    const critical = incident(30);
    await h.signed('/heartbeat', JSON.stringify(hb({ seq: 1, owner_chat_id: '42', critical })));
    const r = await h.dob.check(Date.now());
    expect(r.sent).toHaveLength(30);
    expect(h.sent.length).toBeGreaterThan(1);
    expect(h.sent.every((m) => m.text.length <= 4096)).toBe(true);
    expect(h.sent.flatMap((m) => m.text.split('\n'))).toEqual(critical.map((c) => `ALERT Worker critical: ${c}.`));
    expect((await h.dob.check(Date.now())).sent).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('a failed send leaves its lines unsent, and the next check sends them; lines already delivered are not repeated', async () => {
    const h = harness({ CHAIN_RPC_URL: '' });
    const critical = incident(30);
    await h.signed('/heartbeat', JSON.stringify(hb({ seq: 1, owner_chat_id: '42', critical })));
    // Telegram accepts the first message and refuses the next (a 429 or a 400).
    let accepted = 1;
    const texts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      const text = (JSON.parse(String(init?.body)) as { text: string }).text;
      if (accepted-- <= 0) return new Response('{"ok":false}', { status: 429 });
      texts.push(text);
      return new Response('{"ok":true}');
    }));
    const first = await h.dob.check(Date.now());
    expect(first.sent.length).toBeGreaterThan(0);
    expect(first.sent.length).toBeLessThan(30);
    // Telegram is back: the rest goes out, nothing twice.
    accepted = 100;
    const second = await h.dob.check(Date.now());
    expect([...first.sent, ...second.sent]).toEqual(critical.map((c) => `ALERT Worker critical: ${c}.`));
    expect(texts.flatMap((t) => t.split('\n'))).toEqual(critical.map((c) => `ALERT Worker critical: ${c}.`));
    expect((await h.dob.check(Date.now())).sent).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('a cleared line that fails to send is sent on the next check; a refused repeat stays due', () => {
    const a = [{ key: 'k', text: 'Thing.' }];
    const up = planAlerts({}, a, T0, L).next;
    const clear = planAlerts(up, [], T0 + 60_000, L);
    expect(clear.lines).toEqual(['CLEARED Thing.']);
    const kept = unsent(up, clear, 0);
    expect(planAlerts(kept, [], T0 + 120_000, L).lines).toEqual(['CLEARED Thing.']);
    const still = planAlerts(up, a, T0 + 300_000, L);
    expect(still.lines).toEqual(['STILL Thing. (since 5 min)']);
    expect(planAlerts(unsent(up, still, 0), a, T0 + 360_000, L).lines).toEqual(['STILL Thing. (since 6 min)']);
  });

  it('old alert keys are dropped once with no cleared line; their alerts come back under the new keys', async () => {
    const h = harness({ CHAIN_RPC_URL: '' });
    const pos = { mint: 'MintA', qty: 1, entry: 1, stop: 0.5, mark: 0.4, last_exit_attempt_ts: null };
    await h.signed('/heartbeat', JSON.stringify(hb({ seq: 1, owner_chat_id: '42', open_position: pos })));
    const old = { since: Date.now() - 60_000, lastSent: Date.now() - 60_000 };
    h.mem.set('alerts', { stop: { text: 'MintA is below its stop.', ...old }, position: { text: 'p', ...old }, worker_critical: { text: 'w', ...old } });
    const r = await h.dob.check(Date.now());
    expect(r.sent).toEqual(['ALERT MintA is below its stop with no exit attempt in the last 60 s.']);
    expect(Object.keys(h.mem.get('alerts') as object)).toEqual(['stop:MintA']);
    vi.unstubAllGlobals();
  });

  it('the Worker exposes only the five POST routes', async () => {
    const calls: string[] = [];
    const env = { WATCHDOG: { idFromName: () => 'id', get: () => ({ fetch: async (r: Request) => (calls.push(new URL(r.url).pathname), new Response('ok')) }) } } as unknown as Env;
    expect((await worker.fetch(new Request('https://w.test/check', { method: 'POST' }), env)).status).toBe(404);
    expect((await worker.fetch(new Request('https://w.test/heartbeat'), env)).status).toBe(404);
    expect((await worker.fetch(new Request('https://w.test/summary'), env)).status).toBe(404);
    await worker.fetch(new Request('https://w.test/heartbeat', { method: 'POST', body: '{}' }), env);
    await worker.fetch(new Request('https://w.test/summary', { method: 'POST', body: '{}' }), env);
    expect(calls).toEqual(['/heartbeat', '/summary']);
  });
});
