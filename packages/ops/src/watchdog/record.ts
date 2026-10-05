// RECORD-UPLOAD (owner, 2026-10-06 "Approve upload"): the server's sealed recordings go, one file per request, to GitHub
// Release assets in the private data repository (DATA_REPO, the one the daily summary uses). The route runs in the outer
// Worker fetch and never reads the body: it checks the signed header, takes a one-use nonce from the Durable Object,
// checks the destination, then pipes the body behind a fixed length to uploads.github.com and reads the asset back by id
// (the upload's reply is never trusted). Free plan: a 100 MB request body (capped here at 95 MB), 10 ms CPU (fetch waits
// do not count; a native pipe uses none), 50 subrequests (one file uses at most about 20).
//
// Header `x-zeroed-record`: JSON {v, op, t, nonce, day, release, boot, file, size, sha256, asset_id?}, signed with the
// heartbeat key in `x-zeroed-signature` over "t\nRECORD\n/record\n<header>". RECORD is a method word no HTTP request
// uses, so a heartbeat's (POST) signature never verifies here and this one never verifies as a heartbeat.
import { signedText, verifySignature } from './logic.ts';
import { checkDestination, type ReportsEnv } from './reports.ts';

export const RECORD_PATH = '/record';
export const RECORD_METHOD = 'RECORD';
/** Under the free plan's 100 MB request body. */
export const RECORD_MAX_BYTES = 95_000_000;
const HEADER_MAX = 2048;
const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';
const TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 600_000;
/** GitHub allows 1000 assets per release; listing stops there. */
const MAX_LIST_PAGES = 10;

export interface RecordEnv extends ReportsEnv {
  readonly HEARTBEAT_HMAC_KEY?: string | undefined;
  /** The upload host (a test stand-in in the ops end-to-end); uploads.github.com when unset. */
  readonly GITHUB_UPLOADS?: string | undefined;
}

