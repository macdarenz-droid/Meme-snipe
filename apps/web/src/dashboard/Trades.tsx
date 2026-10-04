import { useState, type ReactNode } from 'react';
import type { Fill, TradeRecord } from '../api/contract.ts';
import { TokenActions } from '../components/TokenActions.tsx';
import { Money, moneyText, moneyTone } from '../components/Money.tsx';
import { Empty } from '../components/ui.tsx';
import { formatDuration, shortAddress } from '../lib/format.ts';
import { formatPriceDec, formatR, formatReturn, formatUsdExact, negUsd, returnHundredths, returnLamports, toneOfReturn } from '../lib/money.ts';
import { EXIT_LABEL, TRADE_REASON_LABEL, VENUE_LABEL } from './labels.ts';
import { Checks } from './Sections.tsx';
import { melDateTime, melTime } from './time.ts';

const PAGE = 25;
const SOLSCAN = 'https://solscan.io/tx/';

/** The fields the table shows; full trade records and backtest report trades both have them. */
export type TradeRow = Pick<TradeRecord, 'id' | 'symbol' | 'mint' | 'netUsd' | 'realizedR' | 'sizeUsd' | 'holdSeconds' | 'closedAt' | 'exitReason'> & Partial<Pick<TradeRecord, 'netLamports' | 'sizeLamports'>> & { costs: { totalUsd: string; totalLamports?: string } };

/** A trade's return: on SOL when served (APP-SOL: net lamports ÷ entry lamports), else net ÷ size in dollars. */
export const tradeReturn = (t: TradeRow): bigint | null =>
  t.netLamports != null && t.sizeLamports != null ? returnLamports(t.netLamports, t.sizeLamports) : returnHundredths(t.netUsd, t.sizeUsd);

