import { useCallback, useState } from 'react';
import { Empty, Section } from '../components/ui.tsx';
import { FundingSheet, type FundingKind } from '../funding/FundingSheet.tsx';
import { formatSolExact } from '../funding/sol.ts';
import { unavailableStepUp, type StepUp } from '../funding/stepUp.ts';
import { formatUsd, shortAddress } from '../lib/format.ts';
import { EMPTY_WALLET, type WalletView } from './types.ts';

export function WalletSummary({ wallet, onFund }: { wallet: WalletView; onFund?: (k: FundingKind) => void }) {
  const rows: [string, string | null, boolean][] = [
    ['Address', wallet.botAddress && shortAddress(wallet.botAddress), true],
    ['Saved wallet', wallet.savedWallet && shortAddress(wallet.savedWallet), true],
    ['Available to trade', wallet.availableUsd === null ? null : formatUsd(wallet.availableUsd), false],
    ['Balance', wallet.balanceSol === null ? null : formatSolExact(wallet.balanceSol), false],
    ['Protected SOL reserve', wallet.reserveSol === null ? null : formatSolExact(wallet.reserveSol), false],
    ['Locked deposits', wallet.lockedSol === null ? null : formatSolExact(wallet.lockedSol), false],
    ['Open exposure', wallet.openExposureUsd === null ? null : formatUsd(wallet.openExposureUsd), false],
    ['Fees paid', wallet.feesPaidUsd === null ? null : formatUsd(wallet.feesPaidUsd), false],
  ];
  const missing: Record<string, string> = { Address: 'Not created', 'Saved wallet': 'Not set' };
  return (
    <Section title="Bot wallet" className="span-2">
      <dl className="kv kv-wide">
        {rows.map(([k, v, mono]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className={v === null ? 'num muted' : mono ? 'mono' : 'num'}>{v ?? missing[k] ?? '—'}</dd>
          </div>
        ))}
      </dl>
      {onFund && (
        <div className="actions">
          <button type="button" className="button button-primary" onClick={() => onFund('deposit')}>
            Deposit
          </button>
          <button type="button" className="button" onClick={() => onFund('withdraw')}>
            Withdraw
          </button>
        </div>
      )}
    </Section>
  );
}

export function Wallet({ wallet = EMPTY_WALLET, stepUp = unavailableStepUp }: { wallet?: WalletView; stepUp?: StepUp }) {
  const [funding, setFunding] = useState<FundingKind | null>(null);
  const close = useCallback(() => setFunding(null), []);
  return (
    <div className="screen-grid">
      <WalletSummary wallet={wallet} onFund={setFunding} />
      <Section title="History" className="span-2">
        <Empty title="No transactions" />
      </Section>
      <FundingSheet kind={funding} onClose={close} wallet={wallet} stepUp={stepUp} gatePassed={false} />
    </div>
  );
}
