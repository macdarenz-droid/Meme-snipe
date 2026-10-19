// Parity: the bot's own PumpSwap quote code on a grid of pool states; parity_test.py compares costs.py to this output.
import fs from 'node:fs';
import { poolBuyExactQuoteIn, poolSell } from '../../packages/core/src/amm/pump-swap.ts';
const fc = JSON.parse(fs.readFileSync(new URL('../edge/snapshot/fee-configs.json', import.meta.url), 'utf8')).amm;
const split = (f: any) => ({ lp: Number(f.lp_fee_bps), protocol: Number(f.protocol_fee_bps), creator: Number(f.creator_fee_bps) });
const feeConfig = { flatFees: split(fc.flat_fees), exoticFlatFees: split(fc.exotic_flat_fees),
  feeTiers: fc.fee_tiers.map((t: any) => ({ marketCapThreshold: BigInt(t.market_cap_lamports_threshold), fees: split(t.fees) })) };
const ctx: any = { feeConfig, canonical: true, quote: 'sol', baseSupply: 10n ** 15n, creatorFeeCharged: true,
  coin: { mayhemMode: false, transferFee: false, transferHook: false }, instruction: 'v1', buybackFeeBps: 5000 };
const cases = JSON.parse(fs.readFileSync(process.argv[2]!, 'utf8'));
const out = cases.map((c: any) => {
  const pool = { quoteVault: BigInt(c.vault), virtualQuoteReserves: BigInt(c.virt), baseReserve: BigInt(c.base) };
  const b = poolBuyExactQuoteIn(pool, BigInt(c.spend), ctx);
  const s = poolSell(pool, BigInt(c.sellBase), ctx);
  const t = (q: any, f: string) => q.ok ? [String(q.trade[f]), String(q.trade.lpFee + q.trade.protocolFee + q.trade.creatorFee), String(q.trade.impact)] : null;
  return { buy: t(b, 'base'), sell: t(s, 'userQuote') };
});
console.log(JSON.stringify(out));
