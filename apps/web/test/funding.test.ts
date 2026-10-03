import { describe, expect, it } from 'vitest';
import { audCents, formatAud, formatLamports, fromLamports, parseSol } from '../src/funding/sol.ts';
import { approve, approvingStepUp, unavailableStepUp, whileBusy, type StepUp, type StepUpRequest } from '../src/funding/stepUp.ts';
import {
  SAVED_WALLET_DELAY_MS,
  TRANSFER_FEE_LAMPORTS,
  checkWithdraw,
  createTransferRequest,
  isAddress,
  maxSendable,
  requestSavedWalletChange,
  type WithdrawInput,
} from '../src/funding/withdraw.ts';
import { fixtureWallet } from '../src/dev/fixtures.ts';

const SAVED = fixtureWallet.savedWallet!;
const OTHER = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const base: WithdrawInput = { to: SAVED, amount: '1', savedWallet: SAVED, balanceSol: '10', reserveSol: '0.75' };
const NOW = new Date('2026-10-03T14:00:00Z');

describe('SOL amounts', () => {
  it('parses and prints exact decimals', () => {
    expect(parseSol('0.015')).toBe(15_000_000n);
    expect(parseSol('0.000000001')).toBe(1n);
    expect(fromLamports(15_000_000n)).toBe('0.015');
    expect(fromLamports(2_000_000_000n)).toBe('2');
    expect(formatLamports(1_234_500_000_000n)).toBe('1,234.5 SOL');
  });
  it('rejects anything that is not an exact amount', () => {
    for (const s of ['', '-1', '1e3', '0.0000000001', '1,5', ' 1', 'abc', '.5', '1.']) expect(parseSol(s)).toBeNull();
  });
  it('values SOL in AUD to the cent without floating point', () => {
    expect(formatAud(1_000_000_000n, '171.58')).toBe('A$171.58');
    expect(audCents(5_000n, '171.58')).toBe(0n);
    expect(formatAud(138_456_000_000n, '171.58')).toBe('A$23,756.28');
    expect(formatAud(1n, null)).toBe('');
    expect(formatAud(1n, '0')).toBe('');
  });
});

describe('withdraw destination', () => {
  it('accepts the saved wallet', () => {
    expect(checkWithdraw(base)).toEqual({ ok: true, lamports: 1_000_000_000n });
  });
  it('refuses a foreign address that is a valid Solana address', () => {
    expect(isAddress(OTHER)).toBe(true);
    expect(checkWithdraw({ ...base, to: OTHER })).toEqual({ ok: false, field: 'to', problem: 'address-foreign' });
  });
  it('refuses an address that differs from the saved one by a single character', () => {
    const near = SAVED.slice(0, -1) + (SAVED.endsWith('W') ? 'X' : 'W');
    expect(checkWithdraw({ ...base, to: near })).toMatchObject({ ok: false, problem: 'address-foreign' });
  });
  it('refuses malformed addresses', () => {
    for (const to of ['abc', SAVED.slice(0, 20), `${SAVED}12`, `0${SAVED.slice(1)}`, 'not an address at all, with spaces in it okay', `${SAVED.slice(0, 43)}l`]) {
      expect(checkWithdraw({ ...base, to })).toEqual({ ok: false, field: 'to', problem: 'address-malformed' });
    }
  });
  it('refuses an empty address and a missing saved wallet', () => {
    expect(checkWithdraw({ ...base, to: '  ' })).toMatchObject({ problem: 'address-missing' });
    expect(checkWithdraw({ ...base, savedWallet: null })).toMatchObject({ problem: 'no-saved-wallet' });
  });
});

describe('withdraw amount', () => {
  it('limits to balance minus reserve minus the transfer fee', () => {
    expect(maxSendable('10', '0.75')).toBe(10_000_000_000n - 750_000_000n - TRANSFER_FEE_LAMPORTS);
    expect(maxSendable('0.5', '0.75')).toBe(0n);
    expect(maxSendable(null, '0.75')).toBeNull();
    expect(maxSendable('10', null)).toBeNull();
  });
  it('refuses an amount over what is available, to the last lamport', () => {
    const max = maxSendable('10', '0.75')!;
    expect(checkWithdraw({ ...base, amount: fromLamports(max) })).toMatchObject({ ok: true });
    expect(checkWithdraw({ ...base, amount: fromLamports(max + 1n) })).toEqual({ ok: false, field: 'amount', problem: 'over-available' });
    expect(checkWithdraw({ ...base, amount: '10' })).toMatchObject({ problem: 'over-available' });
  });
  it('refuses when the balance is zero or below the reserve', () => {
    expect(checkWithdraw({ ...base, balanceSol: '0.5', amount: '0.1' })).toMatchObject({ problem: 'over-available' });
    expect(checkWithdraw({ ...base, balanceSol: '0', amount: '0.1' })).toMatchObject({ problem: 'over-available' });
  });
  it('refuses missing, malformed, negative and zero amounts', () => {
    expect(checkWithdraw({ ...base, amount: '' })).toMatchObject({ problem: 'amount-missing' });
    for (const amount of ['abc', '-1', '1e2', '0.0000000001', '1,5']) expect(checkWithdraw({ ...base, amount })).toMatchObject({ problem: 'amount-invalid' });
    expect(checkWithdraw({ ...base, amount: '0' })).toMatchObject({ problem: 'amount-zero' });
    expect(checkWithdraw({ ...base, amount: '0.000000000' })).toMatchObject({ problem: 'amount-zero' });
  });
  it('refuses when the balance or reserve is unknown', () => {
    expect(checkWithdraw({ ...base, balanceSol: null })).toMatchObject({ problem: 'balance-unknown' });
    expect(checkWithdraw({ ...base, reserveSol: null })).toMatchObject({ problem: 'balance-unknown' });
  });
});

