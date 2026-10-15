// A-M02-05 quarantine writer (card Z07), on a real migrated M24 database. The unknown events are synthetic: a recorded
// PumpSwap transaction (fixtures/mainnet/tx/pumpswap) with its event discriminator overwritten, or with bytes appended
// to the event (an unknown length, addendum A16), decoded by the pinned decoders (ruling Z07-5).
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { createDecoders, readRpcTransaction, verifyPinnedIdls, VENDORED_IDL_DIR } from '@bot/decoders';
import type { RawTransaction } from '@bot/types';
import { MINTS, PROGRAMS } from '@bot/venue/constants';
import { createQuarantine, MAX_SAMPLE_B64, type QuarantineRow, type UnknownLayout } from '../../src/m02/quarantine.ts';
import { openDb } from '../../src/m24/db.ts';
import { prepareDatabase } from '../../src/m24/migrate.ts';
import { createRepos } from '../../src/m24/repos.ts';
import { fakeClock, tempDir } from '../helpers.ts';
import { ulid } from '../m24/samples.ts';

const idls = verifyPinnedIdls(VENDORED_IDL_DIR);
assert.ok(idls.ok);
const decoders = createDecoders(idls.value, { wsolMint: MINTS.wsol });
const rec = JSON.parse(readFileSync(new URL('../../../../fixtures/mainnet/tx/pumpswap/tx_2JncvkXg.json', import.meta.url), 'utf8')) as { signature: string; json: unknown };
const swap = (): RawTransaction => {
  const r = readRpcTransaction(rec.signature, rec.json);
  assert.ok(r.ok);
  return r.value;
};
const EVENT_CPI = 'e445a52e51cb9a1d';
const eventIx = (t: RawTransaction) => t.meta.innerInstructions.flatMap((g) => g.instructions).find((x) => Buffer.from(x.dataB64, 'base64').subarray(0, 8).toString('hex') === EVENT_CPI) as { dataB64: string };
/** Synthetic: the recorded swap with its event discriminator overwritten by 0xab bytes (and no logs, so no fallback). */
const unknownEventTx = (): RawTransaction => {
  const t = swap();
  const ix = eventIx(t);
  const data = Buffer.from(ix.dataB64, 'base64');
  data.fill(0xab, 8, 16);
  ix.dataB64 = data.toString('base64');
  t.meta.logMessages = null;
  return t;
};
const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);

async function setup(failWrites = { on: false }) {
  const path = join(tempDir('m02q'), 'bot.db');
  const db = openDb({ create: true, path, clock: fakeClock(T0) });
  assert.equal((await prepareDatabase(db, { clock: fakeClock(T0), backupPath: `${path}.bak` })).ok, true);
  const repos = createRepos();
  const clock = fakeClock(T0);
  const logs: Array<[string, string, Record<string, unknown>]> = [];
  const published: UnknownLayout[] = [];
  let n = 0;
  const q = createQuarantine({
    clock, newId: () => ulid(++n), allowlisted: new Set([PROGRAMS.pumpCurve, PROGRAMS.pumpSwap]),
    insert: (row: QuarantineRow) => { if (failWrites.on) throw new Error('disk I/O error'); db.withTx((tx) => repos.quarantine.insert(tx, row)); },
    log: { event: (level, code, fields) => { logs.push([level, code, { ...fields }]); } },
    publish: (e) => published.push(e),
  });
  const rows = () => repos.quarantine.find(db.reader()).map((r) => ({ programId: r.programId, discriminator: r.discriminator, rawB64: r.rawB64, signature: r.signature }));
  return { db, q, clock, logs, published, rows };
}

/** Feeds a transaction's unknown events to the quarantine, as the engine wiring does. */
const feed = (q: ReturnType<typeof createQuarantine>, t: RawTransaction, poolId: string | null): void => {
  for (const e of decoders.decodeTransactionEvents(t)) {
    if (e.kind === 'unknown_event') q.record({ programId: e.programId, discriminatorHex: e.discriminatorHex, rawB64: eventIx(t).dataB64, signature: e.signature, poolId });
  }
};

