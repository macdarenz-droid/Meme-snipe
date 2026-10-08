"""Addresses: base58, the ed25519 on-curve test (PREREG §3: program-derived owners are off-curve),
the fixed excluded addresses, and truncated SHA-256 hashes for committed summaries (PREREG §10)."""
import hashlib

_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_B58_IDX = {c: i for i, c in enumerate(_B58)}

# ed25519 field and curve constant (RFC 8032 §5.1)
_P = 2**255 - 19
_D = (-121665 * pow(121666, _P - 2, _P)) % _P

# Fixed addresses PREREG §3 names (sources: research/buyback-probe/PREREG_DRAFT.md, docs research safety notes).
BUYBACK_AUTHORITY = "GmFrDZT2cdrqykgTikVdXbe8EtCgzUDM9VsDhQnwsUsG"
MAYHEM_VAULT = "BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s"
SYSTEM_PROGRAM = "11111111111111111111111111111111"
WSOL = "So11111111111111111111111111111111111111112"
# Quote mints that mean SOL on a curve (historical-data.md: empty, the system program or WSOL).
SOL_CURVE_QUOTES = {"", SYSTEM_PROGRAM, WSOL}


def b58decode(s: str) -> bytes:
    n = 0
    for ch in s:
        n = n * 58 + _B58_IDX[ch]
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    pad = len(s) - len(s.lstrip("1"))
    return b"\x00" * pad + raw


def on_curve(addr: str) -> bool:
    """True when the 32-byte key decompresses to an ed25519 point (as curve25519-dalek's
    CompressedEdwardsY::decompress, which Solana's PDA rule uses). Malformed input is False."""
    try:
        b = b58decode(addr)
    except KeyError:
        return False
    if len(b) != 32:
        return False
    y = int.from_bytes(b, "little")
    y = (y & ((1 << 255) - 1)) % _P  # dalek's FieldElement::from_bytes: top bit ignored, value reduced
    u = (y * y - 1) % _P
    v = (_D * y * y + 1) % _P
    v3 = v * v % _P * v % _P
    v7 = v3 * v3 % _P * v % _P
    x = u * v3 % _P * pow(u * v7 % _P, (_P - 5) // 8, _P) % _P
    vx2 = (v * x * x) % _P
    # sqrt_ratio_i succeeds when v*x^2 is u or -u (the latter fixed by sqrt(-1)); dalek accepts x = 0 with
    # either sign bit, so the sign bit never decides the answer.
    return vx2 == u or vx2 == (-u) % _P


def short_hash(addr: str, n: int = 12) -> str:
    """Truncated SHA-256 of an address: the only form an address takes in a committed summary."""
    return hashlib.sha256(addr.encode()).hexdigest()[:n]
