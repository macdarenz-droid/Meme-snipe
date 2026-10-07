import { createContext, useContext } from 'react';
import { formatSol, formatUsdExact, lamportsAtPrice, toneOf, toneOfLamports } from '../lib/money.ts';

/** The current SOL price from the worker's status (APP-SOL), for the dollar line under each SOL figure; null unknown. */
export const SolPriceContext = createContext<string | null>(null);

/**
 * A money figure, SOL first (the owner counts results in SOL): the worker's lamports, with dollars only as a small line
 * under it at the current SOL price. From a worker that serves no lamports, the dollar figure is shown as before.
 */
export function Money({ lamports, usd, signed = false }: { lamports: string | null | undefined; usd: string | null; signed?: boolean }) {
  const price = useContext(SolPriceContext);
  if (lamports == null) return <>{usd === null ? '—' : formatUsdExact(usd, signed)}</>;
  return (
    <span className="money">
      <span>{formatSol(lamports, signed)}</span>
      {price !== null && <span className="money-usd">{lamportsAtPrice(lamports, price, signed)}</span>}
    </span>
  );
}

/** The figure as plain text (labels, chart notes): SOL when served, else dollars. */
export const moneyText = (lamports: string | null | undefined, usd: string, signed = false): string => (lamports == null ? formatUsdExact(usd, signed) : formatSol(lamports, signed));

/** The figure's colour: by its SOL sign when served, else by its printed dollars. */
export const moneyTone = (lamports: string | null | undefined, usd: string): 'gain' | 'loss' | '' => (lamports == null ? toneOf(usd) : toneOfLamports(lamports));
