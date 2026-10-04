// RESTART-ALERT (golden rule: a silent restart is an outage). A new boot on the same release is an unplanned restart:
// the watchdog says so once, with the cause the new boot read from the journal, the previous boot's uptime and memory,
// and the count in the last hour. A deploy (new release) says nothing here, and a crash loop is a count, not a flood.
import { describe, expect, it, vi } from 'vitest';
import { NO_RESTARTS, limitsFrom, noteRestart, restartLines, sign, type Heartbeat, type RestartState, type Stored } from '../src/watchdog/logic.ts';
import { Watchdog, type DurableState, type Env } from '../src/watchdog/worker.ts';

const KEY = 'test-hmac-key-0123456789abcdef';
const L = limitsFrom({}); // repeatCriticalS 300
const T0 = 1_800_000_000_000;
const SHA = 'a'.repeat(40);
const hb = (over: Partial<Heartbeat> = {}): Heartbeat => ({
  seq: 1, ts: T0, boot: 'b1', git_sha: SHA, policy_version: 'p', last_processed_slot: null, feed_ages_ms: {}, open_position: null,
  unresolved_intents: { count: 0, oldest_age_s: null }, signer: 'not-ready', lease_epoch: null, sol_reserve: null, paused: false, ...over,
});
const stored = (h: Heartbeat): Stored => ({ hb: h, receivedAt: T0 });

describe('unplanned restarts (logic)', () => {
  it('a new boot on the same release alerts once, with its cause and the previous boot\'s uptime and memory', () => {
    const prev = stored(hb({ uptime_s: 2 * 3600 + 540, rss_bytes: 790 * 1048576 }));
    let st = noteRestart(prev, hb({ boot: 'b2', seq: 1, ts: T0 + 10_000, last_exit: 'no clean stop' }), T0 + 10_000, NO_RESTARTS);
    expect(st.events).toHaveLength(1);
    const first = restartLines(st, T0 + 60_000, L);
    expect(first.lines).toEqual(['ALERT Worker restarted without a deploy (release aaaaaaaaaaaa): no clean stop; the previous boot ran 2 h 9 min at 790 MB. 1 restart in the last hour.']);
    st = first.next;
    expect(restartLines(st, T0 + 120_000, L).lines).toEqual([]);
    expect(restartLines(st, T0 + 3_000_000, L).lines).toEqual([]);
  });

  it('a deploy (new release), a planned drill restart, the same boot and a first heartbeat record nothing', () => {
    const prev = stored(hb());
    expect(noteRestart(prev, hb({ boot: 'b2', last_exit: 'planned: drill restart-1 (crash)' }), T0, NO_RESTARTS)).toBe(NO_RESTARTS);
    expect(noteRestart(prev, hb({ boot: 'b2', git_sha: 'b'.repeat(40) }), T0, NO_RESTARTS)).toBe(NO_RESTARTS);
    expect(noteRestart(prev, hb({ seq: 2, ts: T0 + 1 }), T0, NO_RESTARTS)).toBe(NO_RESTARTS);
    expect(noteRestart(undefined, hb({ boot: 'b2' }), T0, NO_RESTARTS)).toBe(NO_RESTARTS);
  });

  it('a crash loop is one line, then one line with the count once the window has passed, not a line per restart', () => {
    let st: RestartState = NO_RESTARTS;
    let prev = stored(hb({ uptime_s: 20 }));
    const sent: string[] = [];
    for (let k = 1; k <= 12; k++) {
      const now = T0 + k * 30_000; // a restart every 30 s (systemd's RestartSec 5 s plus a crash)
      const h = hb({ boot: `b${k + 1}`, ts: now, last_exit: 'stop: crash', uptime_s: 20 });
      st = noteRestart(prev, h, now, st);
      prev = stored(h);
      const r = restartLines(st, now + 1_000, L); // the minute cron
      sent.push(...r.lines);
      st = r.next;
    }
    // At 30 s: the first line. At 6 min 30 s (one window later): one more, with the count so far. Not twelve lines.
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatch(/stop: crash; the previous boot ran 0 min\. 1 restart in the last hour\.$/);
    expect(sent[1]).toMatch(/11 restarts in the last hour\.$/);
    // The rest are reported, with the total, by the next line after the window.
    expect(restartLines(st, T0 + 13 * 30_000 + 300_000, L).lines).toEqual([expect.stringMatching(/12 restarts in the last hour\.$/)]);
  });

  it('restarts older than an hour drop out of the count', () => {
    let st = noteRestart(stored(hb()), hb({ boot: 'b2', last_exit: 'stop: crash' }), T0, NO_RESTARTS);
    st = restartLines(st, T0, L).next;
    st = noteRestart(stored(hb({ boot: 'b2' })), hb({ boot: 'b3', last_exit: 'no clean stop' }), T0 + 3_700_000, st);
    expect(restartLines(st, T0 + 3_700_000, L).lines).toEqual([expect.stringMatching(/no clean stop\. 1 restart in the last hour\.$/)]);
  });
});

describe('the watchdog Durable Object', () => {
  const harness = () => {
    const mem = new Map<string, unknown>();
    const state: DurableState = { storage: { get: async <T>(k: string) => mem.get(k) as T | undefined, put: async (k, v) => void mem.set(k, structuredClone(v)) }, blockConcurrencyWhile: (fn) => fn() };
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/sendMessage')) sent.push((JSON.parse(String(init?.body)) as { text: string }).text);
      return new Response(JSON.stringify({ ok: true }));
    }));
    const dob = new Watchdog(state, { HEARTBEAT_HMAC_KEY: KEY, TELEGRAM_BOT_TOKEN: 'TEST-token', TELEGRAM_WEBHOOK_SECRET: 's', TELEGRAM_API: 'https://tg.test', CHAIN_RPC_URL: '' } as Env);
    const beat = async (h: Heartbeat) => {
      const body = JSON.stringify(h);
      const t = Math.floor(Date.now() / 1000);
      return dob.fetch(new Request('https://w.test/heartbeat', { method: 'POST', body, headers: { 'x-zeroed-signature': `t=${t},v1=${await sign(KEY, t, 'POST', '/heartbeat', body)}` } }));
    };
    return { dob, beat, sent };
  };

  it('an unplanned restart reaches the owner on the next check; a deploy does not', async () => {
    const h = harness();
    const now = Date.now();
    await h.beat(hb({ ts: now, owner_chat_id: '42', uptime_s: 600, rss_bytes: 500 * 1048576 }));
    await h.beat(hb({ boot: 'b2', ts: now + 1, owner_chat_id: '42', last_exit: 'no clean stop' }));
    expect((await h.dob.check(Date.now())).sent).toEqual([expect.stringMatching(/^ALERT Worker restarted without a deploy .*: no clean stop; the previous boot ran 10 min at 500 MB\. 1 restart in the last hour\.$/)]);
    expect((await h.dob.check(Date.now())).sent).toEqual([]);
    await h.beat(hb({ boot: 'b3', ts: now + 2, owner_chat_id: '42', git_sha: 'c'.repeat(40), last_exit: 'stop: signal' }));
    expect((await h.dob.check(Date.now())).sent).toEqual([]);
    expect(h.sent).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});
