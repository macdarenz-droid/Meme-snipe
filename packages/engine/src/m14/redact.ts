// Redaction of provider text (A-M14-01 logic 2; ARCH 12.4): logs, metrics, errors and view models carry the provider
// label only. Text a provider sends back (error messages, bodies) is scrubbed of every substring that could carry the
// URL or a key, then cut to 200 characters. M27 redacts again when it writes a log line (defence in depth).
// Ported from Snipe-solana card C03 (#6 @ 6ae4d62), review fixes C03 R10 and N3 included; the marker is M27's.
import { REDACTED } from '../m27/log.ts';

export { REDACTED };
export const MAX_PROVIDER_MESSAGE = 200;

/** Query parameters that carry keys (ARCH 12.4, B-M27-01 logic 4). */
const KEYED_QUERY = /([?&;]|\b)(api[-_]?key|key|token|access[-_]?token|auth)=[^&\s"'<>]*/gi;
/** Names of query parameters that carry keys. */
const KEY_NAME = /^(api[-_]?key|key|token|access[-_]?token|auth)$/i;
/**
 * Query values and path segments at least this long are redacted (some providers put the key in the path; review
 * C03 R10: a 7-character path key was missed at 8). Shorter ones such as `v=1` or `/v1` would only mangle text.
 */
const MIN_SECRET_PART = 4;

/** `text` as a provider may echo it percent-encoded: encodeURIComponent, with upper- and lower-case hex digits. */
function encodedForms(text: string): string[] {
  const upper = encodeURIComponent(text);
  return upper === text ? [] : [upper, upper.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())];
}

/**
 * The substrings of `url` that must never leave memory: the URL itself, the parts a provider may echo (host, path,
 * query, path segments and query values, user and password), and each of them percent-encoded (review C03 R10).
 */
export function secretParts(url: string): string[] {
  const parts = new Set<string>([url]);
  let u: URL | null = null;
  try {
    u = new URL(url);
  } catch {
    // not a URL: only the text itself
  }
  if (u !== null) {
    parts.add(`${u.origin}${u.pathname}`);
    parts.add(u.host + u.pathname);
    parts.add(u.host);
    if (u.search.length > 1) parts.add(u.search.slice(1));
    // A keyed parameter's value whatever its length; other values from MIN_SECRET_PART characters.
    const addValue = (name: string, value: string): void => {
      if (value.length > 0 && (value.length >= MIN_SECRET_PART || KEY_NAME.test(name))) parts.add(value);
    };
    for (const [name, value] of u.searchParams) addValue(name, value);
    // searchParams reads `+` as a space; a provider may echo the value as written (review C03 N3: `Ab12+cd/EF==`), or
    // percent-decoded with its `+` kept.
    // A parameter without `=` is all value (a bare key such as `?Ab12cd`).
    for (const pair of u.search.slice(1).split('&')) {
      const raw = pair.slice(pair.indexOf('=') + 1);
      for (const name of new URLSearchParams(pair).keys()) {
        addValue(name, raw);
        try { addValue(name, decodeURIComponent(raw)); } catch { /* a malformed escape: the raw value is enough */ }
      }
    }
    for (const segment of u.pathname.split('/')) {
      if (segment.length >= MIN_SECRET_PART) {
        parts.add(segment);
        // The URL parser keeps percent escapes in the path; a provider may echo the decoded segment.
        try { parts.add(decodeURIComponent(segment)); } catch { /* a malformed escape: the raw segment is enough */ }
      }
    }
    if (u.username !== '') parts.add(u.username);
    if (u.password !== '') parts.add(u.password);
  }
  for (const p of [...parts]) for (const e of encodedForms(p)) parts.add(e);
  return [...parts].sort((a, b) => b.length - a.length);       // longest first, so a URL is replaced before its parts
}

/** Returns a scrubber for the given URLs: secret substrings and keyed query parameters become `[redacted]`. */
export function scrubberFor(urls: readonly string[]): (text: string) => string {
  const parts = [...new Set(urls.flatMap(secretParts))].filter((p) => p.length > 0).sort((a, b) => b.length - a.length);
  return (text: string): string => {
    let out = text;
    for (const p of parts) out = out.split(p).join(REDACTED);
    out = out.replace(KEYED_QUERY, (_m, sep: string, name: string) => `${sep}${name}=${REDACTED}`);
    return out.length > MAX_PROVIDER_MESSAGE ? out.slice(0, MAX_PROVIDER_MESSAGE) : out;
  };
}
