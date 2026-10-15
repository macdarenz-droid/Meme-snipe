// A-M01-05 venue status (card Z07): acceptance criteria "AC<n>", each transition, and failure injection. Config bytes
// are the 2026-10-06 mainnet accounts, edited at known offsets of the pinned layouts to make the "modified copy".
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import type { DecodedEvent, FeeSchedule, Lamports, Slot, VenueId } from '@bot/types';
import { createVenueConfigCache } from '../src/cache.ts';
import { changeDirection, checkStatusSettings, createVenueStatusService, STATUS_DEFAULTS, type FeeScheduleChanged, type StatusSettings, type VenueStatus } from '../src/status.ts';
import { decoders, fakeClock, fakeReader, log, RAW } from './config.ts';
import { poolAtMarketCap, SOL } from './helpers.ts';

// FeeConfig: discriminator 8, bump 1, admin 32, flat_fees 24, then fee_tiers (u32 length, 40 bytes a tier: u128
// threshold, lp, protocol, creator u64). GlobalConfig: discriminator 8, admin 32, lp u64, protocol u64, disable_flags u8.
const TIER0 = 8 + 1 + 32 + 24 + 4;
const protocolOfTier = (i: number): number => TIER0 + 40 * i + 16 + 8;
const DISABLE_FLAGS = 8 + 32 + 8 + 8;
const edited = (data: Uint8Array, at: number, value: number): Uint8Array => { const d = new Uint8Array(data); d[at] = value; return d; };

const metricCalls: string[] = [];
const metrics = { quotable: (v: VenueId, x: 0 | 1) => { metricCalls.push(`quotable:${v}:${x}`); }, feeMismatch: (v: VenueId) => { metricCalls.push(`mismatch:${v}`); } };

async function setup(settings?: StatusSettings) {
  const reader = fakeReader();
  const clock = fakeClock();
  const cache = createVenueConfigCache({ reader, decoder: decoders, clock, log });
  const statuses: VenueStatus[] = [];
  const changes: FeeScheduleChanged[] = [];
  const service = createVenueStatusService({ clock, cache, log, metrics, publishStatus: (s) => statuses.push(s), publishScheduleChange: (c) => changes.push(c), ...(settings === undefined ? {} : { settings }) });
  await cache.refresh();
  return { reader, clock, cache, service, statuses, changes };
}

