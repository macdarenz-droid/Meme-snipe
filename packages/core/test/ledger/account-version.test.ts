// LEDGER-1c: the real store refuses a reservation decided from an old account snapshot (RISK-1 review of PR #18,
// item 1). The version is derived inside the same BEGIN IMMEDIATE as the limit check and the insert.
import { describe, expect, it } from 'vitest';
import { openLedger, openLedgerReader } from '../../src/ledger/index.ts';
import { ACCOUNT_VERSION_TABLES, type Ledger } from '../../src/ledger/ledger.ts';
import { lamports } from '../../src/units/index.ts';
import { attempt, entryIntent, fill } from '../fixtures.ts';
import { tempPath } from './helpers.ts';

const LIMITS = { maxHeld: lamports(50_000_000), maxCount: 1 };

const reserve = (ledger: Ledger, n: number, accountVersion?: bigint) => ledger.reserveExposure({
  reservationId: `r${n}`, intentId: `e${n}`, amount: lamports(20_000_000), limits: LIMITS, ts: 10 + n,
  transition: { status: 'exposure_reserved', event: 'reserve' },
  ...(accountVersion === undefined ? {} : { accountVersion }),
});

describe('LEDGER-1c: account version', () => {
  it('A and B decided from one snapshot: A reserves, fills and releases; B is refused stale_snapshot', () => {
    const ledger = openLedger(tempPath(), 'paper');
    for (const n of [1, 2]) ledger.recordIntent(entryIntent(n), { status: 'risk_approved', ts: n });
    const snapshot = ledger.accountVersion(); // both decisions are made from this snapshot
    expect(reserve(ledger, 1, snapshot)).toEqual({ ok: true, heldAfter: 20_000_000n });
    ledger.recordFill(fill(entryIntent(1).id, 1, 1_000n), 20); // A filled ...
    ledger.endReservation('r1', 'kept', 21); // ... its reservation ends ...
    ledger.openPosition({ positionId: 'p1', mint: entryIntent(1).mint, venue: 'pump-curve', entryIntentId: 'e1', ts: 22 }); // ... a position opens
    expect(ledger.heldExposure()).toBe(0n); // the count limit alone would now let B through
    expect(reserve(ledger, 2, snapshot)).toEqual({ ok: false, reason: 'stale_snapshot' });
    expect(ledger.heldReservations()).toEqual([]);
    expect(ledger.intent('e2')?.status).toBe('risk_approved'); // a refused reservation writes nothing
    // Decided again from the current account, it reaches the limit checks.
    expect(reserve(ledger, 2, ledger.accountVersion())).toEqual({ ok: true, heldAfter: 20_000_000n });
    ledger.close();
  });

  it('a second reservation from the same snapshot is refused even with room under every limit', () => {
    const ledger = openLedger(tempPath(), 'paper');
    for (const n of [1, 2]) ledger.recordIntent(entryIntent(n), { status: 'risk_approved', ts: n });
    const v = ledger.accountVersion();
    const roomy = { maxHeld: lamports(1_000_000_000), maxCount: 5 };
    const r = (n: number) => ledger.reserveExposure({ reservationId: `r${n}`, intentId: `e${n}`, amount: lamports(1), limits: roomy, ts: n, accountVersion: v });
    expect(r(1).ok).toBe(true);
    expect(r(2)).toEqual({ ok: false, reason: 'stale_snapshot' });
    ledger.close();
  });

  it('every account change advances the version; intents, attempts and market data do not', () => {
    const ledger = openLedger(tempPath(), 'paper');
    const e1 = entryIntent(1);
    let v = ledger.accountVersion();
    const advanced = (what: string) => { const now = ledger.accountVersion(); expect(now, what).toBeGreaterThan(v); v = now; };
    const same = (what: string) => expect(ledger.accountVersion(), what).toBe(v);

    ledger.recordIntent(e1, { status: 'risk_approved', ts: 1 });
    same('intent');
    ledger.appendIntentTransition({ intentId: e1.id, status: 'risk_approved', event: 'noop', ts: 2 });
    same('intent event');
    ledger.recordObservation({ provider: 'test', mint: e1.mint, kind: 'quote', receiptTs: 3, payload: { mark: 1 } });
    same('observation (a mark)');
    expect(reserve(ledger, 1, v).ok).toBe(true);
    advanced('reservation');
    ledger.recordAttempt(attempt(e1.id, 1, 500n), 4);
    same('attempt');
    ledger.recordFill(fill(e1.id, 1, 1_000n), 5);
    advanced('fill');
    ledger.recordFee({ intentId: e1.id, kind: 'priority', lamports: lamports(20_000), ts: 6 });
    advanced('fee');
    ledger.endReservation('r1', 'kept', 7);
    advanced('reservation end');
    ledger.openPosition({ positionId: 'p1', mint: e1.mint, venue: 'pump-curve', entryIntentId: 'e1', ts: 8 });
    advanced('position');
    ledger.appendPositionState({ positionId: 'p1', status: 'open', quantity: 1_000n, cost: lamports(20_000_000), event: 'filled', ts: 9 });
    advanced('position state');
    ledger.recordCommand({ commandId: 'c1', command: 'resume', authLevel: 'dashboard_passkey', issuedBy: 'owner', issuedTs: 10 });
    advanced('operator command');
    ledger.recordCommandResult('c1', true, 'ok', 11);
    advanced('command result');
    ledger.close();
  });

  it('the version is the same for a reader and survives a reopen', () => {
    const path = tempPath();
    const ledger = openLedger(path, 'paper');
    ledger.recordIntent(entryIntent(1), { status: 'risk_approved', ts: 1 });
    expect(reserve(ledger, 1, ledger.accountVersion()).ok).toBe(true);
    const v = ledger.accountVersion();
    const reader = openLedgerReader(path);
    expect(reader.accountVersion()).toBe(v);
    reader.close();
    ledger.close();
    const again = openLedger(path, 'paper');
    expect(again.accountVersion()).toBe(v);
    again.close();
  });

  it('a reservation without a version (a mirror of decisions already made) keeps the old behaviour', () => {
    const ledger = openLedger(tempPath(), 'paper');
    ledger.recordIntent(entryIntent(1), { status: 'risk_approved', ts: 1 });
    expect(reserve(ledger, 1)).toEqual({ ok: true, heldAfter: 20_000_000n });
    ledger.close();
  });

  it('counts exactly the tables it documents', () => {
    expect([...ACCOUNT_VERSION_TABLES].sort()).toEqual(['command_result', 'fee', 'fill', 'operator_command', 'position', 'position_event', 'reservation', 'reservation_event']);
  });
});
