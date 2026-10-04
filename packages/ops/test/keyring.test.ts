// KEY-ROTATE-SAFE: the watchdog's key slots. A key the server never received changes nothing; the server's first use of
// a new key switches to it and retires the old one.
import { describe, expect, it, vi } from 'vitest';
import { sign, type Heartbeat } from '../src/watchdog/logic.ts';
import { NEW_RING, candidates, nextSlot, promote, sha256 } from '../src/watchdog/keyring.ts';
import worker, { Watchdog, type DurableState, type Env } from '../src/watchdog/worker.ts';

const K0 = 'key-zero-0123456789abcdef0123456789';
const K1 = 'key-one-0123456789abcdef0123456789a';
const K2 = 'key-two-0123456789abcdef0123456789b';

describe('key slots', () => {
  it('accept the active value first, then an offer in the other slot; never an empty or retired one', async () => {
    const env = { HB: K0, HB_A: K1, HB_B: '' };
    expect((await candidates(NEW_RING, env, 'HB')).map((c) => [c.slot, c.active])).toEqual([['legacy', true], ['A', false]]);
    const r1 = await promote(NEW_RING, env, 'HB', 'A');
    expect(r1).toEqual({ active: 'A', retired: [await sha256(K0)] });
    // The legacy slot is never an offer, and once A is active it is no longer accepted.
    expect((await candidates(r1, env, 'HB')).map((c) => c.slot)).toEqual(['A']);
    // An old value written back into B is retired: refused.
    expect((await candidates(r1, { ...env, HB_B: K0 }, 'HB')).map((c) => c.slot)).toEqual(['A']);
    expect((await candidates(r1, { ...env, HB_B: K2 }, 'HB')).map((c) => [c.slot, c.active])).toEqual([['A', true], ['B', false]]);
    expect(nextSlot('legacy')).toBe('A');
    expect(nextSlot('A')).toBe('B');
    expect(nextSlot('B')).toBe('A');
    expect(await promote(r1, env, 'HB', 'A')).toBe(r1);
  });

  it('never take the legacy slot as an offer, nor an active value that was retired', async () => {
    // A watchdog that started with no legacy value, then had one set later: legacy is not an offer while A is active.
    expect((await candidates({ active: 'A', retired: [] }, { HB: K0, HB_A: K1 }, 'HB')).map((c) => c.slot)).toEqual(['A']);
    expect(await candidates({ active: 'A', retired: [await sha256(K1)] }, { HB_A: K1 }, 'HB')).toEqual([]);
  });
});

function harness(env: Partial<Env>) {
  const mem = new Map<string, unknown>();
  const state: DurableState = {
    storage: { get: async <T>(k: string) => mem.get(k) as T | undefined, put: async (k, v) => void mem.set(k, structuredClone(v)) },
    blockConcurrencyWhile: (fn) => fn(),
  };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })));
  let e = { TELEGRAM_BOT_TOKEN: 'TEST-token', TELEGRAM_API: 'https://tg.test', CHAIN_RPC_URL: '', ...env } as Env;
  let dob = new Watchdog(state, e);
  let seq = 0;
  let lastBody = '';
  const raw = async (path: string, body: string, key: string) => {
    const t = Math.floor(Date.now() / 1000);
    return (await dob.fetch(new Request(`https://w.test${path}`, { method: 'POST', body, headers: { 'x-zeroed-signature': `t=${t},v1=${await sign(key, t, 'POST', path, body)}` } }))).status;
  };
  const beat = async (key: string) => {
    seq += 1;
    const body = (lastBody = JSON.stringify({
      seq, ts: 1_800_000_000_000 + seq, boot: 'b', git_sha: 'a'.repeat(40), policy_version: 'p', last_processed_slot: null, feed_ages_ms: {}, open_position: null,
      unresolved_intents: { count: 0, oldest_age_s: null }, signer: 'none', lease_epoch: null, sol_reserve: null, paused: false, owner_chat_id: '42',
    } satisfies Heartbeat));
    return raw('/heartbeat', body, key);
  };
  let rt = Math.floor(Date.now() / 1000);
  const resume = async (key: string) => {
    rt += 1;
    return (await dob.fetch(new Request('https://w.test/resume', { method: 'POST', body: '{}', headers: { 'x-zeroed-signature': `t=${rt},v1=${await sign(key, rt, 'POST', '/resume', '{}')}` } }))).status;
  };
  const hook = async (secret: string) =>
    (await dob.fetch(new Request('https://w.test/telegram', { method: 'POST', body: '{}', headers: { 'x-telegram-bot-api-secret-token': secret } }))).status;
  const slot = async () => (await (await dob.fetch(new Request('https://w.test/slot'))).json()) as { heartbeat: string; webhook: string; pending: boolean };
  /** A Deploy run: new secrets on the same Durable Object (wrangler secret put makes a new version). */
  const redeploy = (over: Partial<Env>) => {
    e = { ...e, ...over };
    dob = new Watchdog(state, e);
  };
  return { mem, beat, raw, last: () => lastBody, resume, hook, slot, redeploy, check: (now: number) => dob.check(now) };
}

