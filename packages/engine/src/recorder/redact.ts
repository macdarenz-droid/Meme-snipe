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

const MARKER = '[redacted:';

/** Every object key in a parsed JSON value, counted, and whether any starts with the redaction marker. */
function keyScan(v: unknown, acc: { keys: number; marked: boolean }): void {
  if (Array.isArray(v)) {
    for (const x of v) keyScan(x, acc);
  } else if (typeof v === 'object' && v !== null) {
    for (const k of Object.keys(v)) {
      acc.keys++;
      if (k.startsWith(MARKER)) acc.marked = true;
      keyScan((v as Record<string, unknown>)[k], acc);
    }
  }
}

/**
 * Returns canonical `json` with every secret-shaped string replaced, and how many were replaced. `collision` is true
 * when the payload already has a key starting with "[redacted:", or when redaction merged two keys (the re-parse has
 * fewer keys): the caller refuses the record (E_PAYLOAD), since its keys could no longer be told apart (ruling 13).
 */
export function redactJson(json: string): { json: string; redacted: number; collision: boolean } {
  // canonicalJson writes strings with JSON.stringify, which never escapes '[', ':', '=', '?' or '&'.
  if (json.includes(JSON.stringify(MARKER).slice(0, -1))) {
    const acc = { keys: 0, marked: false };
    keyScan(JSON.parse(json), acc);
    if (acc.marked) return { json, redacted: 0, collision: true };
  }
  // Fast path: a key-shaped parameter needs '=' and one of '?' or '&'.
  if (!json.includes('=') || (!json.includes('?') && !json.includes('&'))) {
    return { json, redacted: 0, collision: false };
  }
  let redacted = 0;
  const out = json.replace(JSON_STRING, (lit) => {
    const value = JSON.parse(lit) as string;
    if (!isSecretShaped(value)) return lit;
    redacted++;
    return JSON.stringify(`${MARKER}${redacted}]`);
  });
  if (redacted === 0) return { json, redacted: 0, collision: false };
  const before = { keys: 0, marked: false };
  keyScan(JSON.parse(json), before);
  const parsed: unknown = JSON.parse(out);
  const after = { keys: 0, marked: false };
  keyScan(parsed, after);
  if (after.keys < before.keys) return { json, redacted: 0, collision: true };
  // A replaced key can sort differently from the one it replaced: write it out canonically again.
  return { json: canonicalJson(parsed), redacted, collision: false };
}
