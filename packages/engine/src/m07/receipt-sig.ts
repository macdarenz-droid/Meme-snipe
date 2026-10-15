// The PullReceipt format (SPEC-A A-M07-03 logic 3-4, card Z08; ruling Z08-5: engine-local, no new package). A receipt
// says the operator's machine downloaded one segment and its SHA-256 matched; it is signed with the research Ed25519 key,
// which never lives on the host, so a host compromise cannot fake a verified pull. The signed bytes are the canonical
// JSON (@bot/types `canonicalJson`) of the receipt without `signatureB64`.
//
// VERIFY A-18 (resolved, card Z08): Node's built-in `crypto.sign(algorithm, data, key)` / `crypto.verify` take
// `algorithm` null for Ed25519 keys ("If `algorithm` is `null` or `undefined`, then the algorithm is dependent upon the
// key type (especially Ed25519 and Ed448)"), added v12.0.0 — https://nodejs.org/docs/latest-v22.x/api/crypto.md, read
// 2026-10-15.
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { canonicalJson, type UnixMs } from '@bot/types';

export interface PullReceipt { path: string; sha256: string; verifiedAtMs: UnixMs; verifier: string; signatureB64: string }

/** A segment's path under the market-data folder: `YYYY-MM-DD/HH/<stream>[.pN].ndjson.gz` (or `.zst`). */
export const SEGMENT_PATH = /^\d{4}-\d{2}-\d{2}\/([01]\d|2[0-3])\/[a-z_]+(\.p[1-9]\d{0,3})?\.ndjson\.(gz|zst)$/;
const VERIFIER = /^[A-Za-z0-9._-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const B64_SIG = /^[A-Za-z0-9+/]{86}==$/;                                   // 64 bytes

const signedBytes = (r: Omit<PullReceipt, 'signatureB64'>): Buffer =>
  Buffer.from(canonicalJson({ path: r.path, sha256: r.sha256, verifiedAtMs: r.verifiedAtMs, verifier: r.verifier }), 'utf8');

/** An Ed25519 key from PEM (SPKI public or PKCS#8 private); throws on any other key type. */
export function ed25519Key(pem: string, kind: 'public' | 'private'): KeyObject {
  const k = kind === 'public' ? createPublicKey(pem) : createPrivateKey(pem);
  if (k.asymmetricKeyType !== 'ed25519') throw new TypeError('the research key must be Ed25519');
  return k;
}

/** Signs a receipt (operator side, `md-pull`). */
export function signReceipt(r: Omit<PullReceipt, 'signatureB64'>, privateKey: KeyObject): PullReceipt {
  if (!SEGMENT_PATH.test(r.path) || !SHA256.test(r.sha256) || !VERIFIER.test(r.verifier) || !Number.isSafeInteger(r.verifiedAtMs)) {
    throw new TypeError('receipt fields out of shape');
  }
  return { ...r, signatureB64: sign(null, signedBytes(r), privateKey).toString('base64') };
}

/** The receipt in `bytes` when it has exactly the receipt shape and a valid signature by `publicKey`; else null. */
export function verifyReceipt(bytes: Uint8Array, publicKey: KeyObject): PullReceipt | null {
  let o: unknown;
  try {
    o = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  const keys = Object.keys(r).sort().join(',');
  if (keys !== 'path,sha256,signatureB64,verifiedAtMs,verifier') return null;
  if (typeof r.path !== 'string' || !SEGMENT_PATH.test(r.path)) return null;
  if (typeof r.sha256 !== 'string' || !SHA256.test(r.sha256)) return null;
  if (typeof r.verifier !== 'string' || !VERIFIER.test(r.verifier)) return null;
  if (typeof r.verifiedAtMs !== 'number' || !Number.isSafeInteger(r.verifiedAtMs)) return null;
  if (typeof r.signatureB64 !== 'string' || !B64_SIG.test(r.signatureB64)) return null;
  const receipt = r as unknown as PullReceipt;
  const ok = verify(null, signedBytes(receipt), publicKey, Buffer.from(receipt.signatureB64, 'base64'));
  return ok ? receipt : null;
}

/** The receipt as written to the receipts folder. */
export const receiptText = (r: PullReceipt): string => `${canonicalJson(r)}\n`;