describe('A-M02-05 quarantine', () => {
  it('AC (synthetic unknown event): 100 transactions with the same unknown discriminator give one row, one alert, one decoder.unknown_layout per pool', async () => {
    const s = await setup();
    for (let i = 0; i < 100; i++) feed(s.q, unknownEventTx(), i < 60 ? 'pool-a' : 'pool-b');
    assert.equal(s.rows().length, 1);
    assert.deepEqual(s.rows()[0], { programId: PROGRAMS.pumpSwap, discriminator: 'abababababababab', rawB64: eventIx(unknownEventTx()).dataB64, signature: rec.signature });
    assert.equal(s.logs.filter(([, c]) => c === 'm02.quarantined').length, 1);
    assert.deepEqual(s.published.map((p) => [p.poolId, p.kind, p.discriminatorHex]), [['pool-a', 'unknown_discriminator', 'abababababababab'], ['pool-b', 'unknown_discriminator', 'abababababababab']]);
    s.q.flush();
    assert.deepEqual(s.logs.at(-1), ['info', 'm02.quarantine_counts', { counts: { [`${PROGRAMS.pumpSwap}:abababababababab`]: 100 } }]);
    s.db.close();
  });

  it('A16 (synthetic unknown length): an event with bytes past its pinned layout is recorded as unknown_length', async () => {
    const s = await setup();
    const t = swap();
    const ix = eventIx(t);
    ix.dataB64 = Buffer.concat([Buffer.from(ix.dataB64, 'base64'), Buffer.alloc(8, 9)]).toString('base64');
    const located = decoders.decodeTransactionEventsLocated(t);
    const extended = located.filter((e) => e.layoutExtended);
    assert.equal(extended.length, 1);
    const disc = Buffer.from(ix.dataB64, 'base64').subarray(8, 16).toString('hex');
    s.q.record({ programId: PROGRAMS.pumpSwap, discriminatorHex: disc, rawB64: ix.dataB64, signature: t.signature, poolId: 'pool-a', kind: 'unknown_length' });
    assert.deepEqual(s.published.map((p) => p.kind), ['unknown_length']);
    assert.equal(s.rows().length, 1);
    s.db.close();
  });

  it('edge 2: a failed database write keeps the record and retries at the next flush; decoding never blocks', async () => {
    const fail = { on: true };
    const s = await setup(fail);
    feed(s.q, unknownEventTx(), 'pool-a');
    assert.equal(s.rows().length, 0);
    assert.ok(s.logs.some(([l, c]) => l === 'error' && c === 'm02.quarantine_write_failed'));
    s.q.flush();
    assert.equal(s.rows().length, 0);
    fail.on = false;
    s.q.flush();
    s.q.flush();
    assert.equal(s.rows().length, 1);
    assert.equal(s.published.length, 1);
    s.db.close();
  });

  it('only allowlisted programs; reviewed pairs come from decoders.reviewed_discriminators; samples are capped at 10 KB of base64', async () => {
    const s = await setup();
    s.q.record({ programId: PROGRAMS.raydiumCpmm, discriminatorHex: '00', rawB64: '', signature: null, poolId: null });
    assert.equal(s.rows().length, 0);
    assert.equal(s.q.isReviewed(PROGRAMS.pumpSwap, 'abababababababab'), false);
    s.q.setReviewed([{ programId: PROGRAMS.pumpSwap, discriminatorHex: 'abababababababab', note: 'reviewed in a test' }]);
    assert.equal(s.q.isReviewed(PROGRAMS.pumpSwap, 'abababababababab'), true);
    s.q.record({ programId: PROGRAMS.pumpCurve, discriminatorHex: 'cd', rawB64: 'A'.repeat(20_000), signature: null, poolId: null });
    s.q.record({ programId: PROGRAMS.pumpCurve, discriminatorHex: 'ef', rawB64: '<script>', signature: null, poolId: null });
    const rows = s.rows();
    assert.equal((rows.find((r) => r.discriminator === 'cd')?.rawB64 as string).length, MAX_SAMPLE_B64);
    assert.equal(rows.find((r) => r.discriminator === 'ef')?.rawB64, '');
    s.q.flush();
    s.db.close();
  });

  it('an empty quarantine logs no counts at flush', async () => {
    const s = await setup();
    s.q.flush();
    assert.deepEqual(s.logs, []);
    s.db.close();
  });
});
