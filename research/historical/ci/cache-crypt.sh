#!/usr/bin/env bash
# CACHE-CRYPT (OF-2 round 6, rulings 44 and 44a): the scan's progress (units, k2 copies,
# back-off state) is saved to the Actions cache only sealed. In this public repository a
# fork's pull_request workflow can restore the base branch's caches, so no archive-derived
# byte goes there in the clear. The key is derived from DATA_STORE_TOKEN (a secret: fork
# PRs get none) with HMAC-SHA256 and fixed labels, so the owner adds no new secret.
# Encrypt-then-MAC: AES-256-CTR (openssl) over a tar of the directory, then HMAC-SHA256
# over the version, key id, salt, the cache key prefix (source and day, round 7 ruling 50)
# and the ciphertext; a wrong key, a changed byte, or an entry of another day or source is
# refused before anything is decrypted.
#   cache-crypt.sh kid                  prints the key id (12 hex of an HMAC of the token;
#                                       it reveals nothing about the token), and writes
#                                       kid=<id> to $GITHUB_OUTPUT when set
#   cache-crypt.sh seal SRC SEALED PREFIX  SRC (a directory) into SEALED, which then holds
#                                       only progress.enc, progress.iv (the salt),
#                                       progress.kid, progress.mac; PREFIX is the cache
#                                       key prefix it is saved under (data-scan-DAY-,
#                                       data-rpc-DAY- or data-rpc-assets-DAY-)
#   cache-crypt.sh open SEALED DEST PREFIX  checks the files, the key id and the MAC
#                                       (with the PREFIX being resumed), then
#                                       decrypts into DEST and removes SEALED; anything else
#                                       exits 2 (refused,
#                                       nothing read: the scan never starts the day fresh)
#   cache-crypt.sh check SEALED         SEALED holds only those four files (no plaintext);
#                                       needs no token (data-keep's structure check)
# Env: DATA_STORE_TOKEN only, and only in the clean crypt steps (never Scan or QA). The
# derived keys stay in shell variables of this process (never exported, never an
# argument): openssl gets its key material on a file descriptor (-pass fd:3, PBKDF2 with
# one iteration over the 256-bit derived key and a random salt; round 7, ruling 52), and
# python gets the MAC key in its own environment only.
set -euo pipefail
refuse() { echo "refused: $*" >&2; exit 2; }
token() { [[ -n "${DATA_STORE_TOKEN:-}" ]] || refuse "DATA_STORE_TOKEN is not set: no key, so no progress cache is sealed or opened"; }
prefix_ok() { [[ "$1" =~ ^data-(scan|rpc|rpc-assets)-[0-9]{4}-[0-9]{2}-[0-9]{2}-$ ]] || refuse "bad cache key prefix '$1'"; }
ENC=(enc -aes-256-ctr -pbkdf2 -iter 1 -md sha256)
derive() { # derive LABEL: hex HMAC-SHA256(token, "zeroed-archive-cache-v1 LABEL")
  /usr/bin/env python3 -c 'import hashlib, hmac, os, sys
print(hmac.new(os.environ["DATA_STORE_TOKEN"].encode(), ("zeroed-archive-cache-v1 " + sys.argv[1]).encode(), hashlib.sha256).hexdigest())' "$1"
}
FILES="progress.enc progress.iv progress.kid progress.mac"
# mac SEALED PREFIX: HMAC-SHA256 (mac key in python's environment only) over
# "v2 KID SALT PREFIX\n" + progress.enc
mac() {
  MK=$(derive mac) /usr/bin/env python3 -c 'import hashlib, hmac, os, sys
d, p = sys.argv[1], sys.argv[2]
h = hmac.new(bytes.fromhex(os.environ["MK"]), digestmod=hashlib.sha256)
h.update(("v2 " + open(d + "/progress.kid").read().strip() + " " + open(d + "/progress.iv").read().strip() + " " + p + "\n").encode())
with open(d + "/progress.enc", "rb") as f:
    for b in iter(lambda: f.read(1 << 20), b""): h.update(b)
print(h.hexdigest())' "$1" "$2"
}
only_sealed() { [[ -d "$1" && "$(cd "$1" && find . -mindepth 1 | LC_ALL=C sort | tr '\n' ' ')" == "./progress.enc ./progress.iv ./progress.kid ./progress.mac " ]]; }
case "${1:-}" in
  kid) [[ $# -eq 1 ]] || refuse "usage: cache-crypt.sh kid"; token; kid=$(derive kid | cut -c1-12); echo "$kid"; [[ -z "${GITHUB_OUTPUT:-}" ]] || echo "kid=$kid" >> "$GITHUB_OUTPUT" ;;
  seal)
    [[ $# -eq 4 && -d "$2" ]] || refuse "usage: cache-crypt.sh seal SRC SEALED PREFIX"
    src=$2 sealed=$3; prefix_ok "$4"; token; kid=$(derive kid | cut -c1-12)
    echo "cache-crypt: $(openssl version)" >&2
    rm -rf "$sealed"; mkdir -p "$sealed"
    salt=$(openssl rand -hex 8); ek=$(derive enc)
    tar -C "$src" -cf - . | openssl "${ENC[@]}" -S "$salt" -pass fd:3 -out "$sealed/progress.enc" 3< <(printf '%s' "$ek")
    echo "$salt" > "$sealed/progress.iv"; echo "$kid" > "$sealed/progress.kid"
    mac "$sealed" "$4" > "$sealed/progress.mac"
    only_sealed "$sealed" || refuse "$sealed holds files other than the sealed progress"
    echo "cache-crypt: progress sealed ($(stat -c %s "$sealed/progress.enc") bytes, key id $kid)" ;;
  open)
    [[ $# -eq 4 ]] || refuse "usage: cache-crypt.sh open SEALED DEST PREFIX"
    sealed=$2 dest=$3; prefix_ok "$4"; token; kid=$(derive kid | cut -c1-12)
    echo "cache-crypt: $(openssl version)" >&2
    only_sealed "$sealed" || refuse "the restored progress cache is not a sealed one (expected only $FILES)"
    [[ "$(cat "$sealed/progress.kid")" == "$kid" ]] ||
      refuse "the progress cache was sealed with another key (id $(head -c 12 "$sealed/progress.kid"), this run's is $kid): DATA_STORE_TOKEN changed; nothing is read and the day does not start fresh"
    salt=$(cat "$sealed/progress.iv"); [[ "$salt" =~ ^[0-9a-f]{16}$ ]] || refuse "the progress cache's salt is malformed"
    want=$(cat "$sealed/progress.mac"); got=$(mac "$sealed" "$4")
    WANT=$want GOT=$got /usr/bin/env python3 -c 'import hmac, os, sys; sys.exit(0 if hmac.compare_digest(os.environ["WANT"], os.environ["GOT"]) else 1)' ||
      refuse "the progress cache fails its MAC (changed, damaged, or sealed for another day or source than $4): nothing is read"
    mkdir -p "$dest"; ek=$(derive enc)
    openssl "${ENC[@]}" -d -S "$salt" -pass fd:3 -in "$sealed/progress.enc" 3< <(printf '%s' "$ek") | tar -C "$dest" -xf -
    rm -rf "$sealed"
    echo "cache-crypt: progress opened (key id $kid)" ;;
  check) [[ $# -eq 2 ]] || refuse "usage: cache-crypt.sh check SEALED"; only_sealed "$2" || refuse "$2 holds files other than the sealed progress" ;;
  *) refuse "usage: cache-crypt.sh kid | seal SRC SEALED PREFIX | open SEALED DEST PREFIX | check SEALED" ;;
esac