export interface RecordHeader {
  readonly v: 1;
  readonly op: 'put' | 'check';
  readonly t: number;
  readonly nonce: string;
  readonly day: string;
  readonly release: string;
  /** The boot a boot file belongs to; null for a day file (journal, index). */
  readonly boot: string | null;
  readonly file: string;
  readonly size: number;
  readonly sha256: string;
  /** op check: the asset to read back. */
  readonly asset_id?: number;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface RecordDeps {
  readonly fetch: Fetch;
  /** Marks the nonce used; false when it was used before (or the store refused). */
  readonly takeNonce: (nonce: string, t: number) => Promise<boolean>;
  /** The body behind a fixed length (Workers' FixedLengthStream), so the upload carries a Content-Length. Never awaited. */
  readonly fixedLength: (body: ReadableStream<Uint8Array>, size: number) => ReadableStream<Uint8Array>;
  readonly nowS: () => number;
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const KEYS = new Set(['v', 'op', 't', 'nonce', 'day', 'release', 'boot', 'file', 'size', 'sha256', 'asset_id']);
const BOOT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const BOOT_FILE_RE = /^(?:(?:frames|releases)-\d{3}\.jsonl\.zst|manifest\.json|deployer-state\.json(?:\.zst)?)$/;
const JOURNAL_RE = /^journal-(\d{4}-\d{2}-\d{2})\.jsonl\.zst$/;
const INDEX_RE = /^index-[1-9]\d{0,5}\.json$/;

const isDay = (d: unknown): d is string => {
  if (typeof d !== 'string' || !DAY_RE.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
};

/**
 * The header's shape, strictly: exact keys, the file allowlist (frames, releases, manifest, the saved-state attachment,
 * a day's journal, a day's index; never raw or delays), the release of the header's day, a size within the body limit.
 */
export const parseRecordHeader = (text: string): RecordHeader | null => {
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const h = x as Record<string, unknown>;
  if (!Object.keys(h).every((k) => KEYS.has(k))) return null;
  if (h['v'] !== 1 || (h['op'] !== 'put' && h['op'] !== 'check')) return null;
  if (!Number.isSafeInteger(h['t']) || (h['t'] as number) <= 0) return null;
  if (typeof h['nonce'] !== 'string' || !/^[0-9a-f]{32}$/.test(h['nonce'])) return null;
  if (!isDay(h['day'])) return null;
  const day = h['day'];
  const rel = typeof h['release'] === 'string' ? /^rec-(\d{4}-\d{2}-\d{2})(?:\.[1-9]\d?)?$/.exec(h['release']) : null;
  if (rel === null || rel[1] !== day) return null;
  if (typeof h['file'] !== 'string') return null;
  const file = h['file'];
  const boot = h['boot'];
  if (boot === null) {
    const j = JOURNAL_RE.exec(file);
    if (!(INDEX_RE.test(file) || (j !== null && j[1] === day))) return null;
  } else {
    if (typeof boot !== 'string' || !BOOT_RE.test(boot) || !BOOT_FILE_RE.test(file)) return null;
  }
  if (!Number.isSafeInteger(h['size']) || (h['size'] as number) < 1 || (h['size'] as number) > RECORD_MAX_BYTES) return null;
  if (typeof h['sha256'] !== 'string' || !/^[0-9a-f]{64}$/.test(h['sha256'])) return null;
  if (h['op'] === 'check') {
    if (!Number.isSafeInteger(h['asset_id']) || (h['asset_id'] as number) < 1) return null;
  } else if (h['asset_id'] !== undefined) {
    return null;
  }
  return h as unknown as RecordHeader;
};

/** The asset name: `<boot>.<file>` for a boot's file, the file name alone for a day file. */
export const assetName = (h: Pick<RecordHeader, 'boot' | 'file'>): string => (h.boot === null ? h.file : `${h.boot}.${h.file}`);

/** The text the host signs: the header as sent, under the RECORD method word. */
export const recordSignedText = (t: number, header: string): string => signedText(t, RECORD_METHOD, RECORD_PATH, header);

const ghHeaders = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'zeroed-watchdog',
});

interface Asset {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly state: string;
  readonly digest: string | null;
  readonly browser_download_url: string;
}

const asAsset = (x: unknown): Asset | null => {
  if (typeof x !== 'object' || x === null) return null;
  const a = x as Record<string, unknown>;
  if (!Number.isSafeInteger(a['id']) || typeof a['name'] !== 'string' || !Number.isSafeInteger(a['size']) || typeof a['state'] !== 'string') return null;
  return {
    id: a['id'] as number, name: a['name'], size: a['size'] as number, state: a['state'],
    digest: typeof a['digest'] === 'string' ? a['digest'] : null,
    browser_download_url: typeof a['browser_download_url'] === 'string' ? a['browser_download_url'] : '',
  };
};

/** What the host is told about an asset: never the token, the repository or a URL. */
const view = (a: Asset) => ({ asset_id: a.id, name: a.name, size: a.size, state: a.state, digest: a.digest });

/** Exactly the signed bytes, finished. */
const sameBytes = (a: Asset, h: RecordHeader): boolean => a.state === 'uploaded' && a.size === h.size && a.digest === `sha256:${h.sha256}`;

class GitHub {
  readonly #f: Fetch;
  readonly #api: string;
  readonly #uploads: string;
  readonly #repo: string;
  readonly #token: string;

