import hashlib
B58="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
def b58d(s):
    n=0
    for c in s: n=n*58+B58.index(c)
    b=n.to_bytes(32,'big') if n else b''
    pad=len(s)-len(s.lstrip('1'))
    r=b'\x00'*pad+n.to_bytes((n.bit_length()+7)//8,'big')
    return r
def b58e(b):
    n=int.from_bytes(b,'big'); s=''
    while n: n,r=divmod(n,58); s=B58[r]+s
    return '1'*(len(b)-len(b.lstrip(b'\x00')))+s
p=2**255-19
d=(-121665*pow(121666,-1,p))%p
def on_curve(b):
    y=int.from_bytes(b,'little')&((1<<255)-1)
    if y>=p: return False
    u=(y*y-1)%p; v=(d*y*y+1)%p
    x2=u*pow(v,-1,p)%p
    if x2==0: return True
    return pow(x2,(p-1)//2,p)==1
def fpa(seeds,prog):
    for bump in range(255,-1,-1):
        h=hashlib.sha256(b''.join(seeds)+bytes([bump])+b58d(prog)+b"ProgramDerivedAddress").digest()
        if not on_curve(h): return b58e(h),bump
print(fpa([b"sol-vault"],"MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e"))
print(fpa([b"mint-authority"],"6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"))
