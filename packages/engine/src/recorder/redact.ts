// Envelope redaction (A-M07-01 "Security notes"). Applies B-M27-01's rule for strings: any string holding a URL query
// parameter named like a key (`api-key`, `api_key`, `key`, `token`) is replaced with "[redacted]". It works on
// canonical JSON, so it reaches every string in the payload, object keys included. When B-M27-01's redaction schema
// lands (card Z02) the recorder takes its field rules too; this string rule stays as the floor.

const KEY_PARAM = /[?&](?:api-key|api_key|key|token)=/i;
const JSON_STRING = /"(?:[^"\\]|\\.)*"/g;
const REDACTED = '"[redacted]"';

export function isSecretShaped(s: string): boolean {
  return KEY_PARAM.test(s);
}

/** Returns `json` with every secret-shaped string literal replaced, and how many were replaced. */
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
    return REDACTED;
  });
  return { json: out, redacted };
}
