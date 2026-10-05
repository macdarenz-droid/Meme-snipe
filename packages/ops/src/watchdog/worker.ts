// Cloudflare Worker entry: routes requests and the minute cron to the single Watchdog Durable Object.
// Types are declared here (no @cloudflare/workers-types dependency); only what this file uses.
import {
  evaluate,
  isNewer,
  limitsFrom,
  parseCommand,
  parseHeartbeat,
  planAlerts,
  statusText,
  takeLease,
  sameText,
  verifySignature,
  type ActiveAlert,
  type ChainView,
  type Lease,
  type Stored,
  summaryAlert,
} from './logic.ts';
import { handleRecord, RECORD_PATH, takeNonceIn } from './record.ts';
import { writeReports } from './reports.ts';
import { checkSummary } from './summary.ts';

interface DurableStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}
export interface DurableState {
  storage: DurableStorage;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}
interface DurableStub {
  fetch(req: Request): Promise<Response>;
}
interface DurableNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableStub;
}
interface ExecutionContext {
  waitUntil(p: Promise<unknown>): void;
}
/** Workers' identity stream that sets the body length (an upload to GitHub needs a Content-Length). */
declare const FixedLengthStream: new (length: number) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };

export interface Env {
  WATCHDOG: DurableNamespace;
  HEARTBEAT_HMAC_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_API?: string;
  CHAIN_RPC_URL?: string;
  CHAIN_TIMEOUT_MS?: string;
  /** OPS-SUMMARY: the private reports repository (owner/name, a plain var) and its fine-grained token (a secret). */
  DATA_REPO?: string;
  REPORTS_TOKEN?: string;
  GITHUB_API?: string;
  /** RECORD-UPLOAD: the upload host; uploads.github.com when unset (a stand-in only in the ops end-to-end). */
  GITHUB_UPLOADS?: string;
  [k: string]: unknown;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const WSOL = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    // RECORD-UPLOAD runs here, outside the Durable Object, so the body is never read: only piped on to GitHub.
    if (req.method === 'POST' && pathname === RECORD_PATH) return handleRecord(req, env, recordDeps(env));
    if (req.method !== 'POST' || !['/heartbeat', '/telegram', '/lease', '/resume', '/summary'].includes(pathname)) return new Response('Not found', { status: 404 });
    return env.WATCHDOG.get(env.WATCHDOG.idFromName('primary')).fetch(req);
  },
  async scheduled(_event: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    const stub = env.WATCHDOG.get(env.WATCHDOG.idFromName('primary'));
    ctx.waitUntil(stub.fetch(new Request('https://watchdog.internal/check', { method: 'POST' })));
  },
};

const recordDeps = (env: Env) => ({
  fetch: (u: string, i: RequestInit) => fetch(u, i),
  // The nonce book is in the Durable Object, on a path the public fetch above never routes.
  takeNonce: async (nonce: string, t: number) => {
    const stub = env.WATCHDOG.get(env.WATCHDOG.idFromName('primary'));
    const r = await stub.fetch(new Request('https://watchdog.internal/record-nonce', { method: 'POST', body: JSON.stringify({ nonce, t }) }));
    return r.status === 200;
  },
  fixedLength: (body: ReadableStream<Uint8Array>, size: number) => {
    const { readable, writable } = new FixedLengthStream(size);
    // Not awaited: the upload reads the other end. A short or long body errors the stream, and the upload fails.
    body.pipeTo(writable).catch(() => {});
    return readable;
  },
  nowS: () => Math.floor(Date.now() / 1000),
});

export class Watchdog {
  private readonly state: DurableState;
  private readonly env: Env;

