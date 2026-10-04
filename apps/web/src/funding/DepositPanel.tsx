import { useState, type MouseEvent } from 'react';
import { useSample } from '../components/Sample.tsx';
import type { WalletView } from '../screens/types.ts';
import { QrCode } from './QrCode.tsx';
import { RouteInfo } from './RouteInfo.tsx';
import { formatAud, formatLamports, parseSol } from './sol.ts';
import { isAddress } from './withdraw.ts';

/** No deposit before proof (CLAUDE.md): the address and QR show only once the pre-funding gate has passed. */
export function DepositPanel({ wallet, gatePassed }: { wallet: WalletView; gatePassed: boolean }) {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  // One value feeds the text, the QR code and the copy button.
  const address = gatePassed ? wallet.botAddress : null;
  // A QR code only for a real-shaped address outside sample data: a sample must never be scannable (SAMPLE-QR).
  const sample = useSample();
  const scannable = address !== null && isAddress(address) && !sample;
  const balance = wallet.balanceSol === null ? null : parseSol(wallet.balanceSol);

  const copy = async (e: MouseEvent<HTMLButtonElement>) => {
    const value = e.currentTarget.dataset['copy'];
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied('done');
    } catch {
      setCopied('failed');
    }
  };

  return (
    <>
      <div className="field-block">
        <span className="field-label">Balance</span>
        <span className="num">
          {balance === null ? '—' : formatLamports(balance)}
          {balance !== null && formatAud(balance, wallet.solAud) && <span className="muted"> · {formatAud(balance, wallet.solAud)}</span>}
        </span>
      </div>

      {address ? (
        <>
          <p className="callout" role="note">
            Send only SOL on the Solana network to this address. Tokens or other networks sent here can be lost.
          </p>
          <div className="field-block">
            <span className="field-label">Bot wallet</span>
            <span className="address" data-testid="bot-address">
              {address}
            </span>
          </div>
          {scannable && <QrCode text={address} label="QR code of the bot wallet address" />}
          <div className="actions">
            <button type="button" className="button" data-copy={address} onClick={copy}>
              Copy address
            </button>
            <span className="small muted" role="status">
              {copied === 'done' ? 'Copied' : copied === 'failed' ? 'Could not copy. Select the address instead.' : ''}
            </span>
          </div>
        </>
      ) : (
        <>
          <div className="field-block">
            <span className="field-label">Pre-funding gate</span>
            <span className="muted">Not passed</span>
          </div>
          <div className="field-block">
            <span className="field-label">Bot wallet</span>
            <span className="muted">Shown after the gate passes</span>
          </div>
        </>
      )}

      <RouteInfo direction="deposit" />
    </>
  );
}