export function TradeTable<T extends TradeRow>({ trades, onSelect }: { trades: T[]; onSelect?: (t: T) => void }) {
  const [shown, setShown] = useState(PAGE);
  if (trades.length === 0) return <Empty title="No trades" />;
  return (
    <>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Token</th>
              <th scope="col" className="num">Net</th>
              <th scope="col" className="num">Return</th>
              <th scope="col" className="num">R</th>
              <th scope="col" className="num">Size</th>
              <th scope="col" className="num">Costs</th>
              <th scope="col" className="num">Held</th>
              <th scope="col">Closed</th>
              <th scope="col">Exit</th>
            </tr>
          </thead>
          <tbody>
            {trades.slice(0, shown).map((t) => (
              <tr key={t.id} className="row-link">
                <td>
                  {onSelect ? (
                    <button type="button" className="row-button" onClick={() => onSelect(t)} aria-label={`${t.symbol}, ${moneyText(t.netLamports, t.netUsd, true)}, details`}>
                      <span className="token-symbol">{t.symbol}</span>
                      <span className="mono muted">{shortAddress(t.mint)}</span>
                    </button>
                  ) : (
                    <span className="token-cell">
                      <span className="token-symbol">{t.symbol}</span>
                      <span className="mono muted">{shortAddress(t.mint)}</span>
                    </span>
                  )}
                  <TokenActions mint={t.mint} />
                </td>
                <td className={`num ${moneyTone(t.netLamports, t.netUsd)}`}><Money lamports={t.netLamports} usd={t.netUsd} signed /></td>
                <td className={`num ${toneOfReturn(tradeReturn(t))}`}>{formatReturn(tradeReturn(t))}</td>
                <td className="num">{t.realizedR ? formatR(t.realizedR) : '—'}</td>
                <td className="num"><Money lamports={t.sizeLamports} usd={t.sizeUsd} /></td>
                <td className="num"><Money lamports={t.costs.totalLamports} usd={t.costs.totalUsd} /></td>
                <td className="num">{formatDuration(t.holdSeconds)}</td>
                <td className="mono muted">{melDateTime(t.closedAt)}</td>
                <td className="muted truncate">{EXIT_LABEL[t.exitReason]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="dash-more">
        <span className="muted small num">
          {Math.min(shown, trades.length)} of {trades.length}
        </span>
        {shown < trades.length && (
          <button type="button" className="button" onClick={() => setShown((n) => n + PAGE)}>
            Show more
          </button>
        )}
      </div>
    </>
  );
}

function Rows({ rows }: { rows: [string, ReactNode, string?][] }) {
  return (
    <dl className="detail-list">
      {rows.map(([k, v, cls]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd className={cls}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function FillRow({ f }: { f: Fill }) {
  return (
    <tr>
      <td>{f.side === 'buy' ? 'Buy' : 'Sell'}</td>
      <td className="mono">{melTime(f.at)}</td>
      <td className="num">{formatPriceDec(f.priceUsd)}</td>
      <td className="num"><Money lamports={f.quotedLamports} usd={f.quotedUsd} /></td>
      <td className="num"><Money lamports={f.filledLamports} usd={f.filledUsd} /></td>
      <td className="num">{f.slippageBps} bps</td>
      <td className="num">{f.attempts}</td>
      <td className="mono">
        {f.signature ? (
          <a href={`${SOLSCAN}${f.signature}`} target="_blank" rel="noreferrer">
            {shortAddress(f.signature)}
          </a>
        ) : f.slot !== null ? (
          <span className="muted">slot {f.slot.toLocaleString('en-US')}</span>
        ) : (
          <span className="muted">Paper</span>
        )}
      </td>
    </tr>
  );
}

/** A trade's reasons in words, each once; a code this app does not know is left out (APP-WORDS a). */
export function tradeReasons(t: TradeRecord): string[] {
  return [...new Set(t.reasons.flatMap((r) => (Object.hasOwn(TRADE_REASON_LABEL, r) ? [TRADE_REASON_LABEL[r]!] : [])))];
}

/** Every detail of one trade: entry and exit, fills, fees split, rent, slippage, reasons and signatures. */
export function TradeDetail({ trade }: { trade: TradeRecord }) {
  const c = trade.costs;
  const cost = (usd: string, lam: string | undefined) => <Money lamports={lam} usd={usd} />;
  const neg = (l: string) => (l.startsWith('-') ? l.slice(1) : l === '0' ? l : `-${l}`);
  return (
    <div className="detail">
      <Rows
        rows={[
          ['Token', <><strong>{trade.symbol}</strong> <span className="mono muted">{shortAddress(trade.mint)}</span> <TokenActions mint={trade.mint} /></>],
          ['Venue', `${VENUE_LABEL[trade.venue]} · ${trade.universe}`],
          ['Strategy', <span className="mono">{trade.strategyVersion}</span>],
          ['Policy', <span className="mono">{trade.policyVersion}</span>],
          ['Entry', `${formatPriceDec(trade.entryPriceUsd)} · ${melDateTime(trade.openedAt)}`, 'num'],
          ['Exit', `${formatPriceDec(trade.exitPriceUsd)} · ${melDateTime(trade.closedAt)}`, 'num'],
          ['Held', formatDuration(trade.holdSeconds), 'num'],
          ['Exit reason', EXIT_LABEL[trade.exitReason]],
          ['Size', <Money lamports={trade.sizeLamports} usd={trade.sizeUsd} />, 'num'],
          ['Gross', <Money lamports={trade.grossLamports} usd={trade.grossUsd} signed />, `num ${moneyTone(trade.grossLamports, trade.grossUsd)}`],
          ['Costs', <Money lamports={c.totalLamports == null ? null : neg(c.totalLamports)} usd={negUsd(c.totalUsd)} />, 'num'],
          ['Net', <Money lamports={trade.netLamports} usd={trade.netUsd} signed />, `num ${moneyTone(trade.netLamports, trade.netUsd)}`],
          ['Return', formatReturn(tradeReturn(trade)), `num ${toneOfReturn(tradeReturn(trade))}`],
          ['Planned R', trade.plannedR ? formatR(trade.plannedR) : '—', 'num'],
          ['Realized R', trade.realizedR ? formatR(trade.realizedR) : '—', 'num'],
          ['Best while open', trade.mfeR ? formatR(trade.mfeR) : '—', 'num'],
          ['Worst while open', trade.maeR ? formatR(trade.maeR) : '—', 'num'],
        ]}
      />
      <h3>Costs</h3>
      <Rows
        rows={[
          ['Venue fees', cost(c.venueFeeUsd, c.venueFeeLamports), 'num'],
          ['Creator fees', cost(c.creatorFeeUsd, c.creatorFeeLamports), 'num'],
          ['Priority fees', cost(c.priorityFeeUsd, c.priorityFeeLamports), 'num'],
          ['Tips', cost(c.tipUsd, c.tipLamports), 'num'],
          ['Network fees', cost(c.networkFeeUsd, c.networkFeeLamports), 'num'],
          ['Slippage', cost(c.slippageUsd, c.slippageLamports), 'num'],
          ['Rent paid', cost(c.rentPaidUsd, c.rentPaidLamports), 'num'],
          ['Rent returned', cost(negUsd(c.rentReturnedUsd), c.rentReturnedLamports == null ? undefined : neg(c.rentReturnedLamports)), 'num'],
          ['Total', cost(c.totalUsd, c.totalLamports), 'num dash-total'],
        ]}
      />
      <h3>Fills</h3>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Side</th>
              <th scope="col">Time</th>
              <th scope="col" className="num">Price</th>
              <th scope="col" className="num">Quoted</th>
              <th scope="col" className="num">Filled</th>
              <th scope="col" className="num">Slippage</th>
              <th scope="col" className="num">Tries</th>
              <th scope="col">Signature</th>
            </tr>
          </thead>
          <tbody>
            {trade.fills.map((f) => (
              <FillRow key={`${f.side}-${f.at}`} f={f} />
            ))}
          </tbody>
        </table>
      </div>
      {tradeReasons(trade).length > 0 && (
        <>
          <h3>Reasons</h3>
          <ul className="dash-reasons">
            {tradeReasons(trade).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </>
      )}
      <h3>Checks at entry</h3>
      <div className="table-wrap">
        <Checks checks={trade.checks} />
      </div>
    </div>
  );
}