  constructor(state: DurableState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === '/check') return json(await this.check(Date.now()));
    const body = await req.text();
    if (pathname === '/record-nonce') return this.recordNonce(body);
    if (pathname === '/telegram') return this.telegram(req, body);
    // The signature covers method and path too, so a heartbeat's signature can never open /resume.
    const t = await verifySignature(req.headers.get('x-zeroed-signature'), req.method, pathname, body, this.env.HEARTBEAT_HMAC_KEY ?? '', Math.floor(Date.now() / 1000));
    if (t === null) return json({ error: 'bad signature' }, 401);
    if (pathname === '/heartbeat') return this.heartbeat(body);
    if (pathname === '/lease') return this.lease(body);
    if (pathname === '/resume') return this.resume(t);
    if (pathname === '/summary') return this.summary(t, body);
    return new Response('Not found', { status: 404 });
  }

  private async heartbeat(body: string): Promise<Response> {
    const hb = parseHeartbeat(body);
    if (!hb) return json({ error: 'bad heartbeat' }, 400);
    const prev = await this.state.storage.get<Stored>('hb');
    if (!isNewer(prev, hb)) return json({ error: 'replayed heartbeat' }, 409);
    await this.state.storage.put('hb', { hb, receivedAt: Date.now() } satisfies Stored);
    // The owner's chat comes only from the server's signed heartbeat (paired there with /pair).
    if (typeof hb.owner_chat_id === 'string' && /^-?\d{1,20}$/.test(hb.owner_chat_id)) await this.state.storage.put('owner_chat', hb.owner_chat_id);
    const paused = await this.state.storage.get<{ at: number }>('paused');
    return json({ ok: true, paused: Boolean(paused) });
  }

  /**
   * OPS-SUMMARY: a signed daily summary from the worker. Checked again here (shape and forbidden patterns), then written
   * to the private reports repository. A failed write is stored as the "summary" alert for the next check and never
   * changes the heartbeat, the pause or the lease. The reply only says whether it was written; the worker ignores it.
   */
  private async summary(t: number, body: string): Promise<Response> {
    const last = (await this.state.storage.get<number>('last_summary_t')) ?? 0;
    if (t <= last) return json({ error: 'replayed summary' }, 409);
    const c = checkSummary(body);
    if (!c.ok) {
      await this.state.storage.put('summary_failure', { reason: `refused (${c.reason})`, at: Date.now() });
      return json({ error: 'bad summary' }, 400);
    }
    await this.state.storage.put('last_summary_t', t);
    // Not set up yet (neither the repository nor the token): nothing to write and nothing to alert. One of the two
    // without the other is a broken setup and alerts below.
    if (!this.env.DATA_REPO && !this.env.REPORTS_TOKEN) {
      // A failure stored before the setup was removed must not keep alerting.
      await this.state.storage.put('summary_failure', null);
      return json({ ok: true, written: false });
    }
    // latest.json only moves forward: a late final for yesterday never replaces today's.
    const latestDay = (await this.state.storage.get<string>('summary_latest_day')) ?? '';
    const env = { DATA_REPO: this.env.DATA_REPO, REPORTS_TOKEN: this.env.REPORTS_TOKEN, GITHUB_API: this.env.GITHUB_API };
    const r = await writeReports(env, c.summary.day, c.text, (u, i) => fetch(u, i), 10_000, c.summary.day >= latestDay);
    if (r.ok) {
      if (c.summary.day > latestDay) await this.state.storage.put('summary_latest_day', c.summary.day);
      await this.state.storage.put('summary_failure', null);
    } else {
      await this.state.storage.put('summary_failure', { reason: r.reason, at: Date.now() });
    }
    return json({ ok: true, written: r.ok });
  }

  /** RECORD-UPLOAD: one use per nonce. Reached only from the outer fetch (never routed from outside). */
  private async recordNonce(body: string): Promise<Response> {
    let r: { nonce?: unknown; t?: unknown };
    try {
      r = JSON.parse(body) as typeof r;
    } catch {
      return json({ error: 'bad request' }, 400);
    }
    if (typeof r.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(r.nonce) || !Number.isSafeInteger(r.t)) return json({ error: 'bad request' }, 400);
    const next = takeNonceIn((await this.state.storage.get<Record<string, number>>('record_nonces')) ?? {}, r.nonce, r.t as number, Math.floor(Date.now() / 1000));
    if (next === null) return json({ error: 'used' }, 409);
    await this.state.storage.put('record_nonces', next);
    return json({ ok: true });
  }

  private async lease(body: string): Promise<Response> {
    let req: { holder?: unknown; ttl_s?: unknown };
    try {
      req = JSON.parse(body) as typeof req;
    } catch {
      return json({ error: 'bad request' }, 400);
    }
    const cur = (await this.state.storage.get<Lease>('lease')) ?? null;
    const r = takeLease(cur, String(req.holder ?? ''), Number(req.ttl_s), Date.now());
    if (r.granted) await this.state.storage.put('lease', r.lease);
    return json({ granted: r.granted, lease: r.lease }, r.granted ? 200 : 409);
  }

  /** Clearing a pause comes only from the host (HMAC-signed, run by the owner at the host console). */
  private async resume(t: number): Promise<Response> {
    // Single use: each resume carries a newer timestamp than the last accepted one.
    const last = (await this.state.storage.get<number>('last_resume_t')) ?? 0;
    if (t <= last) return json({ error: 'replayed resume' }, 401);
    await this.state.storage.put('last_resume_t', t);
    await this.state.storage.put('paused', null);
    await this.say('Entries allowed again (cleared from the host).');
    return json({ ok: true, paused: false });
  }

  private async telegram(req: Request, body: string): Promise<Response> {
    const secret = this.env.TELEGRAM_WEBHOOK_SECRET ?? '';
    if (!secret || !sameText(req.headers.get('x-telegram-bot-api-secret-token') ?? '', secret)) return new Response('Unauthorized', { status: 401 });
    let update: unknown;
    try {
      update = JSON.parse(body);
    } catch {
      return new Response('ok');
    }
    const cmd = parseCommand(update, (await this.state.storage.get<string>('owner_chat')) ?? '');
    if (cmd === 'pause') {
      // Pause only ever makes things safer: it stops new entries; exits keep running.
      if (!(await this.state.storage.get('paused'))) await this.state.storage.put('paused', { at: Date.now() });
      await this.say('Entries paused. Exits keep running. The worker applies it on its next heartbeat.');
    } else if (cmd === 'status') {
      await this.say(await this.status(Date.now()));
    } else if (cmd === 'other') {
      await this.say('Commands: /pause, /status');
    }
    return new Response('ok');
  }

  private async status(now: number): Promise<string> {
    const s = this.state.storage;
    return statusText(await s.get<Stored>('hb'), now, (await s.get<{ at: number }>('paused')) ?? null, (await s.get<Record<string, ActiveAlert>>('alerts')) ?? {}, (await s.get<Lease>('lease')) ?? null);
  }

  async check(now: number): Promise<{ alerts: string[]; sent: string[] }> {
    const s = this.state.storage;
    const stored = await s.get<Stored>('hb');
    const limits = limitsFrom(this.env);
    // The chain view is best effort and bounded: a slow or hung RPC never delays the heartbeat-age check.
    const none: ChainView = { slot: null, heldMints: null };
    const limitMs = Number(this.env.CHAIN_TIMEOUT_MS ?? 5000);
    const chain = stored ? await Promise.race([this.chain(stored.hb.wallet ?? null, limitMs).catch(() => none), new Promise<ChainView>((r) => setTimeout(() => r(none), limitMs))]) : none;
    const current = evaluate(stored, now, limits, chain);
    const failed = await s.get<{ reason: string; at: number }>('summary_failure');
    if (failed) current.push(summaryAlert(failed.reason));
    const { lines, next } = planAlerts((await s.get<Record<string, ActiveAlert>>('alerts')) ?? {}, current, now, limits);
    await s.put('alerts', next);
    if (lines.length) await this.say(lines.join('\n'));
    return { alerts: current.map((a) => a.key), sent: lines };
  }

  /** Slot and wallet holdings from a different RPC than the worker uses. Failures leave the check out. */
  private async chain(wallet: string | null, limitMs: number): Promise<ChainView> {
    const url = this.env.CHAIN_RPC_URL;
    if (!url) return { slot: null, heldMints: null };
    const rpc = async (method: string, params: unknown[]) => {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(limitMs) });
      const j = (await res.json()) as { result?: unknown };
      return j.result;
    };
    let slot: number | null = null;
    let heldMints: string[] | null = null;
    try {
      const r = await rpc('getSlot', [{ commitment: 'confirmed' }]);
      slot = typeof r === 'number' ? r : null;
    } catch {}
    if (wallet && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
      try {
        const mints: string[] = [];
        for (const programId of TOKEN_PROGRAMS) {
          const r = (await rpc('getTokenAccountsByOwner', [wallet, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }])) as {
            value?: { account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string } } } } } }[];
          };
          for (const a of r.value ?? []) {
            const info = a.account.data.parsed.info;
            if (info.mint !== WSOL && info.tokenAmount.amount !== '0') mints.push(info.mint);
          }
        }
        heldMints = mints;
      } catch {
        heldMints = null;
      }
    }
    return { slot, heldMints };
  }

  private async say(text: string): Promise<void> {
    const token = this.env.TELEGRAM_BOT_TOKEN;
    const chat = await this.state.storage.get<string>('owner_chat');
    if (!token || !chat) return;
    const base = this.env.TELEGRAM_API ?? 'https://api.telegram.org';
    try {
      await fetch(`${base}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {}
  }
}
