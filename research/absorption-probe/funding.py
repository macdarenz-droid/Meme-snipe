"""Funding groups (a heuristic). A wallet's funder = the source of the first SOL transfer into it, one hop.
Every lookup uses only transactions strictly before a given signature of that wallet (its first buy or sell in
the event window), so nothing after the decision can be seen.

  funder(wallet, before_sig, before_t) -> (funder or None, how)
  is_hub(funder, before_sig, before_t) -> bool: at least HUB_TX transactions in the HUB_WINDOW seconds before
      (exchange-like hot wallets); hub-funded wallets are counted individually.
"""
import struct
import hel
from hel import heli

SYSTEM = '11111111111111111111111111111111'
HUB_TX = 1000
HUB_WINDOW = 86400
SCAN = 1000          # signatures read with getSignaturesForAddress before falling back to an oldest-first query

def _keys(t):
    keys = t['transaction']['message']['accountKeys']
    lw = t['meta'].get('loadedAddresses') or {}
    return keys + lw.get('writable', []) + lw.get('readonly', [])

def _transfers_in(t, wallet):
    """(source, lamports) of system transfers / account creations crediting `wallet`, in instruction order."""
    keys = _keys(t)
    ixs = []
    inner = {g['index']: g['instructions'] for g in (t['meta'].get('innerInstructions') or [])}
    for i, ix in enumerate(t['transaction']['message']['instructions']):
        ixs.append(ix); ixs += inner.get(i, [])
    out = []
    for ix in ixs:
        if keys[ix['programIdIndex']] != SYSTEM:
            continue
        d = heli.b58decode(ix['data']); acc = [keys[a] for a in ix['accounts']]
        if len(d) < 12:
            continue
        tag = struct.unpack_from('<I', d, 0)[0]
        try:
            if tag == 2 and len(acc) >= 2 and acc[1] == wallet:                 # Transfer
                out.append((acc[0], struct.unpack_from('<Q', d, 4)[0]))
            elif tag == 0 and len(acc) >= 2 and acc[1] == wallet:               # CreateAccount
                out.append((acc[0], struct.unpack_from('<Q', d, 4)[0]))
            elif tag == 11 and len(acc) >= 3 and acc[2] == wallet:              # TransferWithSeed
                out.append((acc[0], struct.unpack_from('<Q', d, 4)[0]))
        except struct.error:
            pass
    return [x for x in out if x[1] > 0 and x[0] != wallet]

def _tx(sig):
    try:
        return hel.rpc('getTransaction', [sig, {'encoding': 'json', 'maxSupportedTransactionVersion': 0, 'commitment': 'finalized'}])
    except RuntimeError as e:
        if '-32015' not in str(e):
            raise
        return hel.rpc('getTransaction', [sig, {'encoding': 'json', 'maxSupportedTransactionVersion': 1, 'commitment': 'finalized'}])

def funder(wallet, before_sig, before_t):
    raw = hel.rpc('getSignaturesForAddress', [wallet, {'before': before_sig, 'limit': SCAN, 'commitment': 'finalized'}]) or []
    sigs = [x for x in raw if x.get('err') is None]
    how = 'scan'
    if len(raw) >= SCAN or not sigs:
        res = hel.rpc('getTransactionsForAddress', [wallet, {'transactionDetails': 'signatures', 'sortOrder': 'asc', 'limit': 5,
                      'commitment': 'finalized', 'filters': {'blockTime': {'lt': int(before_t)}, 'status': 'succeeded'}}])
        old = res.get('data') or []
        cand = [x['signature'] for x in old]
        how = 'oldest-first'
    else:
        cand = [x['signature'] for x in reversed(sigs[-5:])]
    for sig in cand[:3]:
        t = _tx(sig)
        if not t or not t.get('meta'):
            continue
        tr = _transfers_in(t, wallet)
        if tr:
            return tr[0][0], how
        keys = _keys(t)
        if wallet in keys:                                   # balance went up from zero: the fee payer funded it
            i = keys.index(wallet)
            pre, post = t['meta']['preBalances'][i], t['meta']['postBalances'][i]
            if pre == 0 and post > 0 and keys[0] != wallet:
                return keys[0], how + '-feepayer'
    return None, 'unresolved'

def is_hub(addr, before_sig, before_t):
    sigs = hel.rpc('getSignaturesForAddress', [addr, {'before': before_sig, 'limit': HUB_TX, 'commitment': 'finalized'}]) or []
    if len(sigs) < HUB_TX:
        return False
    oldest = min((x.get('blockTime') or 0) for x in sigs)
    return oldest >= before_t - HUB_WINDOW
