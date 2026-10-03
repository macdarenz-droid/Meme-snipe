import { useCallback, useState } from 'react';
import { Empty, Section } from '../components/ui.tsx';
import { FundingSheet, type FundingKind } from '../funding/FundingSheet.tsx';

const BALANCES: [string, string][] = [
  ['Available to trade', '—'],
  ['Protected SOL reserve', '—'],
  ['Locked deposits', '—'],
  ['Open exposure', '—'],
  ['Fees paid', '—'],
];

export function Wallet() {
  const [funding, setFunding] = useState<FundingKind | null>(null);
  const close = useCallback(() => setFunding(null), []);
  return (
    <div className="screen-grid">
      <Section title="Bot wallet" className="span-2">
        <dl className="kv kv-wide">
          <div>
            <dt>Address</dt>
            <dd className="muted">Not created</dd>
          </div>
          <div>
            <dt>Saved wallet</dt>
            <dd className="muted">Not set</dd>
          </div>
          {BALANCES.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd className="num muted">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="actions">
          <button type="button" className="button button-primary" onClick={() => setFunding('deposit')}>
            Deposit
          </button>
          <button type="button" className="button" onClick={() => setFunding('withdraw')}>
            Withdraw
          </button>
        </div>
      </Section>
      <Section title="History" className="span-2">
        <Empty title="No transactions" />
      </Section>
      <FundingSheet kind={funding} onClose={close} savedWallet={null} botWallet={null} gatePassed={false} />
    </div>
  );
}
