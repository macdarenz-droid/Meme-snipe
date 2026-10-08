#!/usr/bin/env bash
# CACHE-CRYPT (OF-2 round 6, rulings 44 and 44a): the scan's progress (units, k2 copies,
# back-off state) is saved to the Actions cache only sealed. In this public repository a
# fork's pull_request workflow can restore the base branch's caches, so no archive-derived
# byte goes there in the clear. The key is derived from DATA_STORE_TOKEN (a secret: fork
# PRs get none) with HMAC-SHA256 and fixed labels, so the owner adds no new secret.
# Encrypt-then-MAC: AES-256-CTR (openssl) over a tar of the directory, then HMAC-SHA256
# over the version, key id, IV and ciphertext; a wrong key or a changed byte is refused
# before anything is decrypted.
#   cache-crypt.sh kid                  prints the key id (12 hex of an HMAC of the token;
#                                       it reveals nothing about the token), and writes
#                                       kid=<id> to $GITHUB_OUTPUT when set
#   cache-crypt.sh seal SRC SEALED      SRC (a directory) into SEALED, which then holds only
#                                       progress.enc, progress.iv, progress.kid, progress.mac
#   cache-crypt.sh open SEALED DEST     checks the files, the key id and the MAC, then
#                                       decrypts into DEST and removes SEALED; anything else
#                                       exits 2 (refused,
#                                       nothing read: the scan never starts the day fresh)
#   cache-crypt.sh check SEALED         SEALED holds only those four files (no plaintext)
# Env: DATA_STORE_TOKEN only, and only in the clean crypt steps (never Scan or QA). The
# derived keys stay in this process and its children; the AES key reaches openssl as an
# argument on the runner itself, which is single-use.
set -euo pipefail
refuse() { echo "refused: $*" >&2; exit 2; }
[[ -n "${DATA_STORE_TOKEN:-}" ]] || refuse "DATA_STORE_TOKEN is not set: no key, so no progress cache is sealed or opened"
derive() { # derive LABEL: hex HMAC-SHA256(token, "zeroed-archive-cache-v1 LABEL")
  /usr/bin/env python3 -c 'import hashlib, hmac, os, sys
print(hmac.new(os.environ["DATA_STORE_TOKEN"].encode(), ("zeroed-archive-cache-v1 " + sys.argv[1]).encode(), hashlib.sha256).hexdigest())' "$1"
}
kid=$(derive kid | cut -c1-12)
FILES="progress.enc progress.iv progress.kid progress.mac"
# mac SEALED: HMAC-SHA256 (mac key from the environment) over "v1 KID IV\n" + progress.enc
mac() {
  MK=$(derive mac) /usr/bin/env python3 -c 'import hashlib, hmac, os, sys
d = sys.argv[1]
h = hmac.new(bytes.fromhex(os.environ["MK"]), digestmod=hashlib.sha256)
h.update(("v1 " + open(d + "/progress.kid").read().strip() + " " + open(d + "/progress.iv").read().strip() + "\n").encode())
with open(d + "/progress.enc", "rb") as f:
    for b in iter(lambda: f.read(1 << 20), b""): h.update(b)
print(h.hexdigest())' "$1"
}
only_sealed() { [[ -d "$1" && "$(cd "$1" && find . -mindepth 1 | LC_ALL=C sort | tr '\n' ' ')" == "./progress.enc ./progress.iv ./progress.kid ./progress.mac " ]]; }
case "${1:-}" in
  kid) [[ $# -eq 1 ]] || refuse "usage: cache-crypt.sh kid"; echo "$kid"; [[ -z "${GITHUB_OUTPUT:-}" ]] || echo "kid=$kid" >> "$GITHUB_OUTPUT" ;;
  seal)
    [[ $# -eq 3 && -d "$2" ]] || refuse "usage: cache-crypt.sh seal SRC SEALED"
    src=$2 sealed=$3
    rm -rf "$sealed"; mkdir -p "$sealed"
    iv=$(openssl rand -hex 16)
    tar -C "$src" -cf - . | openssl enc -aes-256-ctr -K "$(derive enc)" -iv "$iv" -out "$sealed/progress.enc"
    echo "$iv" > "$sealed/progress.iv"; echo "$kid" > "$sealed/progress.kid"
    mac "$sealed" > "$sealed/progress.mac"
    only_sealed "$sealed" || refuse "$sealed holds files other than the sealed progress"
    echo "cache-crypt: progress sealed ($(stat -c %s "$sealed/progress.enc") bytes, key id $kid)" ;;
  open)
    [[ $# -eq 3 ]] || refuse "usage: cache-crypt.sh open SEALED DEST"
    sealed=$2 dest=$3
    only_sealed "$sealed" || refuse "the restored progress cache is not a sealed one (expected only $FILES)"
    [[ "$(cat "$sealed/progress.kid")" == "$kid" ]] ||
      refuse "the progress cache was sealed with another key (id $(head -c 12 "$sealed/progress.kid"), this run's is $kid): DATA_STORE_TOKEN changed; nothing is read and the day does not start fresh"
    iv=$(cat "$sealed/progress.iv"); [[ "$iv" =~ ^[0-9a-f]{32}$ ]] || refuse "the progress cache's IV is malformed"
    want=$(cat "$sealed/progress.mac"); got=$(mac "$sealed")
    WANT=$want GOT=$got /usr/bin/env python3 -c 'import hmac, os, sys; sys.exit(0 if hmac.compare_digest(os.environ["WANT"], os.environ["GOT"]) else 1)' ||
      refuse "the progress cache fails its MAC (changed or damaged): nothing is read"
    mkdir -p "$dest"
    openssl enc -d -aes-256-ctr -K "$(derive enc)" -iv "$iv" -in "$sealed/progress.enc" | tar -C "$dest" -xf -
    rm -rf "$sealed"
    echo "cache-crypt: progress opened (key id $kid)" ;;
  check) [[ $# -eq 2 ]] || refuse "usage: cache-crypt.sh check SEALED"; only_sealed "$2" || refuse "$2 holds files other than the sealed progress" ;;
  *) refuse "usage: cache-crypt.sh kid | seal SRC SEALED | open SEALED DEST | check SEALED" ;;
esac