describe('transfer request and passkey step-up', () => {
  it('builds an unsigned request only after the step-up passes', async () => {
    const seen: StepUpRequest[] = [];
    const stepUp: StepUp = { verify: (r) => (seen.push(r), Promise.resolve(true)) };
    const r = await createTransferRequest({ ...base, amount: '1.5' }, stepUp, NOW);
    expect(r).toEqual({ ok: true, request: { to: SAVED, amountSol: '1.5', lamports: '1500000000', status: 'unsigned', createdAt: NOW.toISOString() } });
    expect(seen).toEqual([{ action: 'withdraw', summary: `Send 1.5 SOL to ${SAVED}` }]);
  });
  it('creates nothing when the step-up fails, throws or is unavailable', async () => {
    for (const stepUp of [unavailableStepUp, { verify: () => Promise.reject(new Error('cancelled')) } as StepUp]) {
      expect(await createTransferRequest(base, stepUp, NOW)).toEqual({ ok: false, field: 'form', problem: 'step-up-failed' });
    }
  });
  it('treats a step-up that throws synchronously as a refusal and creates nothing', async () => {
    const throwing: StepUp = {
      verify: () => {
        throw new Error('no passkey support');
      },
    };
    expect(await approve(throwing, { action: 'withdraw', summary: 'x' })).toBe(false);
    expect(await createTransferRequest(base, throwing, NOW)).toEqual({ ok: false, field: 'form', problem: 'step-up-failed' });
    expect(await requestSavedWalletChange(SAVED, OTHER, throwing, NOW)).toEqual({ ok: false, problem: 'step-up-failed' });
  });
  it('turns the busy flag off after the work, whether it succeeds or throws', async () => {
    const log: boolean[] = [];
    await whileBusy((b) => log.push(b), () => Promise.resolve(1));
    await expect(whileBusy((b) => log.push(b), () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(log).toEqual([true, false, true, false]);
  });
  it('does not even ask for the step-up when the form is invalid', async () => {
    let asked = 0;
    const stepUp: StepUp = { verify: () => (asked++, Promise.resolve(true)) };
    expect(await createTransferRequest({ ...base, to: OTHER }, stepUp, NOW)).toMatchObject({ ok: false, problem: 'address-foreign' });
    expect(await createTransferRequest({ ...base, amount: '999' }, stepUp, NOW)).toMatchObject({ ok: false, problem: 'over-available' });
    expect(asked).toBe(0);
  });
  it('never returns a request to any other address, whatever the step-up says', async () => {
    const r = await createTransferRequest({ ...base, to: OTHER }, approvingStepUp, NOW);
    expect(r.ok).toBe(false);
  });
});

describe('saved wallet change', () => {
  it('takes effect 24 hours after the request, and needs the step-up', async () => {
    const r = await requestSavedWalletChange(SAVED, OTHER, approvingStepUp, NOW);
    expect(SAVED_WALLET_DELAY_MS).toBe(86_400_000);
    expect(r).toEqual({ ok: true, change: { next: OTHER, requestedAt: '2026-10-03T14:00:00.000Z', effectiveAt: '2026-10-04T14:00:00.000Z' } });
    expect(await requestSavedWalletChange(SAVED, OTHER, unavailableStepUp, NOW)).toEqual({ ok: false, problem: 'step-up-failed' });
  });
  it('refuses empty, malformed and unchanged addresses', async () => {
    expect(await requestSavedWalletChange(SAVED, '', approvingStepUp, NOW)).toEqual({ ok: false, problem: 'address-missing' });
    expect(await requestSavedWalletChange(SAVED, 'abc', approvingStepUp, NOW)).toEqual({ ok: false, problem: 'address-malformed' });
    expect(await requestSavedWalletChange(SAVED, SAVED, approvingStepUp, NOW)).toEqual({ ok: false, problem: 'same-address' });
  });
});
