// A-M03-01 (card Z08): the PumpPortal client, built but never run against PumpPortal (ruling Z08-2). Every socket is a
// local fake; the notices are a SYNTHETIC fixture in the shape assumed in pumpportal.ts (the vendor documents none).
// Acceptance bullets of SPEC-A A-M03-01 and the Zeroed bug of MIGRATION's A-M03-01 row (back-off 5 s → 300 s with no
// jitter; fail-before run recorded in the Z08 PR) each have a named case.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { decodePubkey } from '@bot/decoders';
import type { Slot, UnixMs } from '@bot/types';
import { MINTS, REFERENCE } from '@bot/venue/constants';
import { createPumpPortalClient, type Connect, type PumpPortalDeps, type SocketHandlers } from '../../src/m03/pumpportal-client.ts';
import {
  backoffMs, checkPumpPortalConfig, NoticeDedupe, parseNotice, PUMPPORTAL_DEFAULTS, type PumpPortalNotice,
} from '../../src/m03/pumpportal.ts';
import { createRng } from '../../src/m10/rng.ts';
import { FakeTime, RecordingLog, RecordingMetrics } from '../m14/helpers.ts';

const isPubkey = (s: string): boolean => { try { decodePubkey(s); return true; } catch { return false; } };
const MINT = MINTS.wsol;                                               // any valid keys: the fixture is synthetic
const POOL = REFERENCE.solUsdcWhirlpool;
const SIG = '5'.repeat(87);
/** SYNTHETIC notices (shape UNVERIFIED: the vendor page shows none). */
const migration = (mint = MINT, slot = 1_000): string => JSON.stringify({ txType: 'migrate', mint, pool: POOL, signature: SIG, slot });
const created = (mint = MINT): string => JSON.stringify({ txType: 'create', mint, signature: SIG });

class FakeServer {
  open: Array<{ url: string; h: SocketHandlers; sent: string[]; closed: boolean }> = [];
  maxOpen = 0;
  readonly connect: Connect = (url, h) => {
    const c = { url, h, sent: [] as string[], closed: false };
    this.open.push(c);
    this.maxOpen = Math.max(this.maxOpen, this.live().length);
    return { send: (t) => { c.sent.push(t); }, close: () => { c.closed = true; } };
  };
  live() { return this.open.filter((c) => !c.closed); }
  last() { return this.open.at(-1) as FakeServer['open'][number]; }
  /** The server closes the newest socket. */
  drop(code = 1006) { const c = this.last(); c.closed = true; c.h.onClose(code); }
}

function client(over: Partial<PumpPortalDeps> = {}) {
  const time = new FakeTime();
  const server = new FakeServer();
  const log = new RecordingLog();
  const metrics = new RecordingMetrics();
  const backfills: Array<Slot | null> = [];
  const published: PumpPortalNotice[] = [];
  const recorded: PumpPortalNotice[] = [];
  const c = createPumpPortalClient({
    config: { ...PUMPPORTAL_DEFAULTS, enabled: true }, connect: server.connect, apiKey: null, scheduler: time, nowMs: () => time.nowMs(),
    rng: createRng(7), backfill: { backfillSince: async (s) => { backfills.push(s); return {}; }, migrationsSeenSince: () => 0 },
    publish: (n) => published.push(n), record: (n) => recorded.push(n), isPubkey, log, metrics, ...over,
  });
  return { c, time, server, log, metrics, backfills, published, recorded };
}

