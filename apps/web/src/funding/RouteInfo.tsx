import { useId, useState } from 'react';
import { EXCHANGES, type ExchangeId } from './exchanges.ts';

/** Exchange choice with the steps and costs for one direction. Costs come from exchanges.ts. */
export function RouteInfo({ direction }: { direction: 'deposit' | 'withdraw' }) {
  const [exchange, setExchange] = useState<ExchangeId>('ir');
  const ex = EXCHANGES.find((e) => e.id === exchange) ?? EXCHANGES[0]!;
  const route = direction === 'deposit' ? ex.deposit : ex.withdraw;
  const groupId = useId();
  return (
    <>
      <div className="segmented" role="radiogroup" aria-labelledby={groupId}>
        <span id={groupId} className="field-label">
          Exchange
        </span>
        <div className="segmented-options">
          {EXCHANGES.map((e) => (
            <button key={e.id} type="button" role="radio" aria-checked={e.id === exchange} className="segmented-option" onClick={() => setExchange(e.id)}>
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
    </>
  );
}