describe('A-M01-05 acceptance', () => {
  it('AC1: a fee config followed by a copy with one tier raised publishes exactly one raised change; fee_config_known fails for 10 minutes', async () => {
    const s = await setup();
    assert.equal(s.service.feeConfigKnown('pumpswap'), true);
    const at = protocolOfTier(3);
    assert.equal(RAW.pumpswap.data[at], 5);                      // tier 3 (2,460 SOL) is 20/5/85 [EX-07]
    s.reader.accounts[1] = { owner: RAW.pumpswap.owner, data: edited(RAW.pumpswap.data, at, 6) };
    s.clock.t += 60_000;
    await s.cache.refresh();
    assert.equal(s.changes.length, 1);
    assert.equal(s.changes[0]?.direction, 'raised');
    assert.equal(s.changes[0]?.venue, 'pumpswap');
    assert.equal(s.service.status('pumpswap').lastScheduleChangeDirection, 'raised');
    assert.equal(s.service.feeConfigKnown('pumpswap'), false);
    assert.equal(s.service.feeConfigKnown('pump_curve'), true);
    s.clock.t += 599_999;
    await s.cache.refresh();
    assert.equal(s.service.feeConfigKnown('pumpswap'), false);
    s.clock.t += 1;
    assert.equal(s.service.feeConfigKnown('pumpswap'), true);
    assert.equal(s.changes.length, 1);
  });

  it('AC2: three own fills in 24 h whose fees match no candidate make the venue unquotable until acknowledged', async () => {
    const s = await setup();
    const candidates = s.cache.candidateTiers(poolAtMarketCap(100n * SOL));
    const fill = (bps: [number, number, number]): DecodedEvent => ({ kind: 'pumpswap_buy', pool: 'p', baseAmount: 1n, quoteAmount: 1n as Lamports, lpFeeBps: bps[0], protocolFeeBps: bps[1], coinCreatorFeeBps: bps[2], virtualQuoteReserves: 0n, slot: 1n as Slot, signature: 's' });
    s.service.onFillEvent(fill([2, 93, 30]), { poolId: 'p', candidates });      // matches 125
    s.service.onFillEvent(fill([2, 93, 31]), { poolId: 'p', candidates });      // 126: within 1 bp
    assert.equal(s.service.status('pumpswap').feeMismatches24h, 0);
    s.service.onFillEvent(fill([20, 5, 95]), { poolId: 'p', candidates });      // 120: mismatch 1
    s.clock.t += 3_600_000;
    await s.cache.refresh();
    s.service.onFillEvent(fill([20, 5, 95]), { poolId: 'p', candidates });      // 2
    assert.equal(s.service.status('pumpswap').quotable, true);
    s.service.onFillEvent(fill([20, 5, 95]), { poolId: 'p', candidates });      // 3
    const st = s.service.status('pumpswap');
    assert.deepEqual([st.quotable, st.reason, st.extraExitSlippageBps, st.feeMismatches24h], [false, 'fee_mismatch', 100, 3]);
    s.clock.t += 2 * 86_400_000;
    await s.cache.refresh();
    assert.equal(s.service.status('pumpswap').reason, 'fee_mismatch');          // stays after the 24 h window
    assert.equal(s.service.status('pumpswap').feeMismatches24h, 0);
    s.service.setAcks([{ venue: 'pumpswap', ackedAtMs: s.clock.t - 3 * 86_400_000 }]);   // an ack before the latch does not clear it
    assert.equal(s.service.status('pumpswap').reason, 'fee_mismatch');
    s.service.setAcks([{ venue: 'pumpswap', ackedAtMs: s.clock.t }]);
    assert.equal(s.service.status('pumpswap').reason, 'ok');
    assert.equal(s.service.status('pump_curve').reason, 'ok');                  // per venue
    assert.ok(metricCalls.includes('mismatch:pumpswap') && metricCalls.includes('quotable:pumpswap:0'));
  });

  it('AC3: disable_flags = 0 gives enabledBuy = enabledSell = true; bit 3 blocks buys and bit 4 sells (pinned IDL docs)', async () => {
    const s = await setup();
    assert.equal(RAW.global.data[DISABLE_FLAGS], 0);
    let st = s.service.status('pumpswap');
    assert.deepEqual([st.enabledBuy, st.enabledSell, st.reason, st.quotable], [true, true, 'ok', true]);
    for (const [flags, buy, sell] of [[8, false, true], [16, true, false], [7, true, true]] as const) {
      s.reader.accounts[2] = { owner: RAW.global.owner, data: edited(RAW.global.data, DISABLE_FLAGS, flags) };
      await s.cache.refresh();
      st = s.service.status('pumpswap');
      assert.deepEqual([st.enabledBuy, st.enabledSell, st.reason, st.quotable], [buy, sell, buy && sell ? 'ok' : 'disabled_flag', true], `flags ${flags}`);
    }
  });
});

