// A-M03-04 (card Z08): the DexScreener coverage cross-check, through the real M14 service client (30 a minute, ruling Z08-30) and a
// mock fetch; no network. The vendor answers are SYNTHETIC, in the documented field names [VF-15].
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { base58, decodePubkey } from '@bot/decoders';
import type { Pubkey } from '@bot/types';
import { createCrossCheck, MAX_MINTS_PER_CALL, type DexScreenerDeps } from '../../src/m03/dexscreener.ts';
import { M03_LOG_CODES } from '../../src/m03/log.ts';
import { createServiceClients, type HttpFetch } from '../../src/m14/services.ts';
import { FakeTime, RecordingLog, RecordingMetrics } from '../m14/helpers.ts';

const isPubkey = (s: string): boolean => { try { decodePubkey(s); return true; } catch { return false; } };
const key = (n: number): Pubkey => base58.encode(new Uint8Array(32).fill(n)) as Pubkey;
const pair = (mint: Pubkey, pairAddress: Pubkey, dexId = 'pumpswap', chainId = 'solana') =>
  ({ chainId, dexId, pairAddress, baseToken: { address: mint, symbol: 'X' }, quoteToken: { address: key(99) }, priceNative: '1' });

function setup(answer: (url: string) => Response, over: Partial<DexScreenerDeps> = {}) {
  const time = new FakeTime();
  const urls: string[] = [];
  const fetch: HttpFetch = async (url) => { urls.push(url); return answer(url); };
  const svc = createServiceClients({
    services: [{ name: 'dexscreener', baseUrl: 'https://api.dexscreener.com' }], secrets: { get: () => undefined }, fetch, scheduler: time,
    nowMs: () => time.nowMs(), monthly: { take: () => true }, log: new RecordingLog(), metrics: new RecordingMetrics(),
  });
  const log = new RecordingLog();
  const cc = createCrossCheck({
    http: (req) => svc.http('dexscreener', req, { priority: 3, timeoutMs: 60_000 }), nowMs: () => time.nowMs(), isPubkey,
    pumpswapDexIds: ['pumpswap'], maxCallsPerDay: 500, enabled: true, log, ...over,
  });
  return { cc, urls, time, log };
}
const json = (v: unknown): Response => new Response(JSON.stringify(v), { status: 200 });

