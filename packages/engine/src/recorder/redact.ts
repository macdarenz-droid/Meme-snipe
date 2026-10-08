// Envelope redaction (A-M07-01 "Security notes"). Applies B-M27-01's rule for strings: any string holding a URL query
// parameter named like a key (`api-key`, `api_key`, `key`, `token`) is replaced. It works on canonical JSON, so it
// reaches every string in the payload, object keys included. Each replaced string becomes "[redacted:<n>]", numbered
// within the record, so two redacted keys of one object stay two keys (review round 1, red team m1); the result is
// written through canonicalJson again, so its keys stay sorted. When B-M27-01's redaction schema lands (card Z02) the
// recorder takes its field rules too; this string rule stays as the floor.
import { canonicalJson } from '@bot/types';

const KEY_PARAM = /[?&](?:api-key|api_key|key|token)=/i;
const JSON_STRING = /"(?:[^"\\]|\\.)*"/g;

export function isSecretShaped(s: string): boolean {
  return KEY_PARAM.test(s);
}

/** Returns canonical `json` with every secret-shaped string replaced, and how many were replaced. */
export function redactJson(json: string): { json: string; redacted: number } {
  // Fast path: a key-shaped parameter needs '=' and one of '?' or '&'. canonicalJson writes strings with
  // JSON.stringify, which never escapes these three characters.
  if (!json.includes('=') || (!json.includes('?') && !json.includes('&'))) {
    return { json, redacted: 0 };
  }
  let redacted = 0;
  const out = json.replace(JSON_STRING, (lit) => {
    const value = JSON.parse(lit) as string;
    if (!isSecretShaped(value)) return lit;
    redacted++;
    return JSON.stringify(`[redacted:${redacted}]`);
  });
  if (redacted === 0) return { json, redacted: 0 };
  // A replaced key can sort differently from the one it replaced: write it out canonically again.
  return { json: canonicalJson(JSON.parse(out)), redacted };
}
