// Exposure reservation is atomic under concurrent attempts: several processes, each with its own
// connection, reserve against one limit at the same moment. The total held never passes the limit.
import { describe, expect, it } from 'vitest';
import { openLedger, openLedgerReader } from '../../src/ledger/index.ts';
import { entryIntent } from '../fixtures.ts';
import { runChild, tempPath } from './helpers.ts';

describe('concurrent reservations', () => {
  it('8 processes x 5 reservations of 1,000,000 lamports against a 7,000,000 limit: exactly 7 succeed', async () => {
    const path = tempPath();
    const ledger = openLedger(path, 'paper');
    const ids: string[] = [];
    for (let n = 1; n <= 40; n++) {
      ledger.recordIntent(entryIntent(n), { status: 'risk_approved', ts: n });
      ids.push(`e${n}`);
    }
    ledger.close();

    const startAt = Date.now() + 1_500;
    const children = Array.from({ length: 8 }, (_, c) => runChild(['reserve', path, String(startAt), '7000000', ...ids.slice(c * 5, c * 5 + 5)]));
    const results = await Promise.all(children.map(async (ch) => JSON.parse((await ch.line('result ')).slice('result '.length)) as boolean[]));
    await Promise.all(children.map((ch) => ch.exit));

    expect(results.flat().filter(Boolean)).toHaveLength(7);
    const reader = openLedgerReader(path);
    expect(reader.heldExposure()).toBe(7_000_000n);
    expect(reader.heldReservations()).toHaveLength(7);
    reader.close();
  }, 30_000);
});