describe('A-M01-05 transitions and failure injection', () => {
  it('a decode error on a fee config makes the venue unquotable with 100 bps extra exit slippage; it recovers on a good read', async () => {
    const s = await setup();
    s.reader.accounts[1] = { owner: RAW.pumpswap.owner, data: new Uint8Array(40) };
    await s.cache.refresh();
    const st = s.service.status('pumpswap');
    assert.deepEqual([st.quotable, st.reason, st.extraExitSlippageBps, st.enabledBuy], [false, 'decode_failed', 100, null]);
    assert.equal(s.service.feeConfigKnown('pumpswap'), false);
    assert.equal(s.statuses.at(-1)?.reason, 'decode_failed');
    s.reader.accounts[1] = { owner: RAW.pumpswap.owner, data: RAW.pumpswap.data };
    await s.cache.refresh();
    assert.deepEqual([s.cache.decodeFailed('feeConfigPumpSwap'), s.cache.decodeFailed('pumpSwapGlobalConfig'), s.cache.inputs('pumpswap').ok], [false, false, true]);
    assert.equal(s.service.status('pumpswap').reason, 'ok');
    assert.equal(s.statuses.at(-1)?.reason, 'ok');
  });

  it('a config older than max_age_ms is config_stale (unread at start too); fresh again after a good read', async () => {
    const s = await setup();
    s.reader.fail = true;
    s.clock.t += 600_001;
    s.service.evaluate();
    assert.equal(s.service.status('pump_curve').reason, 'config_stale');
    assert.equal(s.statuses.at(-1)?.reason, 'config_stale');
    s.reader.fail = false;
    await s.cache.refresh();
    assert.equal(s.service.status('pump_curve').reason, 'ok');
  });

  it('Raydium venues are unquotable, venue_not_specified; statuses are published once per change', async () => {
    const s = await setup();
    assert.equal(s.service.status('raydium_cpmm').reason, 'venue_not_specified');
    const n = s.statuses.length;
    s.service.evaluate();
    s.service.evaluate();
    assert.equal(s.statuses.length, n);
    const venues = new Set(s.statuses.map((x) => x.venue));
    assert.deepEqual([...venues].sort(), ['pump_curve', 'pumpswap', 'raydium_amm_v4', 'raydium_cpmm']);
  });

  it('recorded fills at 2/93/30 and 20/5/95 (CORE-2 canonical buys either side of 420 SOL) match their candidates: no mismatch', async () => {
    const s = await setup();
    const below = s.cache.candidateTiers(poolAtMarketCap(300n * SOL));
    const above = s.cache.candidateTiers(poolAtMarketCap(500n * SOL));
    const ev = (lp: number, pr: number, cr: number): DecodedEvent => ({ kind: 'pumpswap_sell', pool: 'p', baseAmount: 1n, quoteAmount: 1n as Lamports, lpFeeBps: lp, protocolFeeBps: pr, coinCreatorFeeBps: cr, virtualQuoteReserves: 0n, slot: 1n as Slot, signature: 's' });
    s.service.onFillEvent(ev(2, 93, 30), { poolId: 'p', candidates: below });
    s.service.onFillEvent(ev(20, 5, 95), { poolId: 'p', candidates: above });
    assert.equal(s.service.status('pumpswap').feeMismatches24h, 0);
  });

  it('curve fills: a total off every candidate counts; a mayhem-mode 0/0 trade and non-trade events do not', async () => {
    const s = await setup();
    const curve: FeeSchedule[] = [{ lpBps: 0, protocolBps: 95, creatorBps: 30, totalBps: 125, feeOnBuy: 'added_on_top', sourceAccount: 'x', asOfSlot: 1n as Slot, configHash: 'h' }];
    const trade = (fee: number, creator: number): DecodedEvent => ({ kind: 'pump_trade', mint: 'm', isBuy: true, solAmount: 1n as Lamports, tokenAmount: 1n, feeBps: fee, fee: 0n as Lamports, creatorFeeBps: creator, creatorFee: 0n as Lamports, quoteMint: null, slot: 1n as Slot, signature: 's' });
    s.service.onFillEvent(trade(0, 0), { poolId: 'c', candidates: curve });
    s.service.onFillEvent({ kind: 'pump_complete', mint: 'm', slot: 1n as Slot, signature: 's' }, { poolId: 'c', candidates: curve });
    s.service.onFillEvent(trade(95, 30), { poolId: 'c', candidates: curve });
    assert.equal(s.service.status('pump_curve').feeMismatches24h, 0);
    s.service.onFillEvent(trade(100, 30), { poolId: 'c', candidates: curve });
    assert.equal(s.service.status('pump_curve').feeMismatches24h, 1);
  });
});