describe('rotation on the watchdog', () => {
  it('a new key the server never received changes nothing: its old key keeps beating (the stale or wrong DEPLOY_CODE case)', async () => {
    // Today's single-slot order would have replaced HEARTBEAT_HMAC_KEY here and refused K0 from then on.
    const h = harness({ HEARTBEAT_HMAC_KEY: K0, TELEGRAM_WEBHOOK_SECRET: 'w0' });
    expect(await h.beat(K0)).toBe(200);
    expect(await h.slot()).toEqual({ heartbeat: 'legacy', webhook: 'legacy', pending: false });
    h.redeploy({ HEARTBEAT_HMAC_KEY_A: K1, TELEGRAM_WEBHOOK_SECRET_A: 'w1' });
    expect(await h.beat(K0)).toBe(200);
    expect(await h.hook('w0')).toBe(200);
    // The offer is reported as pending: Deploy then refuses to rotate again (publish.sh, FORCE_KEY_ROTATE overrides).
    expect(await h.slot()).toEqual({ heartbeat: 'legacy', webhook: 'legacy', pending: true });
    // Forced over (FORCE_KEY_ROTATE=yes): the same pending slot is written; the old key still beats.
    h.redeploy({ HEARTBEAT_HMAC_KEY_A: K2 });
    expect(await h.beat(K0)).toBe(200);
    vi.unstubAllGlobals();
  });

  it('the server\'s first beat with the new key switches to it and the old key is refused from then on', async () => {
    const h = harness({ HEARTBEAT_HMAC_KEY: K0, TELEGRAM_WEBHOOK_SECRET: 'w0' });
    h.redeploy({ HEARTBEAT_HMAC_KEY_A: K1, TELEGRAM_WEBHOOK_SECRET_A: 'w1' });
    // Signed with the offer, a /resume works but does not switch: only a heartbeat does.
    expect(await h.resume(K1)).toBe(200);
    expect((await h.slot()).heartbeat).toBe('legacy');
    expect(await h.beat(K1)).toBe(200);
    expect((await h.slot()).heartbeat).toBe('A');
    expect(await h.beat(K0)).toBe(401);
    expect(await h.resume(K0)).toBe(401);
    // The webhook secret came in the same bundle: it switched with the key, without waiting for a Telegram update.
    expect(await h.slot()).toEqual({ heartbeat: 'A', webhook: 'A', pending: false });
    expect(await h.hook('w0')).toBe(401);
    expect(await h.hook('w1')).toBe(200);
    // The next rotation writes B; A keeps working until the server uses B.
    h.redeploy({ HEARTBEAT_HMAC_KEY_B: K2 });
    expect(await h.beat(K1)).toBe(200);
    expect(await h.beat(K2)).toBe(200);
    expect((await h.slot()).heartbeat).toBe('B');
    expect(await h.beat(K1)).toBe(401);
    // A value retired earlier, written back into A, stays refused.
    h.redeploy({ HEARTBEAT_HMAC_KEY_A: K0 });
    expect(await h.beat(K0)).toBe(401);
    // The ring holds hashes only, never a key.
    expect(JSON.stringify([...h.mem.entries()])).not.toMatch(new RegExp([K0, K1, K2].join('|')));
    vi.unstubAllGlobals();
  });

  it('an offer unused for 24 h alerts as "key offer pending", and clears when it is used or replaced', async () => {
    const H = 3_600_000;
    const h = harness({ HEARTBEAT_HMAC_KEY: K0 });
    expect(await h.beat(K0)).toBe(200);
    const t0 = Date.now();
    expect((await h.check(t0)).alerts).toEqual([]);
    h.redeploy({ HEARTBEAT_HMAC_KEY_A: K1 });
    // A heartbeat key alone on offer is pending too.
    expect(await h.slot()).toEqual({ heartbeat: 'legacy', webhook: 'legacy', pending: true });
    // The heartbeat itself stays fresh in these checks: only the offer can alert.
    const at = async (ms: number) => {
      const st = h.mem.get('hb') as { hb: unknown; receivedAt: number };
      h.mem.set('hb', { ...st, receivedAt: ms });
      return h.check(ms);
    };
    expect((await at(t0)).alerts).toEqual([]);
    expect((await at(t0 + 23 * H)).alerts).toEqual([]);
    const late = await at(t0 + 25 * H);
    expect(late.alerts).toEqual(['key_offer_HEARTBEAT_HMAC_KEY']);
    expect(late.sent).toEqual([expect.stringMatching(/^ALERT Key offer pending: the new heartbeat key \(slot A\) has not been used for 25 h/)]);
    // Replaced by a new Deploy: a new offer, its own 24 h.
    h.redeploy({ HEARTBEAT_HMAC_KEY_A: K2 });
    expect((await at(t0 + 26 * H)).sent).toEqual([expect.stringMatching(/^CLEARED Key offer pending/)]);
    expect((await at(t0 + 49 * H)).alerts).toEqual([]);
    expect((await at(t0 + 51 * H)).alerts).toEqual(['key_offer_HEARTBEAT_HMAC_KEY']);
    // Used: the server beats with it, the offer is gone and the alert clears.
    expect(await h.beat(K2)).toBe(200);
    expect((await at(t0 + 52 * H)).sent).toEqual([expect.stringMatching(/^CLEARED Key offer pending/)]);
    vi.unstubAllGlobals();
  });

  it('a second Deploy before the server\'s first use is refused, and the first offer still works', async () => {
    // A fresh server waiting for /pair holds K1 from run 1 but has not beaten with it yet.
    const h = harness({ HEARTBEAT_HMAC_KEY: K0, TELEGRAM_WEBHOOK_SECRET: 'w0' });
    h.redeploy({ HEARTBEAT_HMAC_KEY_A: K1, TELEGRAM_WEBHOOK_SECRET_A: 'w1' });
    // Run 2 reads /slot, sees pending and writes nothing (publish.sh; tested in ops-files.test.ts), so the env stays.
    expect((await h.slot()).pending).toBe(true);
    expect(await h.beat(K1)).toBe(200);
    expect(await h.slot()).toEqual({ heartbeat: 'A', webhook: 'A', pending: false });
    vi.unstubAllGlobals();
  });

  it('Telegram\'s first request with the offered webhook secret also switches it (no heartbeat needed)', async () => {
    const h = harness({ HEARTBEAT_HMAC_KEY: K0, TELEGRAM_WEBHOOK_SECRET: 'w0' });
    h.redeploy({ TELEGRAM_WEBHOOK_SECRET_A: 'w1' });
    expect(await h.hook('w1')).toBe(200);
    expect(await h.slot()).toEqual({ heartbeat: 'legacy', webhook: 'A', pending: false });
    expect(await h.hook('w0')).toBe(401);
    vi.unstubAllGlobals();
  });

  it('a bad or replayed heartbeat signed with the offer does not switch', async () => {
    const h = harness({ HEARTBEAT_HMAC_KEY: K0, HEARTBEAT_HMAC_KEY_A: K1 });
    expect(await h.raw('/heartbeat', '{"not":"a heartbeat"}', K1)).toBe(400);
    expect(await h.beat(K0)).toBe(200);
    // Replayed: the last heartbeat's body again, now signed with the offer.
    expect(await h.raw('/heartbeat', h.last(), K1)).toBe(409);
    expect((await h.slot()).heartbeat).toBe('legacy');
    vi.unstubAllGlobals();
  });

  it('the Worker serves GET /slot and no other GET', async () => {
    const calls: string[] = [];
    const env = { WATCHDOG: { idFromName: () => 'id', get: () => ({ fetch: async (r: Request) => (calls.push(`${r.method} ${new URL(r.url).pathname}`), new Response('ok')) }) } } as unknown as Env;
    await worker.fetch(new Request('https://w.test/slot'), env);
    expect((await worker.fetch(new Request('https://w.test/heartbeat'), env)).status).toBe(404);
    expect((await worker.fetch(new Request('https://w.test/slot', { method: 'POST' }), env)).status).toBe(404);
    expect(calls).toEqual(['GET /slot']);
  });
});
