// REPLAY-1000: each trade again under a fill stress, as a second column (card: "the same trade under the backtest's
// fill stresses"). The stress: each leg lands STRESS_SLOTS later than the bot's paper fill did (the conservative
// scenario's landing delay, 6 slots, plus its congestion extra, 20 slots: packages/core/src/config/fills.ts), and
// executes on the chain's own reserves at that slot (accounts.ts, as of that slot) with CORE-2 and the pool's fee
// context decoded by the bot's own `decodeSnapshot`: the entry spends the same SOL, the exit sells the tokens that
// stressed entry got. Network fees are the paper fill's. A leg CORE-2 refuses gets nothing (entry: no trade).
import { pumpPoolAuthority, decodePool, fromBase64, toAddress, PUMP_AMM_GLOBAL_CONFIG } from '../../packages/core/src/chain/index.ts';
import { poolBuyExactQuoteIn, poolSell } from '../../packages/core/src/amm/index.ts';
import { decodeSnapshot, PUMP_AMM_FEE_CONFIG } from '../../packages/worker/src/run/snapshot.ts';
import type { AccountWorld } from './world/accounts.ts';
import type { ChainView } from './world/chain.ts';
import type { Trade } from './analyze.ts';

export const STRESS_SLOTS = 26;

const snapshotAt = async (accounts: AccountWorld, mint: string, pool: string, slot: number) => {
  const p = await accounts.account(pool, slot);
  if (p === null) return null;
  const d = decodePool(fromBase64(p.data[0])).value;
  const addrs = [pool, d.poolBaseTokenAccount, d.poolQuoteTokenAccount, mint, PUMP_AMM_GLOBAL_CONFIG, PUMP_AMM_FEE_CONFIG];
  const accts = await Promise.all(addrs.map((a) => accounts.account(a, slot)));
  const s = decodeSnapshot(mint, pool, BigInt(slot), accts.map((a) => (a === null ? null : { owner: a.owner, data: fromBase64(a.data[0]) })) as never);
  return s.ok ? s.snapshot : null;
};

export interface Stressed {
  readonly trade: string;
  readonly entrySlot: number;
  readonly exitSlot: number | null;
  readonly tokens: bigint;
  readonly solOut: bigint;
  readonly net: bigint;
  readonly note: string | null;
}

export const stressTrade = async (t: Trade, pool: string, accounts: AccountWorld, chain: ChainView): Promise<Stressed> => {
  const entrySlot = chain.clock.slotAt(Date.parse(t.entryAt)) + STRESS_SLOTS;
  const exitSlot = t.exitAt === null ? null : chain.clock.slotAt(Date.parse(t.exitAt)) + STRESS_SLOTS;
  const none = (note: string): Stressed => ({ trade: t.trade, entrySlot, exitSlot, tokens: 0n, solOut: 0n, net: -t.fees, note });
  const a = await snapshotAt(accounts, t.mint, pool, entrySlot);
  if (a === null) return none('no pool state at the stressed entry');
  const buy = poolBuyExactQuoteIn(a.state, t.solIn, a.ctx);
  if (!buy.ok) return none(`stressed entry refused: ${buy.reason}`);
  const tokens = buy.trade.base;
  if (exitSlot === null) return { trade: t.trade, entrySlot, exitSlot, tokens, solOut: 0n, net: -t.solIn - t.fees, note: 'still open' };
  const b = await snapshotAt(accounts, t.mint, pool, exitSlot);
  if (b === null) return { trade: t.trade, entrySlot, exitSlot, tokens, solOut: 0n, net: -t.solIn - t.fees, note: 'no pool state at the stressed exit' };
  const sell = poolSell(b.state, tokens, b.ctx);
  const solOut = sell.ok ? sell.trade.userQuote : 0n;
  void pumpPoolAuthority;
  void toAddress;
  return { trade: t.trade, entrySlot, exitSlot, tokens, solOut, net: solOut - t.solIn - t.fees, note: sell.ok ? null : `stressed exit refused: ${sell.reason}` };
};
