// RECORD-UPLOAD test stand-ins: api.github.com and uploads.github.com for one private repository, in memory, and the
// watchdog Worker with its Durable Object (the nonce book) wired to them. Shared by the watchdog and host uploader tests.
import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { Watchdog, type DurableState, type Env } from '../src/watchdog/worker.ts';

export const KEY = 'test-hmac-key-0123456789abcdef';
export const REPO = 'owner-x/zeroed-data';
const API = 'https://gh.test';
const UP = 'https://up.test';
export const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

export interface FakeAsset { id: number; name: string; size: number; state: string; digest: string | null; browser_download_url: string; release: number; bytes: Uint8Array }

/** api.github.com and uploads.github.com for one repository, in memory. Knobs bend what GitHub does. */
export function fakeGitHub(meta: { full_name?: string; private?: boolean } = {}) {
  const releases = new Map<string, { id: number; tag: string; body: Record<string, unknown> }>();
  const assets = new Map<number, FakeAsset>();
  const calls: string[] = [];
  const knobs = { corrupt: false, noDigest: false, unfinished: false, wrongSize: false };
  let nextId = 100;
  const res = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });
  const view = (a: FakeAsset) => ({ id: a.id, name: a.name, size: a.size, state: a.state, digest: a.digest, browser_download_url: a.browser_download_url });
  const f = vi.fn(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    calls.push(`${method} ${u.origin === UP ? 'UP ' : ''}${u.pathname}${u.search}`);
    const base = `/repos/${REPO}`;
    if (u.origin === API && u.pathname === base && method === 'GET') return res(200, { full_name: meta.full_name ?? REPO, private: meta.private ?? true });
    let m: RegExpExecArray | null;
    if (u.origin === API && (m = new RegExp(`^${base}/releases/tags/([^/]+)$`).exec(u.pathname))) {
      const r = releases.get(decodeURIComponent(m[1]!));
      if (!r) return res(404, { message: 'Not Found' });
      return res(200, { id: r.id, tag_name: r.tag, assets: [...assets.values()].filter((a) => a.release === r.id).map(view) });
    }
    if (u.origin === API && u.pathname === `${base}/releases` && method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const tag = String(body['tag_name']);
      if (releases.has(tag)) return res(422, { message: 'Validation Failed', errors: [{ code: 'already_exists' }] });
      const r = { id: nextId++, tag, body };
      releases.set(tag, r);
      return res(201, { id: r.id, tag_name: tag });
    }
    if (u.origin === API && (m = new RegExp(`^${base}/releases/assets/(\\d+)$`).exec(u.pathname))) {
      const a = assets.get(Number(m[1]));
      if (!a) return res(404, { message: 'Not Found' });
      if (method === 'DELETE') {
        assets.delete(a.id);
        return res(204);
      }
      return res(200, view(a));
    }
    if (u.origin === API && (m = new RegExp(`^${base}/releases/(\\d+)/assets$`).exec(u.pathname))) {
      const page = Number(u.searchParams.get('page') ?? 1);
      const list = [...assets.values()].filter((a) => a.release === Number(m![1])).map(view);
      return res(200, list.slice((page - 1) * 100, page * 100));
    }
    if (u.origin === UP && (m = new RegExp(`^${base}/releases/(\\d+)/assets$`).exec(u.pathname)) && method === 'POST') {
      const rid = Number(m[1]);
      const tag = [...releases.values()].find((r) => r.id === rid)?.tag;
      const name = u.searchParams.get('name') ?? '';
      const bytes = new Uint8Array(await new Response(init.body as ReadableStream).arrayBuffer());
      if (tag === undefined) return res(404, { message: 'Not Found' });
      if ([...assets.values()].some((a) => a.release === rid && a.name === name)) return res(422, { message: 'Validation Failed', errors: [{ resource: 'ReleaseAsset', code: 'already_exists', field: 'name' }] });
      const stored = knobs.corrupt ? new Uint8Array([...bytes, 0]) : bytes;
      const a: FakeAsset = {
        id: nextId++, name, release: rid, bytes: stored, size: knobs.wrongSize ? stored.length + 1 : stored.length, state: knobs.unfinished ? 'starter' : 'uploaded',
        digest: knobs.noDigest ? null : `sha256:${sha(stored)}`, browser_download_url: `https://github.com/${REPO}/releases/download/${tag}/${name}`,
      };
      assets.set(a.id, a);
      return res(201, view(a));
    }
    return res(404, { message: 'Not Found' });
  });
  return { f, releases, assets, calls, knobs };
}

/** The Worker with its Durable Object (nonce book) behind a stub, and fetch going to the fake GitHub. */
export function rig(gh = fakeGitHub(), envOver: Partial<Env> = {}) {
  const mem = new Map<string, unknown>();
  const state: DurableState = { storage: { get: async <T>(k: string) => mem.get(k) as T | undefined, put: async (k, v) => void mem.set(k, structuredClone(v)) }, blockConcurrencyWhile: (fn) => fn() };
  const doPaths: string[] = [];
  let dob: Watchdog;
  const env = {
    HEARTBEAT_HMAC_KEY: KEY, DATA_REPO: REPO, REPORTS_TOKEN: 'github_pat_TEST', GITHUB_API: API, GITHUB_UPLOADS: UP, ...envOver,
    WATCHDOG: { idFromName: () => 'id', get: () => ({ fetch: (r: Request) => (doPaths.push(new URL(r.url).pathname), dob.fetch(r)) }) },
  } as unknown as Env;
  dob = new Watchdog(state, env);
  vi.stubGlobal('fetch', gh.f);
  // Workers' FixedLengthStream: errors when the body is shorter or longer than the length.
  vi.stubGlobal('FixedLengthStream', class {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    constructor(n: number) {
      let seen = 0;
      const ts = new TransformStream<Uint8Array, Uint8Array>({
        transform(c, ctl) {
          seen += c.length;
          if (seen > n) throw new Error('too long');
          ctl.enqueue(c);
        },
        flush() {
          if (seen !== n) throw new Error('too short');
        },
      });
      this.readable = ts.readable;
      this.writable = ts.writable;
    }
  });
  return { gh, env, mem, doPaths };
}
