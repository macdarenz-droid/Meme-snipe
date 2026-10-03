import type { ReactNode } from 'react';
import { Empty } from '../components/ui.tsx';
import { formatDateTime, formatDuration, formatPrice, formatUsd, shortAddress } from '../lib/format.ts';
import type { TradeView } from './types.ts';

const tone = (v: number) => (v > 0 ? 'gain' : v < 0 ? 'loss' : '');

export function TradeHistory({ trades, onSelect }: { trades: TradeView[]; onSelect: (t: TradeView) => void }) {
  if (trades.length === 0) return <Empty title="No trades yet" />;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Token</th>
            <th scope="col" className="num">Net</th>
            <th scope="col" className="num">Size</th>
            <th scope="col" className="num">Fees</th>
            <th scope="col" className="num">Held</th>
            <th scope="col">Closed</th>
            <th scope="col">Exit</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr key={t.id} className="row-link">
              <td>
                <button type="button" className="row-button" onClick={() => onSelect(t)} aria-label={`${t.symbol}, ${formatUsd(t.netUsd, true)}, details`}>
                  <span className="token-symbol">{t.symbol}</span>
                  <span className="mono muted">{shortAddress(t.mint)}</span>
                </button>
              </td>
              <td className={`num ${tone(t.netUsd)}`}>{formatUsd(t.netUsd, true)}</td>
              <td className="num">{formatUsd(t.sizeUsd)}</td>
              <td className="num">{formatUsd(t.feesUsd)}</td>
              <td className="num">{formatDuration(t.holdSeconds)}</td>
              <td className="mono muted">{formatDateTime(t.closedAt)}</td>
              <td className="muted truncate">{t.reasonOut}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SOLSCAN = 'https://solscan.io/tx/';

export function TradeDetail({ trade }: { trade: TradeView }) {
  const rows: [string, ReactNode][] = [
    ['Token', <span><strong>{trade.symbol}</strong> <span className="mono muted">{shortAddress(trade.mint)}</span></span>],
    ['Venue', trade.venue],
    ['Entry', <span className="num">{formatPrice(trade.entryPriceUsd)} · {formatDateTime(trade.openedAt)}</span>],
    ['Exit', <span className="num">{formatPrice(trade.exitPriceUsd)} · {formatDateTime(trade.closedAt)}</span>],
    ['Size', <span className="num">{formatUsd(trade.sizeUsd)}</span>],
    ['Fees', <span className="num">{formatUsd(trade.feesUsd)}</span>],
    ['Net', <span className={`num ${tone(trade.netUsd)}`}>{formatUsd(trade.netUsd, true)}</span>],
    ['Held', <span className="num">{formatDuration(trade.holdSeconds)}</span>],
  ];
  return (
    <div className="detail">
      <dl className="detail-list">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <h3>Reason in</h3>
      <p>{trade.reasonIn}</p>
      <h3>Reason out</h3>
      <p>{trade.reasonOut}</p>
      <h3>Transactions</h3>
      <ul className="tx-list">
        <TxLink label="Entry" tx={trade.entryTx} />
        <TxLink label="Exit" tx={trade.exitTx} />
      </ul>
    </div>
  );
}

function TxLink({ label, tx }: { label: string; tx: string | null }) {
  if (!tx) {
    return (
      <li>
        {label} <span className="muted">Paper trade, no transaction</span>
      </li>
    );
  }
  return (
    <li>
      <a href={`${SOLSCAN}${tx}`} target="_blank" rel="noreferrer">
        {label} <span className="mono">{shortAddress(tx)}</span>
      </a>
    </li>
  );
}
