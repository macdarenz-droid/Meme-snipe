#!/usr/bin/env python3
"""Independent known-answer vector for ops/host/files/usr/local/lib/zeroed/derive-key.mjs.

Python's hashlib.scrypt, a separate bech32 encoder and a textbook RFC 7748 X25519 ladder: no Node and no
age involved. Prints the identity and the recipient for the code given as arguments; the values are pinned
in packages/ops/test/ops-files.test.ts.
  python3 ops/test/derive-key-kat.py correct horse battery staple zebra apple
"""
import hashlib
import sys

CH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'


def polymod(v):
    g = [0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3]
    c = 1
    for x in v:
        t = c >> 25
        c = ((c & 0x1FFFFFF) << 5) ^ x
        for i in range(5):
            if (t >> i) & 1:
                c ^= g[i]
    return c


def bech32(hrp, data):
    acc = bits = 0
    d = []
    for b in data:
        acc = (acc << 8) | b
        bits += 8
        while bits >= 5:
            bits -= 5
            d.append((acc >> bits) & 31)
    if bits:
        d.append((acc << (5 - bits)) & 31)
    e = [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]
    m = polymod(e + d + [0] * 6) ^ 1
    return hrp + '1' + ''.join(CH[x] for x in d + [(m >> 5 * (5 - i)) & 31 for i in range(6)])


def x25519_base(scalar):
    p = 2**255 - 19
    k = int.from_bytes(scalar, 'little')
    k &= ~7
    k &= ~(128 << 8 * 31)
    k |= 64 << 8 * 31
    x1, x2, z2, x3, z3, sw = 9, 1, 0, 9, 1, 0
    for t in reversed(range(255)):
        kt = (k >> t) & 1
        sw ^= kt
        if sw:
            x2, x3, z2, z3 = x3, x2, z3, z2
        sw = kt
        a = (x2 + z2) % p
        aa = a * a % p
        b = (x2 - z2) % p
        bb = b * b % p
        e = (aa - bb) % p
        c = (x3 + z3) % p
        d = (x3 - z3) % p
        da = d * a % p
        cb = c * b % p
        x3 = (da + cb) ** 2 % p
        z3 = x1 * (da - cb) ** 2 % p
        x2 = aa * bb % p
        z2 = e * (aa + 121665 * e) % p
    if sw:
        x2, z2 = x3, z3
    return (x2 * pow(z2, p - 2, p) % p).to_bytes(32, 'little')


code = ' '.join(w.lower() for w in sys.argv[1:])
k = bytearray(hashlib.scrypt(code.encode(), salt=b'zeroed-deploy-handoff-v1', n=2**18, r=8, p=1, dklen=32, maxmem=320 * 1024 * 1024))
k[0] &= 248
k[31] &= 127
k[31] |= 64
print(bech32('age-secret-key-', bytes(k)).upper())
print(bech32('age', x25519_base(bytes(k))))
