import { useId, useState, type FormEvent } from 'react';
import { melDateTime } from '../dashboard/time.ts';
import type { WalletView } from '../screens/types.ts';
import { RouteInfo } from './RouteInfo.tsx';
import { formatAud, formatLamports, fromLamports, parseSol } from './sol.ts';
import { whileBusy, type StepUp } from './stepUp.ts';
import {
  CHANGE_PROBLEM_TEXT,
  PROBLEM_TEXT,
  checkWithdraw,
  createTransferRequest,
  maxSendable,
  requestSavedWalletChange,
  type ChangeProblem,
  type SavedWalletChange,
  type TransferRequest,
  type WithdrawProblem,
} from './withdraw.ts';

interface FormError {
  field: 'to' | 'amount' | 'form';
  text: string;
}

export function WithdrawPanel({ wallet, stepUp }: { wallet: WalletView; stepUp: StepUp }) {
  const ids = { to: useId(), amount: useId(), toErr: useId(), amountErr: useId(), next: useId(), nextErr: useId() };
  const [to, setTo] = useState(wallet.savedWallet ?? '');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<FormError | null>(null);
  const [busy, setBusy] = useState(false);
  const [request, setRequest] = useState<TransferRequest | null>(null);
  const [changing, setChanging] = useState(false);
  const [next, setNext] = useState('');
  const [changeError, setChangeError] = useState<string | null>(null);
  const [pending, setPending] = useState<SavedWalletChange | null>(null);

  const max = maxSendable(wallet.balanceSol, wallet.reserveSol);
  const typed = parseSol(amount.trim());
  const input = { to, amount, savedWallet: wallet.savedWallet, balanceSol: wallet.balanceSol, reserveSol: wallet.reserveSol };

  const fail = (field: FormError['field'], problem: WithdrawProblem) => setError({ field, text: PROBLEM_TEXT[problem] });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setRequest(null);
    const checked = checkWithdraw(input);
    if (!checked.ok) return fail(checked.field, checked.problem);
    setError(null);
    const result = await whileBusy(setBusy, () => createTransferRequest(input, stepUp));
    if (result.ok) setRequest(result.request);
    else fail(result.field, result.problem);
  };

  const submitChange = async (e: FormEvent) => {
    e.preventDefault();
    const result = await whileBusy(setBusy, () => requestSavedWalletChange(wallet.savedWallet, next, stepUp));
    if (result.ok) {
      setPending(result.change);
      setChangeError(null);
      setChanging(false);
      setNext('');
    } else setChangeError(CHANGE_PROBLEM_TEXT[result.problem as ChangeProblem]);
  };

  return (
    <>
      <form className="withdraw-form" onSubmit={submit} noValidate>
        <div className="field-block">
          <label className="field-label" htmlFor={ids.to}>
            Send to
          </label>
          <input
            id={ids.to}
            className="input mono"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-invalid={error?.field === 'to'}
            aria-describedby={error?.field === 'to' ? ids.toErr : undefined}
          />
          {error?.field === 'to' && (
            <p id={ids.toErr} className="field-error" role="alert">
              {error.text}
            </p>
          )}
        </div>

        <div className="field-block">
          <span className="field-label">Available to send</span>
          <span className="num">{max === null ? '—' : formatLamports(max)}</span>
        </div>

        <div className="field-block">
          <label className="field-label" htmlFor={ids.amount}>
            Amount (SOL)
          </label>
          <div className="input-row">
            <input
              id={ids.amount}
              className="input num"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoComplete="off"
              aria-invalid={error?.field === 'amount'}
              aria-describedby={error?.field === 'amount' ? ids.amountErr : undefined}
            />
            <button type="button" className="button" aria-label="Use all available" disabled={max === null || max === 0n} onClick={() => max !== null && setAmount(fromLamports(max))}>
              All
            </button>
          </div>
          {typed !== null && typed > 0n && formatAud(typed, wallet.solAud) && <span className="small muted num">≈ {formatAud(typed, wallet.solAud)}</span>}
          {error?.field === 'amount' && (
            <p id={ids.amountErr} className="field-error" role="alert">
              {error.text}
            </p>
          )}
        </div>

        {error?.field === 'form' && (
          <p className="field-error" role="alert">
            {error.text}
          </p>
        )}
        <button type="submit" className="button button-primary" disabled={busy}>
          Request transfer
        </button>
      </form>

      {request && (
        <div className="callout" role="status">
          <strong>Transfer request created</strong>
          <span className="num">
            {formatLamports(BigInt(request.lamports))} to {request.to}
          </span>
          <span className="small muted">Not signed and not sent.</span>
        </div>
      )}

      <h3>Saved wallet</h3>
      <div className="field-block">
        <span className="field-label">Current</span>
        <span className={wallet.savedWallet ? 'address' : 'muted'}>{wallet.savedWallet ?? 'Not set'}</span>
      </div>
      {pending && (
        <p className="callout" role="status">
          Change requested to <span className="address">{pending.next}</span>. It takes effect {melDateTime(pending.effectiveAt)} Melbourne time.
        </p>
      )}
      {changing ? (
        <form className="withdraw-form" onSubmit={submitChange} noValidate>
          <div className="field-block">
            <label className="field-label" htmlFor={ids.next}>
              New address
            </label>
            <input
              id={ids.next}
              className="input mono"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-invalid={changeError !== null}
              aria-describedby={changeError ? ids.nextErr : undefined}
            />
            <span className="small muted">A new address takes effect 24 hours after you confirm with your passkey.</span>
            {changeError && (
              <p id={ids.nextErr} className="field-error" role="alert">
                {changeError}
              </p>
            )}
          </div>
          <div className="actions">
            <button type="submit" className="button button-primary" disabled={busy}>
              Request change
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                setChanging(false);
                setChangeError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="text-link text-button" onClick={() => setChanging(true)}>
          Change saved wallet
        </button>
      )}

      <RouteInfo direction="withdraw" />
    </>
  );
}
