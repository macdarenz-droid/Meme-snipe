#!/usr/bin/env bash
# verify-preview-cert.sh APK: the APK must carry exactly one signer whose certificate SHA-256 equals the
# PREVIEW_CERT_SHA256 variable (env CERT_SHA256), so no other key reaches the phone (SEC-1). Before the
# owner sets the variable it warns and passes. APKSIGNER names apksigner (default: the newest build-tools').
set -euo pipefail
norm() { tr -d ': \n' | tr 'a-f' 'A-F'; }
apk="$1"
want="$(printf '%s' "${CERT_SHA256:-}" | norm)"
if [ -z "$want" ]; then
  echo "::warning::PREVIEW_CERT_SHA256 is not set; the APK's signing certificate is not checked."
  exit 0
fi
signer="${APKSIGNER:-$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)/apksigner}"
certs="$("$signer" verify --print-certs "$apk")" || { echo "::error::apksigner refused $apk."; exit 1; }
mapfile -t got < <(printf '%s\n' "$certs" | sed -n 's/^Signer #[0-9]* certificate SHA-256 digest: *//p' | while read -r l; do printf '%s' "$l" | norm; echo; done)
if [ "${#got[@]}" -ne 1 ]; then
  echo "::error::$apk has ${#got[@]} signers; exactly one is allowed."
  exit 1
fi
if [ "${got[0]}" != "$want" ]; then
  echo "::error::$apk is signed by ${got[0]}, not PREVIEW_CERT_SHA256 $want."
  exit 1
fi
echo "$apk is signed by the owner's key ($want)."
