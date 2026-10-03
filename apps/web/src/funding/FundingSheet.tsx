import { useState } from 'react';
import { Sheet } from '../components/Sheet.tsx';
import type { WalletView } from '../screens/types.ts';
import { DepositPanel } from './DepositPanel.tsx';
import { FEES_CHECKED } from './exchanges.ts';
import type { StepUp } from './stepUp.ts';
import { WithdrawPanel } from './WithdrawPanel.tsx';

export type FundingKind = 'deposit' | 'withdraw';

interface Props {
  kind: FundingKind | null;
  onClose: () => void;
  wallet: WalletView;
  /** Passkey check that must pass before a transfer request or a saved-wallet change is created. */
  stepUp: StepUp;
  /** CLAUDE.md "No deposit before proof": no deposit address until the pre-funding gate passes. */
  gatePassed: boolean;
}

export function FundingSheet({ kind, onClose, wallet, stepUp, gatePassed }: Props) {
  const [shownKind, setShownKind] = useState<FundingKind>('deposit');
  if (kind && kind !== shownKind) setShownKind(kind);
  return (
    <Sheet
      open={kind !== null}
      title={shownKind === 'deposit' ? 'Deposit' : 'Withdraw'}
      onClose={onClose}
      footer={<p className="muted small">Fees checked {FEES_CHECKED}</p>}
    >
      {shownKind === 'deposit' ? <DepositPanel wallet={wallet} gatePassed={gatePassed} /> : <WithdrawPanel wallet={wallet} stepUp={stepUp} />}
    </Sheet>
  );
}