describe('A-M03-01 PumpPortal client (fake socket, synthetic fixture)', () => {
  it('ruling Z08-2: disabled by default; start() opens nothing', () => {
    assert.equal(PUMPPORTAL_DEFAULTS.enabled, false);
    const t = client({ config: PUMPPORTAL_DEFAULTS });
    t.c.start();
    assert.equal(t.server.open.length, 0);
    assert.ok(t.log.events.some((e) => e.code === 'm03.pp_disabled'));
    assert.equal(t.c.health().status, 'down');
  });

  it('acceptance and Zeroed bug (5 s → 300 s, no jitter): 10 closes → never more than one socket, waits grow with full jitter to the 60 s cap, every reconnect calls backfill exactly once', async () => {
    const t = client();
    t.c.start();
    const waits: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const s = t.server.last();
      s.h.onOpen();
      s.h.onMessage(migration(MINT, 1_000 + i));                         // a live connection, so not a refused one
      t.server.drop();
      const before = t.server.open.length;
      const t0 = t.time.now;
      while (t.server.open.length === before) await t.time.advance(10);
      waits.push(t.time.now - t0);
    }
    assert.equal(t.server.maxOpen, 1);
    // Upper bounds 1, 2, 4, ..., capped at 60 s; full jitter draws below each (seeded, reproducible).
    const caps = waits.map((_, i) => Math.min(60_000, 1_000 * 2 ** i));
    waits.forEach((w, i) => assert.ok(w <= (caps[i] as number) + 10, `wait ${i} ${w} > ${caps[i]}`));
    assert.ok(waits.slice(6).every((w) => w <= 60_010));
    assert.ok(new Set(waits).size > 3);                                  // jittered, not a fixed ladder
    t.server.last().h.onOpen();
    assert.equal(t.backfills.length, 10);                                // one per reconnect
    assert.deepEqual(t.backfills.slice(0, 2), [1_000n, 1_001n]);         // from the last seen slot
    assert.equal(t.metrics.count('stream_reconnects_total', { source: 'pumpportal' }), 10);
    // The same seed gives the same waits.
    const rngA = createRng(1);
    const rngB = createRng(1);
    for (let i = 0; i < 8; i += 1) assert.equal(backoffMs(rngA, i, 60_000), backoffMs(rngB, i, 60_000));
  });

  it('subscribes to the two free streams only, the second after the rate-limit gap; the key goes in the URL and is never logged', async () => {
    const t = client({ apiKey: 'PP-SECRET-KEY' });
    t.c.start();
    const s = t.server.last();
    const u = new URL(s.url);
    assert.deepEqual([u.origin + u.pathname, u.searchParams.get('api-key')], ['wss://pumpportal.fun/api/data', 'PP-SECRET-KEY']);
    s.h.onOpen();
    assert.deepEqual(s.sent, ['{"method":"subscribeNewToken"}']);
    await t.time.advance(100);                                            // 10 a second
    assert.deepEqual(s.sent, ['{"method":"subscribeNewToken"}', '{"method":"subscribeMigration"}']);
    assert.ok(!JSON.stringify(t.log.events).includes('PP-SECRET-KEY'));
    t.c.start();                                                          // already running: no second socket
    assert.equal(t.server.open.length, 1);
  });

  it('acceptance: the same migration notice twice → one discovery.pumpportal_notice; new tokens are recorded unverified', () => {
    const t = client();
    t.c.start();
    const s = t.server.last();
    s.h.onOpen();
    s.h.onMessage(migration());
    s.h.onMessage(migration());
    s.h.onMessage(created());
    assert.equal(t.published.length, 2);
    assert.deepEqual(t.published.map((n) => n.kind), ['migration', 'new_token']);
    assert.equal(t.recorded.length, 2);
    assert.equal(t.metrics.count('pumpportal_notices_total', { kind: 'migration' }), 1);
  });

  it('malformed, oversize and invalid notices are dropped and counted; the connection stays', () => {
    const t = client();
    t.c.start();
    const s = t.server.last();
    s.h.onOpen();
    for (const m of ['{', '[]', 'x'.repeat(70_000), JSON.stringify({ txType: 'create', mint: 'not-a-key' }), JSON.stringify({ txType: 'trade', mint: MINT }), JSON.stringify({ message: 'Successfully subscribed' })]) s.h.onMessage(m);
    assert.equal(t.metrics.count('pumpportal_dropped_total', { reason: 'malformed' }), 2);
    assert.equal(t.metrics.count('pumpportal_dropped_total', { reason: 'oversize' }), 1);
    assert.equal(t.metrics.count('pumpportal_dropped_total', { reason: 'invalid_notice' }), 2);
    assert.equal(t.published.length, 0);
    assert.equal(t.server.live().length, 1);
  });

  it('failure injection: 3 refused connections within 60 s → suspected ban, no connection for 1 h, warning', async () => {
    const t = client();
    t.c.start();
    for (let i = 0; i < 3; i += 1) {
      t.server.drop();                                                    // closed before any message
      if (i < 2) { const n = t.server.open.length; while (t.server.open.length === n) await t.time.advance(10); }
    }
    assert.ok(t.log.events.some((e) => e.code === 'm03.pp_ban_suspected'));
    const n = t.server.open.length;
    await t.time.advance(3_599_000);
    assert.equal(t.server.open.length, n);
    assert.equal(t.c.health().status, 'down');
    await t.time.advance(1_000);
    assert.equal(t.server.open.length, n + 1);
  });

  it('health: lag from the slot clock, reconnects in the last hour, down when silent while backfill sees migrations; stop closes the socket', async () => {
    let seen = 0;
    const t = client({
      slots: { highestSeenSlot: () => 1_010n as Slot, slotMs: () => 400 },
      backfill: { backfillSince: async () => ({}), migrationsSeenSince: () => seen },
    });
    t.c.start();
    const s = t.server.last();
    s.h.onOpen();
    s.h.onMessage(migration(MINT, 1_000));
    let h = t.c.health();
    assert.deepEqual([h.status, h.lagMs, h.reconnects1h, h.lastEventAtMs], ['ok', 4_000, 0, t.time.now]);
    await t.time.advance(300_000);
    assert.equal(t.c.health().status, 'ok');                              // silent, but backfill sees nothing either
    seen = 1;
    assert.equal(t.c.health().status, 'down');
    t.server.drop();
    h = t.c.health();
    assert.equal(h.status, 'down');
    t.c.stop();
    assert.equal(t.c.sockets(), 0);
    await t.time.advance(120_000);
    assert.equal(t.server.live().length, 0);                              // stopped: no reconnect
    // A connect that throws is retried with the back-off.
    let fail = true;
    const u = client({ connect: (url, hh) => { if (fail) { fail = false; throw new Error('ECONNREFUSED'); } return t.server.connect(url, hh); } });
    u.c.start();
    await u.time.advance(1_100);
    assert.equal(u.c.sockets(), 1);
    u.c.stop();
  });

  it('acceptance: a paid method in config fails validation; ranges are checked', () => {
    assert.match(checkPumpPortalConfig({ ...PUMPPORTAL_DEFAULTS, paidMethods: ['subscribeTokenTrade'] }) as string, /paid/);
    assert.throws(() => client({ config: { ...PUMPPORTAL_DEFAULTS, paidMethods: ['subscribeAccountTrade'] } }), RangeError);
    for (const bad of [{ maxSubMsgsPerS: 201 }, { maxSubMsgsPerS: 0 }, { backoffMaxMs: 4_999 }, { silenceAlertMs: 59_999 }]) {
      assert.notEqual(checkPumpPortalConfig({ ...PUMPPORTAL_DEFAULTS, ...bad }), null);
    }
    assert.equal(checkPumpPortalConfig(PUMPPORTAL_DEFAULTS), null);
  });

  it('dedupe TTL is 24 h and the set is bounded; parse keeps the raw text capped', () => {
    const d = new NoticeDedupe(1_000, 2);
    const n = { kind: 'migration' as const, signature: 'a', mint: MINT };
    assert.equal(d.first(n, 0), true);
    assert.equal(d.first(n, 999), false);
    assert.equal(d.first(n, 1_000), true);                                // expired
    d.first({ ...n, signature: 'b' }, 1_001);
    d.first({ ...n, signature: 'c' }, 1_002);
    assert.equal(d.size(), 2);
    assert.equal(d.first({ kind: 'new_token', signature: null, mint: MINT }, 1_003), true);   // no signature: keyed by mint
    const p = parseNotice(JSON.stringify({ txType: 'migrate', mint: MINT, pad: 'x'.repeat(10_000), slot: -1, pool: 'bad', signature: 'short' }), 5 as UnixMs, isPubkey);
    assert.ok(!('drop' in p) && p.slot === null && p.pool === null && p.signature === null && Buffer.from(p.rawB64, 'base64').length === 4_096);
  });
});
