"""Integer port of the bot's PumpSwap quote code (packages/core/src/amm/pump-swap.ts poolBuyExactQuoteIn, poolSell,
poolFees; amm/fees.ts selectFeeTier, feeOf, marketCap). Canonical SOL pool, creator fee charged, v1 instruction (the
price is the same on v2). parity_test.py checks it equal to the TypeScript on a grid of states."""
import json, math, os
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
_fc = json.load(open(os.path.join(REPO, 'research', 'edge', 'snapshot', 'fee-configs.json')))['amm']['fee_tiers']
TIERS = [(int(x['market_cap_lamports_threshold']), int(x['fees']['lp_fee_bps']), int(x['fees']['protocol_fee_bps']),
          int(x['fees']['creator_fee_bps'])) for x in _fc]
SUPPLY = 10 ** 15            # 1B tokens x 1e6 (pump coins: 6 decimals, fixed supply)
VIRTUAL = 17_600_000_000     # BOOST virtual quote on a standard migration (edge-costs.ts 'young' pool)

def ceil_bps(a, bps): return -((-a * bps) // 10_000)

def fees_for(quote_eff, base):
    mcap = quote_eff * SUPPLY // base
    t = TIERS[0]
    for x in reversed(TIERS):
        if mcap >= x[0]: t = x; break
    return t[1], t[2], t[3]

def buy(vault, virt, base_res, spend):
    """poolBuyExactQuoteIn: -> (base_out, fee_lamports, impact_lamports) or None (no quote)."""
    eff = vault + virt
    if base_res <= 0 or vault <= 0 or eff <= 0: return None
    lp, pr, cr = fees_for(eff, base_res)
    untrimmed = spend * 10_000 // (10_000 + lp + pr + cr)
    fl, fp, fc = ceil_bps(untrimmed, lp), ceil_bps(untrimmed, pr), ceil_bps(untrimmed, cr)
    over = untrimmed + fl + fp + fc - spend
    quote = untrimmed - over if over > 0 else untrimmed
    inp = quote - 1
    base = base_res * inp // (eff + inp)
    if base <= 0: return None
    impact = quote - base * eff // base_res
    return base, fl + fp + fc, impact

def sell(vault, virt, base_res, base):
    """poolSell: -> (user_quote, fee_lamports, impact_lamports) or None."""
    eff = vault + virt
    if base <= 0 or base_res <= 0 or vault <= 0 or eff <= 0: return None
    lp, pr, cr = fees_for(eff, base_res)
    quote = eff * base // (base_res + base)
    fl, fp, fc = ceil_bps(quote, lp), ceil_bps(quote, pr), ceil_bps(quote, cr)
    if vault < quote - fl: return None
    user = quote - fl - fp - fc
    if user <= 0: return None
    return user, fl + fp + fc, base * eff // base_res - quote

class Pool:
    """Reserves at a candle price p (SOL per token) from the migration constant product on effective reserves."""
    def __init__(self, tok, sol):
        self.virt = VIRTUAL if sol > 50 else 0
        self.k_eff = (sol * 1e9 + self.virt) * (tok * 1e6)   # lamports x base units
    def state(self, p):
        pl = p * 1e9 / 1e6                                    # lamports per base unit
        eff = math.sqrt(self.k_eff * pl); base = math.sqrt(self.k_eff / pl)
        return int(eff) - self.virt, self.virt, int(base)
    def buy(self, p, spend_lamports):
        v, vi, b = self.state(p); return buy(v, vi, b, int(spend_lamports))
    def sell(self, p, base):
        v, vi, b = self.state(p); return sell(v, vi, b, int(base))
    def eff_quote_sol(self, p):
        return math.sqrt(self.k_eff * p * 1e9 / 1e6) / 1e9
