/**
 * The worker's address on the owner's tailnet (docs/ARCHITECTURE.md §17). The worker listens on
 * loopback and `tailscale serve` publishes it over HTTPS as https://<machine>.<tailnet>.ts.net,
 * so only that shape is accepted. Only the address is stored: no key, token or password, and the
 * app only ever sends GET requests to it (read-only).
 */

export type ServerError = 'empty' | 'not-url' | 'not-https' | 'not-tailnet' | 'extra';

export type ParsedServer = { ok: true; origin: string } | { ok: false; error: ServerError };

/** Messages under the address field. */
export const SERVER_ERROR_TEXT: Record<ServerError, string> = {
  empty: 'Enter the server address.',
  'not-url': 'Not a web address.',
  'not-https': 'Use an https:// address.',
  'not-tailnet': 'Use your tailnet address, ending in .ts.net.',
  extra: 'Enter the address only, with no path, login or query.',
};

// <machine>.<tailnet>.ts.net: at least two labels before ts.net, each a DNS label.
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export function parseServer(input: string): ParsedServer {
  const text = input.trim();
  if (text === '') return { ok: false, error: 'empty' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: 'not-url' };
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'not-https' };
  // A login, path, query or fragment could carry a secret or point elsewhere; the address is the origin only.
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return { ok: false, error: 'extra' };
  const labels = url.hostname.toLowerCase().split('.');
  if (labels.length < 4 || labels.at(-1) !== 'net' || labels.at(-2) !== 'ts' || !labels.slice(0, -2).every((l) => LABEL.test(l))) {
    return { ok: false, error: 'not-tailnet' };
  }
  return { ok: true, origin: url.origin };
}

const SERVER_KEY = 'zeroed.server';
const SEEN_KEY = 'zeroed.serverSeen';

/** Storage the app can read and write; localStorage in the app. Every access may throw (blocked storage). */
export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function store(): KeyValue | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The saved address, checked again on every read; anything that fails the check counts as not set. */
export function loadServer(kv: KeyValue | null = store()): string | null {
  try {
    const raw = kv?.getItem(SERVER_KEY);
    if (!raw) return null;
    const parsed = parseServer(raw);
    return parsed.ok ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** Saves a checked origin. Returns false when storage is blocked (the address then lasts for this visit). */
export function saveServer(origin: string, kv: KeyValue | null = store()): boolean {
  const parsed = parseServer(origin);
  if (!parsed.ok) throw new Error('saveServer needs a checked address');
  try {
    if (!kv) return false;
    if (kv.getItem(SERVER_KEY) !== parsed.origin) kv.removeItem(SEEN_KEY);
    kv.setItem(SERVER_KEY, parsed.origin);
    return true;
  } catch {
    return false;
  }
}

export function clearServer(kv: KeyValue | null = store()): void {
  try {
    kv?.removeItem(SERVER_KEY);
    kv?.removeItem(SEEN_KEY);
  } catch {
    // Blocked storage held nothing.
  }
}

/** When the server last answered, kept so "Offline" can show the last update after a restart. */
export function loadSeen(origin: string, kv: KeyValue | null = store()): string | null {
  try {
    const raw = kv?.getItem(SEEN_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object') return null;
    const { origin: o, at } = v as { origin?: unknown; at?: unknown };
    return o === origin && typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? at : null;
  } catch {
    return null;
  }
}

export function saveSeen(origin: string, at: string, kv: KeyValue | null = store()): void {
  try {
    kv?.setItem(SEEN_KEY, JSON.stringify({ origin, at }));
  } catch {
    // Blocked storage: the time lasts for this visit only.
  }
}
