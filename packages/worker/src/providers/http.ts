// The I/O seams every adapter takes: HTTP, WebSocket and secrets. Each is an interface, so tests run on recorded
// frames with no network, and the fault tests (TEST-3) swap in timeouts, 429s, stale streams and disconnects.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface HttpRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
}

export interface HttpResponse {
  readonly status: number;
  header(name: string): string | null;
  readonly text: string;
}

export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;

/** Node 22's global fetch, with the request's own timeout. */
export const fetchHttp: HttpClient = async (req) => {
  const init: RequestInit = { method: req.method, signal: AbortSignal.timeout(req.timeoutMs) };
  if (req.headers) init.headers = { ...req.headers };
  if (req.body !== undefined) init.body = req.body;
  const res = await fetch(req.url, init);
  const text = await res.text();
  return { status: res.status, header: (name) => res.headers.get(name), text };
};

/** The subset of the WHATWG WebSocket the adapters use. Node 22 has a global `WebSocket` with this shape. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { readonly data: unknown }) => void) | null;
  onclose: ((ev: { readonly code: number; readonly reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export const globalSocketFactory: SocketFactory = (url) => {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket;
  if (Ctor === undefined) throw new Error('this runtime has no global WebSocket (Node 22 or later is required)');
  return new Ctor(url);
};

export type SecretName = 'HELIUS_API_KEY' | 'ALCHEMY_API_KEY' | 'JUPITER_API_KEY';
const SECRET_NAMES: ReadonlySet<string> = new Set<SecretName>(['HELIUS_API_KEY', 'ALCHEMY_API_KEY', 'JUPITER_API_KEY']);

/** Keys are read when a request is built and never stored in frames, logs or errors. */
export interface Secrets {
  get(name: SecretName): string;
}

/**
 * Keys from systemd credentials (`LoadCredentialEncrypted=`, OPS-1): one file per key in the unit's
 * `$CREDENTIALS_DIRECTORY`. The directory is passed in; this module never reads the environment.
 */
export const credentialsDirectorySecrets = (dir: string): Secrets => ({
  get: (name) => {
    if (!SECRET_NAMES.has(name)) throw new RangeError('unknown secret name');
    const v = readFileSync(join(dir, name), 'utf8').trim();
    if (v.length === 0) throw new Error(`credential ${name} is empty`);
    return v;
  },
});

/** Removes every known key from a message, so no error or log line can carry one. */
export const scrub = (text: string, secrets: Secrets, names: readonly SecretName[]): string => {
  let out = text;
  for (const n of names) {
    let v: string;
    try {
      v = secrets.get(n);
    } catch {
      continue;
    }
    if (v.length > 0) out = out.split(v).join('***');
  }
  return out;
};

/** A provider request failed. The message never holds a URL or a key. */
export class ProviderError extends Error {
  readonly provider: string;
  readonly kind: 'timeout' | 'network' | 'http' | 'rate_limited' | 'rpc' | 'shape';
  readonly status: number | null;
  constructor(provider: string, kind: ProviderError['kind'], message: string, status: number | null = null) {
    super(`${provider}: ${message}`);
    this.name = 'ProviderError';
    this.provider = provider;
    this.kind = kind;
    this.status = status;
  }
}

/** Sends a request and turns transport failures into a `ProviderError` that names no URL. */
export const send = async (http: HttpClient, provider: string, what: string, req: HttpRequest): Promise<HttpResponse> => {
  try {
    return await http(req);
  } catch (e) {
    const name = (e as { name?: unknown }).name;
    if (name === 'TimeoutError' || name === 'AbortError') throw new ProviderError(provider, 'timeout', `${what} timed out after ${req.timeoutMs} ms`);
    throw new ProviderError(provider, 'network', `${what} failed (${typeof name === 'string' ? name : 'error'})`);
  }
};

export const parseJson = (provider: string, what: string, text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderError(provider, 'shape', `${what} returned invalid JSON`);
  }
};
