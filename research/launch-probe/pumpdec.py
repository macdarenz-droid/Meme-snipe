"""Decoding of pump.fun bonding-curve events from getTransaction results (json encoding).

Events are Anchor self-CPI logs: inner instruction data = EVENT_IX_TAG + 8-byte discriminator + borsh body.
Only the fixed leading fields are decoded (their layout is the same in every version seen); the version-dependent
tail is walked defensively and missing fields are left as None.
"""
import struct, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'execution-audit'))
from heli import b58decode, b58encode, EVENT_IX_TAG

PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
TRADE = bytes([189, 219, 127, 211, 78, 230, 97, 238])
CREATE = bytes([27, 114, 169, 77, 222, 235, 99, 118])
COMPLETE = bytes([95, 114, 97, 156, 212, 46, 152, 8])

def _pk(b, p):
    return b58encode(b[p:p + 32]), p + 32

def _str(b, p):
    n = struct.unpack_from('<I', b, p)[0]
    return b[p + 4:p + 4 + n].decode('utf-8', 'replace'), p + 4 + n

def decode_trade(b):
    ev = {}
    ev['mint'], p = _pk(b, 0)
    ev['sol_amount'], ev['token_amount'] = struct.unpack_from('<QQ', b, p); p += 16
    ev['is_buy'] = bool(b[p]); p += 1
    ev['user'], p = _pk(b, p)
    ev['timestamp'], ev['vsol'], ev['vtok'], ev['rsol'], ev['rtok'] = struct.unpack_from('<q4Q', b, p); p += 40
    ev['fee_recipient'], p = _pk(b, p)
    ev['fee_bps'], ev['fee'] = struct.unpack_from('<QQ', b, p); p += 16
    ev['creator'], p = _pk(b, p)
    ev['creator_fee_bps'], ev['creator_fee'] = struct.unpack_from('<QQ', b, p); p += 16
    ev['cashback_bps'] = ev['cashback'] = ev['buyback_bps'] = ev['buyback_fee'] = None
    try:
        p += 1 + 8 + 8 + 8 + 8                                   # track_volume .. last_update_timestamp
        ev['ix_name'], p = _str(b, p)
        p += 1                                                   # mayhem_mode
        ev['cashback_bps'], ev['cashback'] = struct.unpack_from('<QQ', b, p); p += 16
        ev['buyback_bps'], ev['buyback_fee'] = struct.unpack_from('<QQ', b, p); p += 16
    except (struct.error, UnicodeDecodeError):
        pass
    return ev

def decode_create(b):
    ev = {}
    p = 0
    ev['name'], p = _str(b, p)
    ev['symbol'], p = _str(b, p)
    ev['uri'], p = _str(b, p)
    ev['mint'], p = _pk(b, p)
    ev['bonding_curve'], p = _pk(b, p)
    ev['user'], p = _pk(b, p)
    ev['creator'], p = _pk(b, p)
    ev['timestamp'], ev['vtok'], ev['vsol'], ev['rtok'], ev['supply'] = struct.unpack_from('<q4Q', b, p)
    return ev

def decode_complete(b):
    ev = {}
    ev['user'], p = _pk(b, 0)
    ev['mint'], p = _pk(b, p)
    ev['bonding_curve'], p = _pk(b, p)
    ev['timestamp'] = struct.unpack_from('<q', b, p)[0]
    return ev

def tx_keys(tx):
    keys = list(tx['transaction']['message']['accountKeys'])
    lw = tx['meta'].get('loadedAddresses') or {}
    return keys + lw.get('writable', []) + lw.get('readonly', [])

def events(tx):
    """pump.fun events of a successful transaction, in inner-instruction order: list of (kind, k, dict)."""
    out = []
    if not tx or not tx.get('meta') or tx['meta'].get('err') is not None:
        return out
    keys = tx_keys(tx)
    for grp in tx['meta'].get('innerInstructions') or []:
        for ix in grp['instructions']:
            if keys[ix['programIdIndex']] != PUMP:
                continue
            d = b58decode(ix['data'])
            if len(d) < 16 or d[:8] != EVENT_IX_TAG:
                continue
            disc, body = d[8:16], d[16:]
            try:
                if disc == TRADE:
                    out.append(('trade', len(out), decode_trade(body)))
                elif disc == CREATE:
                    out.append(('create', len(out), decode_create(body)))
                elif disc == COMPLETE:
                    out.append(('complete', len(out), decode_complete(body)))
            except struct.error:
                out.append(('undecodable', len(out), {'disc': disc.hex()}))
    return out
