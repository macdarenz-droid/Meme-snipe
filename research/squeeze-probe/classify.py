"""Mark every Hyperliquid meta.json name as Solana meme yes/no, with its source (PREREG "Universe").

  python3 -I classify.py <data_dir> <out.json>

Inputs (downloaded 2026-10-07, keyless): hl/meta.json; CoinGecko /coins/markets top 1000 (cg/all_1..4.json),
the solana-meme-coins category top 500 (cg/solmeme_1..2.json) and /coins/list?include_platform=true.
Rule: the HL name's symbol (a leading 'k' of a 1000x contract stripped) is matched to the largest-market-cap
CoinGecko coin with that symbol among the top 1000 and the category list. Yes if that coin is in the
solana-meme-coins category. If the symbol is in neither list, every CoinGecko coin with that symbol and a
Solana platform is listed for a by-hand ruling (recorded in MANUAL with its reason).
"""
import json, os, sys

D, OUT = sys.argv[1], sys.argv[2]
# By-hand rulings for names the lists cannot settle; each cites its source.
MANUAL = {
    # The 24-name expected set is fixed by the PREREG; these are in it but the lists cannot place them.
    'LAUNCHCOIN': ('yes', 'expected set; CoinGecko id ben-pasternak (now "Believe"), Solana mint BLVxek8Y...'),
    'DOOD': ('yes', 'expected set; CoinGecko id doodles, Solana mint DvjbEsdc...; out of the category top 500'),
    'AI16Z': ('yes', 'expected set; CoinGecko id ai16z, Solana mint HeLp6NuQ...; out of the category top 500'),
    'JELLY': ('yes', 'expected set; CoinGecko id jelly-my-jelly (symbol JELLYJELLY), Solana mint FeR8VBqN...pump'),
    'GRIFFAIN': ('yes', 'expected set; CoinGecko griffain, Solana mint KENJSUYL...; CoinGecko files it outside the meme category'),
    'SPX': ('yes', 'expected set; CoinGecko spx6900 (Ethereum native; Solana mint J3NKxxXZ... is the Wormhole-bridged token)'),
    'YZY': ('yes', 'expected set; CoinGecko yzy, Solana mint DrZ26cKJ...; CoinGecko files it outside the meme category'),
    # Same-symbol collisions: the category coin is a tiny Solana clone, not the token the HL perp tracks.
    'LOOM': ('no', 'HL perp is Loom Network (CoinGecko loom-network-new, Ethereum); matched loom-4 has ~$118k cap'),
    'OMNI': ('no', 'HL perp is Omni Network (CoinGecko omni-network); matched omni-2 has ~$113k cap'),
    # Symbols with no listed match: each is a known non-meme or non-Solana token (by-hand ruling).
    'OX': ('no', 'OX.FUN exchange token'), 'BANANA': ('no', 'Banana Gun (Ethereum bot token)'),
    'FTT': ('no', 'FTX token'), 'BADGER': ('no', 'Badger DAO (Ethereum)'), 'PIXEL': ('no', 'Pixels (Ronin game)'),
    'TST': ('no', 'BNB Chain test token'), 'LAYER': ('no', 'Solayer: Solana infrastructure, not a meme'),
    'PROMPT': ('no', 'Wayfinder PROMPT: AI agent token, not a Solana meme'),
}
meta = json.load(open(os.path.join(D, 'hl/meta.json')))['universe']
cat, top = [], []
for p in (1, 2):
    cat += json.load(open(os.path.join(D, f'cg/solmeme_{p}.json')))
for p in (1, 2, 3, 4):
    top += json.load(open(os.path.join(D, f'cg/all_{p}.json')))
catids = {c['id'] for c in cat}
plat = json.load(open(os.path.join(D, 'cg/list_platforms.json')))
rows = []
for a in meta:
    name = a['name']
    sym = name[1:] if name[0] == 'k' and name[1:].isupper() else name
    cands = {c['id']: c for c in top + cat if c['symbol'].upper() == sym.upper()}
    row = {'hl': name, 'symbol': sym, 'delisted': bool(a.get('isDelisted'))}
    if name in MANUAL:
        row.update(meme=MANUAL[name][0], source='manual: ' + MANUAL[name][1])
    elif cands:
        best = max(cands.values(), key=lambda c: c.get('market_cap') or 0)
        sol = next((p for p in plat if p['id'] == best['id']), {}).get('platforms', {}).get('solana')
        row.update(meme='yes' if best['id'] in catids else 'no', cg_id=best['id'], solana_mint=sol,
                   source='coingecko solana-meme-coins category' if best['id'] in catids
                   else 'coingecko: largest coin with this symbol is not in solana-meme-coins')
    else:
        sols = [p for p in plat if p['symbol'].upper() == sym.upper() and p['platforms'].get('solana')]
        row.update(meme='review' if sols else 'no', cg_id=None,
                   source=('solana-platform coins with this symbol: ' + ', '.join(p['id'] for p in sols)) if sols
                   else 'coingecko: no Solana coin with this symbol')
    rows.append(row)
json.dump(rows, open(OUT, 'w'), indent=1)
for r in rows:
    if r['meme'] != 'no':
        print(r['hl'], r['meme'], r.get('cg_id'), r['source'][:90])
print(len(rows), 'names;', sum(r['meme'] == 'yes' for r in rows), 'yes;', sum(r['meme'] == 'review' for r in rows), 'review')