  constructor(f: Fetch, api: string, uploads: string, repo: string, token: string) {
    this.#f = f;
    this.#api = api;
    this.#uploads = uploads;
    this.#repo = repo;
    this.#token = token;
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await this.#f(`${this.#api}/repos/${this.#repo}${path}`, {
      method,
      headers: { ...ghHeaders(this.#token), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let j: unknown = null;
    if (res.status !== 204) {
      try {
        j = await res.json();
      } catch {
        j = null;
      }
    }
    return { status: res.status, json: j };
  }

  /** The day's release, created as a prerelease that never becomes "latest" when it is not there yet. */
  async release(tag: string, day: string): Promise<{ id: number; assets: Asset[] } | string> {
    const read = async (): Promise<{ id: number; assets: Asset[] } | number> => {
      const r = await this.call('GET', `/releases/tags/${encodeURIComponent(tag)}`);
      if (r.status !== 200) return r.status;
      const j = r.json as { id?: unknown; assets?: unknown };
      if (!Number.isSafeInteger(j?.id)) return 502;
      const assets = Array.isArray(j.assets) ? j.assets.map(asAsset).filter((a): a is Asset => a !== null) : [];
      return { id: j.id as number, assets };
    };
    const got = await read();
    if (typeof got !== 'number') return got;
    if (got !== 404) return `release read HTTP ${got}`;
    const c = await this.call('POST', '/releases', {
      tag_name: tag, name: tag, body: `Zeroed server recordings, UTC day ${day}.`, prerelease: true, make_latest: 'false',
    });
    if (c.status === 201) {
      const id = (c.json as { id?: unknown } | null)?.id;
      return Number.isSafeInteger(id) ? { id: id as number, assets: [] } : 'release create unreadable';
    }
    // Created at the same moment by another request: read it again.
    if (c.status === 422) {
      const again = await read();
      return typeof again === 'number' ? `release read HTTP ${again}` : again;
    }
    return `release create HTTP ${c.status}`;
  }

  async asset(id: number): Promise<Asset | number> {
    const r = await this.call('GET', `/releases/assets/${id}`);
    if (r.status !== 200) return r.status;
    return asAsset(r.json) ?? 502;
  }

  async remove(id: number): Promise<boolean> {
    const r = await this.call('DELETE', `/releases/assets/${id}`);
    return r.status === 204 || r.status === 404;
  }

  async findByName(releaseId: number, name: string): Promise<Asset | null | number> {
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      const r = await this.call('GET', `/releases/${releaseId}/assets?per_page=100&page=${page}`);
      if (r.status !== 200) return r.status;
      const list = Array.isArray(r.json) ? r.json.map(asAsset).filter((a): a is Asset => a !== null) : [];
      const hit = list.find((a) => a.name === name);
      if (hit) return hit;
      if (list.length < 100) return null;
    }
    return null;
  }

  async upload(releaseId: number, name: string, body: ReadableStream<Uint8Array>, size: number): Promise<{ status: number; id: number | null }> {
    const res = await this.#f(`${this.#uploads}/repos/${this.#repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { ...ghHeaders(this.#token), 'content-type': 'application/octet-stream', 'content-length': String(size) },
      body,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    let id: number | null = null;
    try {
      const j = (await res.json()) as { id?: unknown };
      id = Number.isSafeInteger(j?.id) ? (j.id as number) : null;
    } catch {}
    return { status: res.status, id };
  }
}

/**
 * POST /record. Order: signature over the header (nothing else is read before it), header shape, nonce, destination,
 * then the operation. Every failure is a short reason that names no value.
 */
export async function handleRecord(req: Request, env: RecordEnv, d: RecordDeps): Promise<Response> {
  const text = req.headers.get('x-zeroed-record') ?? '';
  if (text === '' || text.length > HEADER_MAX) return json({ error: 'bad header' }, 400);
  const t = await verifySignature(req.headers.get('x-zeroed-signature'), RECORD_METHOD, RECORD_PATH, text, env.HEARTBEAT_HMAC_KEY ?? '', d.nowS());
  if (t === null) return json({ error: 'bad signature' }, 401);
  const h = parseRecordHeader(text);
  if (h === null || h.t !== t) return json({ error: 'bad header' }, 400);
  if (h.op === 'put') {
    const len = req.headers.get('content-length');
    if (req.body === null || (len !== null && len !== String(h.size))) return json({ error: 'body length differs from the signed size' }, 400);
  }
  if (!(await d.takeNonce(h.nonce, t))) return json({ error: 'replayed request' }, 409);
  const dest = await checkDestination(env, d.fetch, TIMEOUT_MS);
  if (!dest.ok || dest.repo === undefined) return json({ error: dest.ok ? 'no repository' : dest.reason }, 503);
  const gh = new GitHub(d.fetch, env.GITHUB_API ?? API, env.GITHUB_UPLOADS ?? UPLOADS, dest.repo, env.REPORTS_TOKEN ?? '');
  const name = assetName(h);
  try {
    return h.op === 'check' ? await check(gh, h, name) : await put(gh, h, name, req.body as ReadableStream<Uint8Array>, d);
  } catch {
    return json({ error: 'GitHub did not answer' }, 502);
  }
}

/** op check: the asset by id, under the signed name and in the signed release; the host's delete gate reads this. */
async function check(gh: GitHub, h: RecordHeader, name: string): Promise<Response> {
  const a = await gh.asset(h.asset_id!);
  if (typeof a === 'number') return json({ error: a === 404 ? 'no such asset' : `asset read HTTP ${a}` }, a === 404 ? 404 : 502);
  if (a.name !== name || !a.browser_download_url.includes(`/releases/download/${h.release}/`) || !a.browser_download_url.endsWith(`/${name}`)) {
    return json({ error: 'asset is not the signed name in the signed release' }, 409);
  }
  return json({ ok: true, ...view(a), match: sameBytes(a, h) });
}

async function put(gh: GitHub, h: RecordHeader, name: string, body: ReadableStream<Uint8Array>, d: RecordDeps): Promise<Response> {
  const rel = await gh.release(h.release, h.day);
  if (typeof rel === 'string') return json({ error: rel }, 502);
  // Already there (a reply lost on the way back): the same finished bytes count as uploaded, without sending them again;
  // an unfinished one is removed first and the body (not read yet) is sent now.
  const listed = rel.assets.find((a) => a.name === name);
  if (listed !== undefined) {
    const r = await existing(gh, h, listed.id);
    if (r instanceof Response) return r;
  }
  const up = await gh.upload(rel.id, name, d.fixedLength(body, h.size), h.size);
  if (up.status === 422) {
    // The body is spent: whatever is found, a removed unfinished upload is sent again by the host.
    const found = await gh.findByName(rel.id, name);
    if (typeof found === 'number') return json({ error: `asset list HTTP ${found}` }, 502);
    if (found === null) return json({ error: 'upload refused (HTTP 422)' }, 502);
    const r = await existing(gh, h, found.id);
    if (r instanceof Response) return r;
    return json({ error: r === 'removed' ? 'an unfinished upload was removed; send again' : 'the asset went away while read; send again', retry: true }, 503);
  }
  if (up.status !== 201 || up.id === null) return json({ error: `upload HTTP ${up.status}` }, 502);
  return verifyNew(gh, h, up.id);
}

/**
 * A name that exists: the same finished bytes are uploaded (a reply); a finished file with other bytes is never replaced
 * (a refusal); an unfinished upload is deleted ('removed'); 'gone' when the asset no longer exists.
 */
async function existing(gh: GitHub, h: RecordHeader, id: number): Promise<Response | 'removed' | 'gone'> {
  const a = await gh.asset(id);
  if (a === 404) return 'gone';
  if (typeof a === 'number') return json({ error: `asset read HTTP ${a}` }, 502);
  if (sameBytes(a, h)) return json({ ok: true, existed: true, ...view(a) });
  if (a.state !== 'uploaded') return (await gh.remove(a.id)) ? 'removed' : json({ error: 'an unfinished upload could not be removed', ...view(a) }, 502);
  if (a.digest === null) return json({ error: 'GitHub gave no digest for the existing asset', ...view(a) }, 502);
  return json({ error: 'a different file already has this name; it is never replaced', ...view(a) }, 409);
}

/** A fresh upload, read back by id: kept only as exactly the signed bytes; a missing digest keeps it and reports. */
async function verifyNew(gh: GitHub, h: RecordHeader, id: number): Promise<Response> {
  const a = await gh.asset(id);
  if (typeof a === 'number') return json({ error: `asset read HTTP ${a}`, asset_id: id }, 502);
  if (a.digest === null) return json({ error: 'GitHub gave no digest; the asset is kept and the file is not counted as uploaded', ...view(a) }, 502);
  if (sameBytes(a, h) && a.name === assetName(h)) return json({ ok: true, ...view(a) });
  const gone = await gh.remove(a.id);
  return json({ error: `uploaded bytes differ from the signed file; ${gone ? 'asset deleted' : 'asset could not be deleted'}`, ...view(a) }, 422);
}

/** Nonces live 15 minutes: longer than the 5-minute signature window on either side. */
export const NONCE_TTL_S = 900;
const NONCE_MAX = 20_000;

/** The Durable Object's nonce book: one map, pruned on every call. Null when the nonce was used (or the book is full). */
export const takeNonceIn = (book: Record<string, number>, nonce: string, t: number, nowS: number): Record<string, number> | null => {
  const next: Record<string, number> = {};
  for (const [n, at] of Object.entries(book)) if (at >= nowS - NONCE_TTL_S) next[n] = at;
  if (Object.hasOwn(next, nonce) || Object.keys(next).length >= NONCE_MAX) return null;
  next[nonce] = t;
  return next;
};
