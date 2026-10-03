import { useId, useState } from 'react';
import { Sheet } from '../components/Sheet.tsx';
import { EXCHANGES, FEES_CHECKED, type ExchangeId } from './exchanges.ts';

export type FundingKind = 'deposit' | 'withdraw';

interface Props {
  kind: FundingKind | null;
  onClose: () => void;
  /** The owner's saved wallet; Withdraw sends nowhere else. Null until set. */
  savedWallet: string | null;
  botWallet: string | null;
  /** CLAUDE.md "No deposit before proof": no deposit address until the pre-funding gate passes. */
  gatePassed: boolean;
}

export function FundingSheet({ kind, onClose, savedWallet, botWallet, gatePassed }: Props) {
  const [exchange, setExchange] = useState<ExchangeId>('ir');
  const [shownKind, setShownKind] = useState<FundingKind>('deposit');
  if (kind && kind !== shownKind) setShownKind(kind);
  const ex = EXCHANGES.find((e) => e.id === exchange) ?? EXCHANGES[0]!;
  const route = shownKind === 'deposit' ? ex.deposit : ex.withdraw;
  const groupId = useId();
  const amountId = useId();

  return (
    <Sheet
      open={kind !== null}
      title={shownKind === 'deposit' ? 'Deposit' : 'Withdraw'}
      onClose={onClose}
      footer={<p className="muted small">Fees checked {FEES_CHECKED}</p>}
    >
      {shownKind === 'deposit' ? (
        <>
          <div className="field-block">
            <span className="field-label">Pre-funding gate</span>
            <span className={gatePassed ? '' : 'muted'}>{gatePassed ? 'Passed' : 'Not passed'}</span>
          </div>
          <div className="field-block">
            <span className="field-label">Bot wallet</span>
            <span className={botWallet && gatePassed ? 'address' : 'muted'}>{gatePassed ? (botWallet ?? 'Not created') : 'Shown after the gate passes'}</span>
          </div>
        </>
      ) : (
        <div className="withdraw-form">
          <div className="field-block">
            <span className="field-label">Sends to</span>
            <span className={savedWallet ? 'address' : 'muted'}>{savedWallet ?? 'No saved wallet'}</span>
          </div>
          <label className="field-block" htmlFor={amountId}>
            <span className="field-label">Amount (SOL)</span>
            <input id={amountId} className="input num" inputMode="decimal" placeholder="0.00" disabled />
          </label>
          <button type="button" className="button button-primary" disabled>
            Send to saved wallet
          </button>
        </div>
      )}

      <div className="segmented" role="radiogroup" aria-labelledby={groupId}>
        <span id={groupId} className="field-label">
          Exchange
        </span>
        <div className="segmented-options">
          {EXCHANGES.map((e) => (
            <button
              key={e.id}
              type="button"
              role="radio"
              aria-checked={e.id === exchange}
              className="segmented-option"
              onClick={() => setExchange(e.id)}
            >
              {e.name}
            </button>
          ))}
        </div>
      </div>

      <h3>Steps</h3>
      <ol className="steps">
        {route.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>

      <h3>Costs</h3>
      <dl className="cost-list">
        {route.costs.map((c) => (
          <div key={c.label}>
            <dt>{c.label}</dt>
            <dd className="num">{c.value}</dd>
          </div>
        ))}
      </dl>
      <dl className="cost-list cost-totals">
        {route.totals.map((c) => (
          <div key={c.label}>
            <dt>{c.label}</dt>
            <dd className="num">{c.value}</dd>
          </div>
        ))}
      </dl>
      <a className="text-link" href={ex.url} target="_blank" rel="noreferrer">
        Open {ex.name}
      </a>
    </Sheet>
  );
}