describe('A-M01-05 / addendum A16: an unknown event length demotes the venue', () => {
  it('an unknown_length layout makes the venue unquotable (unknown_layout) until the pair is reviewed; the other venue is unaffected', async () => {
    const reviewed = new Set<string>();
    const reader = fakeReader();
    const clock = fakeClock();
    const cache = createVenueConfigCache({ reader, decoder: decoders, clock, log });
    const statuses: VenueStatus[] = [];
    const service = createVenueStatusService({ clock, cache, log, publishStatus: (x) => statuses.push(x), publishScheduleChange: () => {}, isReviewed: (p, d) => reviewed.has(`${p}:${d}`) });
    await cache.refresh();
    service.onUnknownLayout({ venue: 'pumpswap', programId: 'amm', discriminatorHex: '67f4521f2cf57777' });
    service.onUnknownLayout({ venue: 'pumpswap', programId: 'amm', discriminatorHex: '67f4521f2cf57777' });
    const st = service.status('pumpswap');
    assert.deepEqual([st.quotable, st.reason, st.extraExitSlippageBps], [false, 'unknown_layout', 100]);
    assert.equal(service.status('pump_curve').reason, 'ok');
    assert.equal(statuses.at(-1)?.reason, 'unknown_layout');
    reviewed.add('amm:67f4521f2cf57777');
    service.evaluate();
    assert.equal(service.status('pumpswap').reason, 'ok');
    assert.equal(statuses.at(-1)?.reason, 'ok');
    // Without a review port nothing is reviewed.
    const s2 = await setup();
    s2.service.onUnknownLayout({ venue: 'pump_curve', programId: 'pump', discriminatorHex: 'bddb7fd34ee661ee' });
    assert.equal(s2.service.status('pump_curve').reason, 'unknown_layout');
  });
});

describe('A-M01-05 direction and settings', () => {
  const fc = (flat: number, tiers: Array<[bigint, number]>) => ({
    kind: 'pump_fee_config', flat: { lpBps: 0, protocolBps: flat, creatorBps: 0 }, raw: {},
    tiers: tiers.map(([t, p]) => ({ thresholdLamports: t as Lamports, lpBps: 0, protocolBps: p, creatorBps: 0 })),
  });
  it('raised, lowered and mixed; a change with no total moved and a non fee-config account are mixed', () => {
    assert.equal(changeDirection(fc(5, [[0n, 10]]), fc(5, [[0n, 11]])), 'raised');
    assert.equal(changeDirection(fc(5, [[0n, 10]]), fc(4, [[0n, 10]])), 'lowered');
    assert.equal(changeDirection(fc(5, [[0n, 10], [9n, 8]]), fc(5, [[0n, 11], [9n, 7]])), 'mixed');
    assert.equal(changeDirection(fc(5, [[0n, 10]]), fc(5, [[0n, 10], [9n, 10]])), 'mixed');
    assert.equal(changeDirection(fc(5, [[0n, 10]]), fc(6, [])), 'raised');
    assert.equal(changeDirection({ kind: 'pump_global', raw: {} }, fc(5, [])), 'mixed');
    // A tier with no change but a new, dearer threshold above.
    assert.equal(changeDirection(fc(5, [[0n, 10]]), fc(5, [[0n, 10], [9n, 12]])), 'raised');
  });

  it('settings: tolerance 0..10 bps and 1..10 mismatches a day; a bad setting refuses to build the service', async () => {
    assert.ok(checkStatusSettings(STATUS_DEFAULTS).ok);
    for (const bad of [{ toleranceBps: 11 }, { toleranceBps: -1 }, { maxPer24h: 0 }, { maxPer24h: 11 }]) assert.ok(!checkStatusSettings({ ...STATUS_DEFAULTS, ...bad }).ok);
    await assert.rejects(setup({ ...STATUS_DEFAULTS, maxPer24h: 0 }));
    const s = await setup({ toleranceBps: 0, maxPer24h: 1, acks: [] });
    s.service.onFillEvent({ kind: 'pumpswap_buy', pool: 'p', baseAmount: 1n, quoteAmount: 1n as Lamports, lpFeeBps: 2, protocolFeeBps: 93, coinCreatorFeeBps: 31, virtualQuoteReserves: 0n, slot: 1n as Slot, signature: 's' }, { poolId: 'p', candidates: s.cache.candidateTiers(poolAtMarketCap(100n * SOL)) });
    assert.equal(s.service.status('pumpswap' as VenueId).reason, 'fee_mismatch');
  });
});
