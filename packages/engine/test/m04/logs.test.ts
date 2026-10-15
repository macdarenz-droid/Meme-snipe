// Card Z07's log lines through the real M27 logger: every code the venue cache, venue status, orientation guard,
// quarantine writer and M04 tracker write is declared (no `m27.unknown_code`) and no field is redacted (snake_case
// names, declared kinds).
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { createDecoders, M02_LOG_CODES, verifyPinnedIdls, VENDORED_IDL_DIR } from '@bot/decoders';
import type { DecodedEvent, Lamports, Slot } from '@bot/types';
import { M01_LOG_CODES, PROGRAMS } from '@bot/venue/constants';
import { createOrientationGuard, createOrientationSampler, createVenueConfigCache, createVenueStatusService, M01_VENUE_LOG_CODES } from '@bot/venue';
import { createQuarantine, M02_QUARANTINE_LOG_CODES } from '../../src/m02/quarantine.ts';
import { M04_LOG_CODES } from '../../src/m04/log.ts';
import { M04_DEFAULTS } from '../../src/m04/settings.ts';
import { createPollSource, createSubscribeSource, type SubscribeTransport } from '../../src/m04/source.ts';
import { createPoolTracker } from '../../src/m04/tracker.ts';
import { createLogger, M27_LOG_CODES, mergeLogCodes, REDACTED } from '../../src/m27/log.ts';
import { FakeTime } from '../m14/helpers.ts';
import { ulid } from '../m24/samples.ts';
import { FakeChain, fakeModel, Outputs, poolAccounts, ScriptedReader, u64, type FakePool } from './fake.ts';

describe('card Z07 log codes', () => {
  it('every line written by the Z07 modules is a declared code with nothing redacted', async () => {
    const lines: string[] = [];
    const time = new FakeTime();
    const log = createLogger({
      clock: time, runId: 'R', mode: 'paper', minLevel: 'debug', sink: { write: (l) => { lines.push(l); return 'written'; } },
      codes: mergeLogCodes(M27_LOG_CODES, M01_LOG_CODES, M01_VENUE_LOG_CODES, M02_LOG_CODES, M02_QUARANTINE_LOG_CODES, M04_LOG_CODES),
    });
    const idls = verifyPinnedIdls(VENDORED_IDL_DIR);
    assert.ok(idls.ok);
    const decoders = createDecoders(idls.value, { tokenPrograms: { splToken: PROGRAMS.splToken, token2022: PROGRAMS.token2022 } });

    // Venue cache and status: a failed refresh, a decode failure, a change, a mismatch, a status change.
    let fail = true;
    const accounts = [{ owner: PROGRAMS.pumpFees, data: new Uint8Array(40) }, null, null, null];
    const cache = createVenueConfigCache({ reader: { read: async () => (fail ? { ok: false, error: { code: 'E_TIMEOUT' } } : { ok: true, value: { contextSlot: 5n as Slot, accounts } }) }, decoder: decoders, clock: time, log });
    const status = createVenueStatusService({ clock: time, cache, log, publishStatus: () => {}, publishScheduleChange: () => {} });
    await cache.refresh();
    fail = false;
    await cache.refresh();
    status.onFillEvent({ kind: 'pumpswap_buy', pool: 'p', baseAmount: 1n, quoteAmount: 1n as Lamports, lpFeeBps: 1, protocolFeeBps: 1, coinCreatorFeeBps: 1, virtualQuoteReserves: 0n, slot: 1n as Slot, signature: 's' } as DecodedEvent, { poolId: 'p', candidates: [] });

    // Orientation guard and sampler.
    const guard = createOrientationGuard({ clock: time, log, publish: () => {} });
    guard.quarantine('pool-1', 'owner_changed');
    const sampler = createOrientationSampler({ clock: time, guard, log, decode: () => [], snapshotBefore: () => null, source: { signatures: async () => ({ ok: false, error: { code: 'E_RPC' } }), transaction: async () => ({ ok: true, value: null }) } });
    await sampler.tick(['pool-2']);

    // Quarantine writer.
    const q = createQuarantine({ clock: time, insert: () => { throw new Error('disk'); }, newId: () => ulid(1), allowlisted: new Set([PROGRAMS.pumpSwap]), log, publish: () => {} });
    q.record({ programId: PROGRAMS.pumpSwap, discriminatorHex: 'ab', rawB64: '', signature: null, poolId: null });
    q.flush();

    // M04: a refused source, a failed poll, a closed pool, a stale pool, an exit read far behind, a closing subscription.
    const reader = new ScriptedReader();
    for (const [k, v] of poolAccounts('a', 1n, 2n)) reader.accounts.set(k, v);
    for (const [k, v] of poolAccounts('b', 1n, 2n)) reader.accounts.set(k, v);
    reader.accounts.set('odd', { owner: 'amm', data: new Uint8Array([9]) });
    for (const [k, v] of poolAccounts('nm', 1n, 2n)) reader.accounts.set(k, v);
    reader.accounts.set('nm:m', null);
    const chain = new FakeChain();
    reader.slot = () => chain.highest;
    const refusing = createSubscribeSource({ enabled: false, fallback: createPollSource({ reader, scheduler: time, settings: M04_DEFAULTS, log }), log });
    const tracker = createPoolTracker<FakePool>({ model: fakeModel, reader, scheduler: time, chain, clock: time, outputs: new Outputs(), log, source: refusing, providerOrder: () => ['primary'] });
    for (const id of ['a', 'b', 'odd']) tracker.watch(id, 'candidate');
    tracker.watch('missing', 'tail');
    tracker.watch('nm', 'tail');
    await tracker.settled();
    tracker.start();
    await time.advance(1_000);
    reader.accounts.set('b', null);
    reader.accounts.set('a:q', { owner: 'tok', data: u64(3n) });
    reader.fail = true;
    chain.highest += 50n;
    await time.advance(1_000);
    reader.fail = false;
    reader.slot = () => chain.highest - 45n;
    await tracker.freshRead('a', Number.POSITIVE_INFINITY);
    await time.advance(1_000);
    tracker.stop();
    const transport: SubscribeTransport = { open: (_p, _d, closed) => closed(), close: () => {} };
    createSubscribeSource({ enabled: true, transport, fallback: createPollSource({ reader, scheduler: time, settings: M04_DEFAULTS, log }), log }).start([]);

    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const codes = new Set(parsed.map((l) => l.code));
    assert.equal(codes.has('m27.unknown_code'), false, JSON.stringify(parsed.filter((l) => l.code === 'm27.unknown_code')));
    for (const l of parsed) for (const [k, v] of Object.entries(l)) assert.notEqual(v, REDACTED, `${String(l.code)}.${k}`);
    for (const c of ['m01.fee_config_refresh_failed', 'm01.fee_config_decode_failed', 'm01.fee_config_refreshed', 'm01.venue_status_changed', 'm01.fee_mismatch',
      'm01.pool_quarantined', 'm01.orientation_read_failed', 'm02.quarantined', 'm02.quarantine_write_failed', 'm02.quarantine_counts',
      'm04.source_refused', 'm04.pool_unreadable', 'm04.first_read_failed', 'm04.poll_failed', 'm04.pool_stale', 'm04.pool_closed', 'm04.exit_read_lagging', 'm04.subscribe_closed']) {
      assert.ok(codes.has(c), c);
    }
  });
});
