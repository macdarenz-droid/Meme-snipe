// Which facts the backtest can produce from recorded data, and which only live reads can (docs/ARCHITECTURE.md §16.3).
// Every fact is made by the same producer code from released events. The difference is the input: a `historical`
// fact's input exists in DATA-1's dataset (or a stored series), a `live-only` one's does not. Live-only inputs are
// vetoes: they may only remove a trade (the gates skip them in backtest mode), and the worker logs their rate so
// BT-2 can write the bias note.
import { CURVE_VOLUME_KEY, EXEC_HEALTH_KEY, GRADUATES_KEY, SOL_USD_KEY } from '../gates/facts.ts';

export type FactSource = 'historical' | 'live-read' | 'live-only-veto';

export interface FactKind {
  /** Key prefix in the as-of store (gates/facts.ts). */
  readonly key: string;
  readonly gates: readonly string[];
  readonly source: FactSource;
  /** What the producer reads. */
  readonly from: string;
}

export const FACT_KINDS: readonly FactKind[] = [
  { key: 'gates/create:', gates: ['H9', 'H12', 'H13', 'H14'], source: 'historical', from: 'CreateEvent of a fetched transaction' },
  { key: 'gates/migration:', gates: ['H7', 'H8', 'H9', 'H10', 'H11'], source: 'historical', from: 'CompleteEvent, CompletePumpAmmMigrationEvent and its CreatePoolEvent' },
  { key: 'gates/curve:', gates: ['H7'], source: 'historical', from: 'CompleteEvent (only "complete" is ever proven)' },
  { key: 'gates/candles:', gates: ['H11'], source: 'historical', from: 'every PumpSwap swap of the pool since it opened, under trades:<pool> coverage' },
  { key: 'gates/stream:', gates: ['H11', 'H13'], source: 'historical', from: 'coverage:<stream>:* facts and chain:slot notices' },
  { key: 'gates/insiders:', gates: ['H13'], source: 'historical', from: 'buys in slots s0..s0+2 and the first 20 buyers under mint-txs:<mint> coverage, plus read:funder:* (first funding transfer, core chain/system.ts)' },
  { key: 'gates/soft:', gates: [], source: 'historical', from: 'the same buys (creation-slot buyers, same-transaction dev buy)' },
  { key: GRADUATES_KEY, gates: ['regime'], source: 'historical', from: 'migrations and the pool reserve at +30 min (covered trades, or a read:accounts within a minute of the mark)' },
  { key: SOL_USD_KEY, gates: ['H8', 'regime'], source: 'historical', from: 'hourly SOL/USD bars (sol-usd events, BT-1 series shape)' },
  { key: CURVE_VOLUME_KEY, gates: ['regime'], source: 'historical', from: 'read:chain-volume-hour rows (pump curve + canonical PumpSwap, lamports), complete UTC days only; backtest: DATA-1 hourly census; live: no free source, so unknown and the regime stays off' },
  { key: 'gates/mint:', gates: ['H1', 'H2', 'H3', 'H4', 'H12', 'H16'], source: 'live-read', from: 'read:accounts:<mint> at confirmed; the backtest needs DATA-1 mint state released in the same shape' },
  { key: 'gates/pool:', gates: ['H5', 'H6', 'H8', 'H12'], source: 'live-read', from: 'read:accounts:<mint> (pool and both vaults); the backtest needs pool state and vault balances released in the same shape' },
  { key: 'gates/lp:', gates: ['H6'], source: 'live-read', from: 'read:accounts:<mint> (the LP mint)' },
  { key: 'gates/holders:', gates: ['H12', 'H13'], source: 'live-read', from: 'read:holders-all:<mint> (one getProgramAccounts: complete, coverage all) or read:holders:<mint> (largest: bounded); the backtest rebuild from token balances is BT-2\'s' },
  { key: 'gates/sim:', gates: ['H15'], source: 'live-only-veto', from: 'read:sim:<mint> (simulateTransaction of a buy then a sell)' },
  { key: 'gates/xcheck:', gates: ['H16'], source: 'live-only-veto', from: 'read:rugcheck, read:goplus, read:jupiter-audit (reads under 2 s old)' },
  { key: EXEC_HEALTH_KEY, gates: ['regime'], source: 'live-only-veto', from: 'read:exec-health (the bot\'s own attempts); never green without owner-set limits' },
];
