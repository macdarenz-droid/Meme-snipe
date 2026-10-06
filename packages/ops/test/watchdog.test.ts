import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { evaluate, isNewer, limitsFrom, parseCommand, parseHeartbeat, planAlerts, sign, statusText, takeLease, verifySignature, type Heartbeat, type Stored } from '../src/watchdog/logic.ts';
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
    expect(evaluate(stored(hb({ open_position: pos })), T0, L, { slot: null, heldMints: [] }).map((a) => a.key)).toEqual(['position']);
    expect(evaluate(stored(hb()), T0, L, { slot: null, heldMints: ['MintB'] }).map((a) => a.key)).toEqual(['position_unreported']);
    expect(evaluate(stored(hb({ open_position: pos })), T0, L, { slot: null, heldMints: ['MintA'] })).toEqual([]);
  });

  it('flags a breached stop with no exit attempt in 60 s', () => {
    const pos = (last: number | null) => ({ mint: 'MintA', qty: 1, entry: 1, stop: 0.5, mark: 0.4, last_exit_attempt_ts: last });
    expect(evaluate(stored(hb({ open_position: pos(null) })), T0, L, noChain).map((a) => a.key)).toEqual(['stop']);
    expect(evaluate(stored(hb({ open_position: pos(T0 - 30_000) })), T0, L, noChain)).toEqual([]);
    expect(evaluate(stored(hb({ open_position: pos(T0 - 61_000) })), T0, L, noChain).map((a) => a.key)).toEqual(['stop']);
  });

  it('flags old unresolved intents, a low reserve and an unreachable signer', () => {
    const keys = evaluate(stored(hb({ unresolved_intents: { count: 2, oldest_age_s: 91 }, sol_reserve: 0.01, signer: 'unreachable' })), T0, L, noChain).map((a) => a.key);
    expect(keys).toEqual(['intent', 'reserve', 'signer']);
  });
});

describe('alert dedupe and escalation', () => {
  it('flags the worker\'s own critical alerts (WATCH-1), and nothing for an empty or missing list', () => {
    const a = evaluate(stored(hb({ critical: ['MintA: no fresh price (timeout)'] })), T0, L, noChain);
    expect(a).toEqual([{ key: 'worker_critical', text: 'Worker critical: MintA: no fresh price (timeout).' }]);
    expect(evaluate(stored(hb({ critical: [] })), T0, L, noChain)).toEqual([]);
    expect(evaluate(stored(hb()), T0, L, noChain)).toEqual([]);
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

  it('the Worker exposes only the six POST routes; /record runs outside the Durable Object and the nonce path is internal', async () => {
    const calls: string[] = [];
    const env = { WATCHDOG: { idFromName: () => 'id', get: () => ({ fetch: async (r: Request) => (calls.push(new URL(r.url).pathname), new Response('ok')) }) } } as unknown as Env;
    expect((await worker.fetch(new Request('https://w.test/check', { method: 'POST' }), env)).status).toBe(404);
    expect((await worker.fetch(new Request('https://w.test/heartbeat'), env)).status).toBe(404);
    expect((await worker.fetch(new Request('https://w.test/summary'), env)).status).toBe(404);
    expect((await worker.fetch(new Request('https://w.test/record'), env)).status).toBe(404);
    expect((await worker.fetch(new Request('https://w.test/record-nonce', { method: 'POST', body: '{}' }), env)).status).toBe(404);
    await worker.fetch(new Request('https://w.test/heartbeat', { method: 'POST', body: '{}' }), env);
    await worker.fetch(new Request('https://w.test/summary', { method: 'POST', body: '{}' }), env);
    // Unsigned: refused in the outer fetch, before the Durable Object is asked for anything.
    expect((await worker.fetch(new Request('https://w.test/record', { method: 'POST', body: '{}' }), env)).status).toBe(400);
    expect(calls).toEqual(['/heartbeat', '/summary']);
  });

  it('the nonce path takes each nonce once', async () => {
    const h = harness();
    const n = (nonce: string) => h.post('/record-nonce', JSON.stringify({ nonce, t: Math.floor(Date.now() / 1000) }));
    expect((await n('a'.repeat(32))).status).toBe(200);
    expect((await n('a'.repeat(32))).status).toBe(409);
    expect((await n('b'.repeat(32))).status).toBe(200);
    expect((await n('not hex')).status).toBe(400);
    vi.unstubAllGlobals();
  });

  it('the release path keeps only day release ids, the newest 64 days, and forgets on null', async () => {
    const h = harness();
    const keep = (release: string, id: unknown) => h.post('/record-release', JSON.stringify({ release, id }));
    for (const bad of [['latest', 1], ['rec-2026-10-05', 0], ['rec-2026-10-05', 'x'], ['rec-2026-10-05.100', 1]] as const) expect((await keep(bad[0], bad[1])).status, String(bad)).toBe(400);
    for (let d = 1; d <= 70; d++) expect((await keep(`rec-2026-${String(Math.ceil(d / 28)).padStart(2, '0')}-${String(((d - 1) % 28) + 1).padStart(2, '0')}`, d)).status).toBe(200);
    const ids = h.mem.get('record_releases') as Record<string, number>;
    expect(Object.keys(ids)).toHaveLength(64);
    expect(ids['rec-2026-01-01']).toBeUndefined();
    expect(ids['rec-2026-03-14']).toBe(70);
    await keep('rec-2026-03-14', null);
    expect((h.mem.get('record_releases') as Record<string, number>)['rec-2026-03-14']).toBeUndefined();
    const r = await h.post('/record-nonce', JSON.stringify({ nonce: 'c'.repeat(32), t: Math.floor(Date.now() / 1000), release: 'rec-2026-03-13' }));
    expect(await r.json()).toEqual({ ok: true, release_id: 69 });
    vi.unstubAllGlobals();
  });
});
