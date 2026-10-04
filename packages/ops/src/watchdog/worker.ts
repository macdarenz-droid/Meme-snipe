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
} from './logic.ts';
import { NEW_RING, candidates, isRing, promote, type Candidate, type Ring } from './keyring.ts';

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

export interface Env {
  WATCHDOG: DurableNamespace;
  HEARTBEAT_HMAC_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** KEY-ROTATE-SAFE slots (keyring.ts): the workflow writes the slot that is not active. */
  HEARTBEAT_HMAC_KEY_A?: string;
  HEARTBEAT_HMAC_KEY_B?: string;
  TELEGRAM_WEBHOOK_SECRET_A?: string;
  TELEGRAM_WEBHOOK_SECRET_B?: string;
  TELEGRAM_API?: string;
  CHAIN_RPC_URL?: string;
  CHAIN_TIMEOUT_MS?: string;
  [k: string]: unknown;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** The two rotated secrets (keyring.ts). */
const HB = 'HEARTBEAT_HMAC_KEY';
const WH = 'TELEGRAM_WEBHOOK_SECRET';
const WSOL = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    const post = req.method === 'POST' && ['/heartbeat', '/telegram', '/lease', '/resume'].includes(pathname);
    if (!post && !(req.method === 'GET' && pathname === '/slot')) return new Response('Not found', { status: 404 });
    return env.WATCHDOG.get(env.WATCHDOG.idFromName('primary')).fetch(req);
  },
  async scheduled(_event: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    const stub = env.WATCHDOG.get(env.WATCHDOG.idFromName('primary'));
    ctx.waitUntil(stub.fetch(new Request('https://watchdog.internal/check', { method: 'POST' })));
  },
};

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
    if (pathname === '/slot') return this.slots();
    const body = await req.text();
    if (pathname === '/telegram') return this.telegram(req, body);
    // The signature covers method and path too, so a heartbeat's signature can never open /resume. The key is the
    // active slot's or an offered one (KEY-ROTATE-SAFE, keyring.ts); only a heartbeat promotes an offer.
    let t: number | null = null;
    let used: Candidate | null = null;
    for (const c of await candidates(await this.ring(HB), this.env, HB)) {
      t = await verifySignature(req.headers.get('x-zeroed-signature'), req.method, pathname, body, c.value, Math.floor(Date.now() / 1000));
      if (t !== null) {
        used = c;
        break;
      }
    }
    if (t === null || used === null) return json({ error: 'bad signature' }, 401);
    if (pathname === '/heartbeat') return this.heartbeat(body, used);
    if (pathname === '/lease') return this.lease(body);
    if (pathname === '/resume') return this.resume(t);
    return new Response('Not found', { status: 404 });
  }

  private async heartbeat(body: string, used: Candidate): Promise<Response> {
    const hb = parseHeartbeat(body);
    if (!hb) return json({ error: 'bad heartbeat' }, 400);
    const prev = await this.state.storage.get<Stored>('hb');
    if (!isNewer(prev, hb)) return json({ error: 'replayed heartbeat' }, 409);
    // The server beats with the offered key: it has the new key, so the old one is retired from now on.
    if (!used.active) await this.state.storage.put(`ring:${HB}`, await promote(await this.ring(HB), this.env, HB, used.slot));
    await this.state.storage.put('hb', { hb, receivedAt: Date.now() } satisfies Stored);
    // The owner's chat comes only from the server's signed heartbeat (paired there with /pair).
    if (typeof hb.owner_chat_id === 'string' && /^-?\d{1,20}$/.test(hb.owner_chat_id)) await this.state.storage.put('owner_chat', hb.owner_chat_id);
    const paused = await this.state.storage.get<{ at: number }>('paused');
    return json({ ok: true, paused: Boolean(paused) });
  }

  private async ring(base: string): Promise<Ring> {
    const r = await this.state.storage.get<unknown>(`ring:${base}`);
    return isRing(r) ? r : NEW_RING;
  }

  /** Which slot is active per rotated secret: all the Deploy workflow needs to write the other one. Names only. */
  private async slots(): Promise<Response> {
    return json({ heartbeat: (await this.ring(HB)).active, webhook: (await this.ring(WH)).active });
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
    const given = req.headers.get('x-telegram-bot-api-secret-token') ?? '';
    const used = (await candidates(await this.ring(WH), this.env, WH)).find((c) => sameText(given, c.value));
    if (!used) return new Response('Unauthorized', { status: 401 });
    // Telegram sends the offered secret: the server set the webhook with it, so the old one is retired.
    if (!used.active) await this.state.storage.put(`ring:${WH}`, await promote(await this.ring(WH), this.env, WH, used.slot));
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