describe('A-M03-04 DexScreener cross-check (synthetic vendor answers)', () => {
  it('acceptance: a vendor PumpSwap pair not among the pools of our recorded migrations is listed under poolsOnlyInVendor', async () => {
    const [m1, m2] = [key(1), key(2)];
    const t = setup(() => json([pair(m1, key(11)), pair(m2, key(12)), pair(m2, key(12)), pair(m1, key(13), 'raydium'), pair(key(3), key(14))]));
    const r = await t.cc.crossCheck([m1, m2, m1], new Set([key(11)]));
    assert.deepEqual(r.poolsOnlyInVendor, [{ mint: m2, pairAddress: key(12), dexId: 'pumpswap' }]);
    assert.deepEqual([r.checkedMints, r.otherDexPairs, r.status], [2, 1, 'ok']);   // the unasked mint's pair is ignored
    assert.equal(t.urls[0], `https://api.dexscreener.com/tokens/v1/solana/${m1},${m2}`);
    assert.ok(t.log.events.some((e) => e.code === 'm03.coverage_cross_check' && e.fields.status === 'ok' && e.fields.other_dex_pairs === 1));
  });

  it('Z08-30: a pool we know listed under a non-PumpSwap dexId gives dex_id_mismatch and is logged with otherDexPairs', async () => {
    const [m1, m2] = [key(1), key(2)];
    const t = setup(() => json([pair(m1, key(11), 'pumpfun-amm'), pair(m2, key(12), 'pumpfun-amm')]));
    const r = await t.cc.crossCheck([m1, m2], new Set([key(11)]));
    assert.deepEqual([r.status, r.otherDexPairs, r.poolsOnlyInVendor.length], ['dex_id_mismatch', 2, 0]);
    const e = t.log.events.find((x) => x.code === 'm03.coverage_cross_check');
    assert.deepEqual([e?.level, e?.fields.other_dex_pairs, e?.fields.known_pools_under_other_dex, e?.fields.status], ['warn', 2, 1, 'dex_id_mismatch']);
    // An unknown pool under another dexId is only counted.
    const u = setup(() => json([pair(m2, key(12), 'raydium')]));
    assert.equal((await u.cc.crossCheck([m2], new Set([key(11)]))).status, 'ok');
    // A partial answer stays partial (the mismatch is still in the log).
    let n = 0;
    const p = setup(() => { n += 1; return n === 1 ? json([pair(m1, key(11), 'pumpfun-amm')]) : new Response('', { status: 429 }); });
    const pr = await p.cc.crossCheck(Array.from({ length: 31 }, (_, i) => key(i + 1)), new Set([key(11)]));
    assert.equal(pr.status, 'partial');
    assert.equal(p.log.events.find((x) => x.code === 'm03.coverage_cross_check')?.fields.known_pools_under_other_dex, 1);
  });

  it('at most 30 mints a call; malformed vendor entries are skipped; vendor data never becomes a pool', async () => {
    const mints = Array.from({ length: 61 }, (_, i) => key(i + 1));
    const t = setup(() => json([{ chainId: 'solana' }, null, pair(key(1), 'bad' as Pubkey), pair(key(1), key(200), 'pumpswap', 'ethereum'),
      { ...pair(key(1), key(201)), baseToken: null }, { ...pair(key(1), key(202)), dexId: 'Not Valid!' }]));
    const r = await t.cc.crossCheck([...mints, 'nope' as Pubkey], new Set());
    assert.equal(t.urls.length, 3);
    assert.ok(t.urls.every((u) => u.split('/').at(-1)?.split(',').length as number <= MAX_MINTS_PER_CALL));
    assert.deepEqual([r.checkedMints, r.poolsOnlyInVendor.length, r.status], [61, 0, 'ok']);
  });

  it('a 429 or a revoked licence → unavailable (nothing checked) or partial; the daily call cap stops it; disabled → unavailable', async () => {
    let n = 0;
    const t = setup(() => { n += 1; return n === 1 ? json([]) : new Response('', { status: 429 }); });
    const r = await t.cc.crossCheck(Array.from({ length: 40 }, (_, i) => key(i + 1)), new Set());
    assert.deepEqual([r.status, r.checkedMints], ['partial', 30]);
    const down = setup(() => new Response('', { status: 403 }));
    assert.equal((await down.cc.crossCheck([key(1)], new Set())).status, 'unavailable');
    const notArray = setup(() => json({ pairs: [] }));
    assert.equal((await notArray.cc.crossCheck([key(1)], new Set())).status, 'unavailable');
    const capped = setup(() => json([]), { maxCallsPerDay: 1 });
    assert.equal((await capped.cc.crossCheck(Array.from({ length: 31 }, (_, i) => key(i + 1)), new Set())).status, 'partial');
    assert.equal((await capped.cc.crossCheck([key(1)], new Set())).status, 'unavailable');
    capped.time.now += 86_400_000;
    assert.equal((await capped.cc.crossCheck([key(1)], new Set())).status, 'ok');   // a new UTC day
    const off = setup(() => json([]), { enabled: false });
    assert.equal((await off.cc.crossCheck([key(1)], new Set())).status, 'unavailable');
    assert.equal(off.urls.length, 0);
  });
});

describe('A-M03-04 log fields and the mismatch count (card Z09)', () => {
  it('every field the cross-check logs is declared in M03_LOG_CODES (an undeclared field is written as [redacted])', async () => {
    const [m1] = [key(1)];
    const t = setup(() => json([pair(m1, key(11), 'raydium')]));
    const r = await t.cc.crossCheck([m1], new Set([key(11)]));
    const ev = t.log.events.find((e) => e.code === 'm03.coverage_cross_check');
    assert.ok(ev !== undefined);
    const declared = Object.keys(M03_LOG_CODES['m03.coverage_cross_check'].fields);
    for (const f of Object.keys(ev.fields)) assert.ok(declared.includes(f), `undeclared log field ${f}`);
    assert.equal(r.status, 'dex_id_mismatch');
    assert.equal(r.knownPoolsUnderOtherDex, 1);
  });
});
