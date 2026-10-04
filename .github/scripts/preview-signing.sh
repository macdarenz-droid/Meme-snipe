#!/usr/bin/env bash
# Picks the key the preview APK is signed with (SEC-1) and writes `source` to GITHUB_OUTPUT:
#   throwaway  pull requests and other branches: a key made for this build only, never a stable one;
#   secret     the integration branch with the owner's PREVIEW_KEYSTORE_B64 secret: decoded to
#              $HOME/.zeroed-preview/preview.p12 and refused unless its certificate's SHA-256 equals the
#              PREVIEW_CERT_SHA256 variable;
#   cache      the integration branch before the owner adds them: APP-1's cached key, with a warning.
# Never prints the keystore or its password. Env: INTEGRATION, KEYSTORE_B64, KEYSTORE_PASSWORD, CERT_SHA256.
set -euo pipefail
norm() { tr -d ': \n' | tr 'a-f' 'A-F'; }
out() { echo "source=$1" >>"$GITHUB_OUTPUT"; }
if [ "${INTEGRATION:-}" != true ]; then
  echo "Signing with a throwaway key (not a push or manual run on the integration branch)."
  out throwaway
  exit 0
fi
want="$(printf '%s' "${CERT_SHA256:-}" | norm)"
if [ -z "${KEYSTORE_B64:-}" ]; then
  if [ -n "$want" ]; then
    echo "::error::PREVIEW_CERT_SHA256 is set but the PREVIEW_KEYSTORE_B64 secret is missing; nothing is signed."
    exit 1
  fi
  echo "::warning::Signing with the cached key: add the PREVIEW_KEYSTORE_B64 and PREVIEW_KEYSTORE_PASSWORD secrets and the PREVIEW_CERT_SHA256 variable (docs/ANDROID_PREVIEW.md, Keystore)."
  out cache
  exit 0
fi
if ! [[ "$want" =~ ^[0-9A-F]{64}$ ]]; then
  echo "::error::The PREVIEW_CERT_SHA256 variable must hold the key's 64-digit SHA-256 certificate fingerprint; nothing is signed."
  exit 1
fi
if [ -z "${KEYSTORE_PASSWORD:-}" ]; then
  echo "::error::The PREVIEW_KEYSTORE_PASSWORD secret is missing; nothing is signed."
  exit 1
fi
umask 077
mkdir -p "$HOME/.zeroed-preview"
ks="$HOME/.zeroed-preview/preview.p12"
printf '%s' "$KEYSTORE_B64" | tr -d ' \r\n' | base64 -d >"$ks" 2>/dev/null || { echo "::error::PREVIEW_KEYSTORE_B64 is not base64; nothing is signed."; exit 1; }
# -legacy opens a keystore from an older keytool (RC2 or 3DES), which OpenSSL 3 refuses by default.
fpr() { openssl pkcs12 -in "$ks" -nokeys -clcerts -passin env:KEYSTORE_PASSWORD "$@" 2>/dev/null | openssl x509 -noout -fingerprint -sha256 2>/dev/null | sed 's/^.*=//' | norm; }
got="$(fpr || true)"
[ -n "$got" ] || got="$(fpr -legacy || true)"
if [ -z "$got" ]; then
  echo "::error::The keystore in PREVIEW_KEYSTORE_B64 does not open with PREVIEW_KEYSTORE_PASSWORD; nothing is signed."
  exit 1
fi
if [ "$got" != "$want" ]; then
  echo "::error::The keystore's certificate is $got, not PREVIEW_CERT_SHA256 $want; nothing is signed."
  exit 1
fi
echo "ZEROED_DEBUG_KEYSTORE=$ks" >>"$GITHUB_ENV"
echo "ZEROED_KEY_ALIAS=zeroed-preview" >>"$GITHUB_ENV"
echo "Signing with the owner's key, certificate SHA-256 $got."
out secret
