import { fromLamports, parseSol } from './sol.ts';
import { approve, type StepUp } from './stepUp.ts';

/**
 * Withdraw builds a transfer request and nothing else: it never signs and
 * never sends (signing arrives with SIGN-1). The destination is always the
 * owner's saved wallet; the form refuses any other address.
 * Rules: docs/ARCHITECTURE.md §19 (Withdraw screen) and §8 R4 (SOL reserve).
 */

/** Network fee for one plain SOL transfer (5,000 lamports), kept out of the amount that can be sent. */
export const TRANSFER_FEE_LAMPORTS = 5_000n;

/** Waiting time before a new saved wallet takes effect (docs/ARCHITECTURE.md §19, §12). */
export const SAVED_WALLET_DELAY_MS = 24 * 60 * 60 * 1000;

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** True for text shaped like a Solana address: 32 to 44 base58 characters. */
export const isAddress = (s: string): boolean => BASE58.test(s);

export type WithdrawProblem =
  | 'no-saved-wallet'
  | 'address-missing'
  | 'address-malformed'
  | 'address-foreign'
  | 'amount-missing'
  | 'amount-invalid'
  | 'amount-zero'
  | 'balance-unknown'
  | 'over-available'
  | 'step-up-failed';

export const PROBLEM_TEXT: Record<WithdrawProblem, string> = {
  'no-saved-wallet': 'Save your wallet first.',
  'address-missing': 'Enter the address.',
  'address-malformed': 'That is not a valid Solana address.',
  'address-foreign': 'Withdraw sends only to your saved wallet.',
  'amount-missing': 'Enter an amount.',
  'amount-invalid': 'Use digits with up to 9 decimal places.',
  'amount-zero': 'The amount must be more than zero.',
  'balance-unknown': 'The balance is not available yet.',
  'over-available': 'More than you can send.',
  'step-up-failed': 'Passkey check did not pass. No request was created.',
};

export interface WithdrawInput {
  to: string;
  /** SOL as an exact decimal string. */
  amount: string;
  savedWallet: string | null;
  balanceSol: string | null;
  reserveSol: string | null;
}

/** The most that can be sent: balance, minus the protected reserve, minus the transfer fee. Zero when negative. */
export function maxSendable(balanceSol: string | null, reserveSol: string | null): bigint | null {
  const balance = balanceSol === null ? null : parseSol(balanceSol);
  const reserve = reserveSol === null ? null : parseSol(reserveSol);
  if (balance === null || reserve === null) return null;
  const room = balance - reserve - TRANSFER_FEE_LAMPORTS;
  return room > 0n ? room : 0n;
}

export type Checked = { ok: true; lamports: bigint } | { ok: false; field: 'to' | 'amount'; problem: WithdrawProblem };

/** Checks the destination first, then the amount. The destination must equal the saved wallet exactly. */
export function checkWithdraw(input: WithdrawInput): Checked {
  const to = input.to.trim();
  if (input.savedWallet === null) return { ok: false, field: 'to', problem: 'no-saved-wallet' };
  if (to === '') return { ok: false, field: 'to', problem: 'address-missing' };
  if (!isAddress(to)) return { ok: false, field: 'to', problem: 'address-malformed' };
  if (to !== input.savedWallet) return { ok: false, field: 'to', problem: 'address-foreign' };

  const amount = input.amount.trim();
  if (amount === '') return { ok: false, field: 'amount', problem: 'amount-missing' };
  const lamports = parseSol(amount);
  if (lamports === null) return { ok: false, field: 'amount', problem: 'amount-invalid' };
  if (lamports === 0n) return { ok: false, field: 'amount', problem: 'amount-zero' };
  const max = maxSendable(input.balanceSol, input.reserveSol);
  if (max === null) return { ok: false, field: 'amount', problem: 'balance-unknown' };
  if (lamports > max) return { ok: false, field: 'amount', problem: 'over-available' };
  return { ok: true, lamports };
}

/** An unsigned transfer request. Nothing is sent; signing is a later step. */
export interface TransferRequest {
  to: string;
  amountSol: string;
  lamports: string;
  status: 'unsigned';
  createdAt: string;
}

export type RequestResult = { ok: true; request: TransferRequest } | { ok: false; field: 'to' | 'amount' | 'form'; problem: WithdrawProblem };

/** Validates, then asks for the passkey step-up, and only then builds the request. */
export async function createTransferRequest(input: WithdrawInput, stepUp: StepUp, now: Date = new Date()): Promise<RequestResult> {
  const checked = checkWithdraw(input);
  if (!checked.ok) return checked;
  const amountSol = fromLamports(checked.lamports);
  const approved = await approve(stepUp, { action: 'withdraw', summary: `Send ${amountSol} SOL to ${input.to.trim()}` });
  if (!approved) return { ok: false, field: 'form', problem: 'step-up-failed' };
  return {
    ok: true,
    request: { to: input.to.trim(), amountSol, lamports: checked.lamports.toString(), status: 'unsigned', createdAt: now.toISOString() },
  };
}

export type ChangeProblem = 'address-missing' | 'address-malformed' | 'same-address' | 'step-up-failed';

export const CHANGE_PROBLEM_TEXT: Record<ChangeProblem, string> = {
  'address-missing': 'Enter the new address.',
  'address-malformed': 'That is not a valid Solana address.',
  'same-address': 'That is already your saved wallet.',
  'step-up-failed': 'Passkey check did not pass. Nothing was changed.',
};

/** A request to change the saved wallet. It takes effect only after the delay; Withdraw keeps the old address until then. */
export interface SavedWalletChange {
  next: string;
  requestedAt: string;
  effectiveAt: string;
}

export type ChangeResult = { ok: true; change: SavedWalletChange } | { ok: false; problem: ChangeProblem };

export async function requestSavedWalletChange(current: string | null, next: string, stepUp: StepUp, now: Date = new Date()): Promise<ChangeResult> {
  const to = next.trim();
  if (to === '') return { ok: false, problem: 'address-missing' };
  if (!isAddress(to)) return { ok: false, problem: 'address-malformed' };
  if (to === current) return { ok: false, problem: 'same-address' };
  const approved = await approve(stepUp, { action: 'change-saved-wallet', summary: `Change your saved wallet to ${to}` });
  if (!approved) return { ok: false, problem: 'step-up-failed' };
  return { ok: true, change: { next: to, requestedAt: now.toISOString(), effectiveAt: new Date(now.getTime() + SAVED_WALLET_DELAY_MS).toISOString() } };
}
