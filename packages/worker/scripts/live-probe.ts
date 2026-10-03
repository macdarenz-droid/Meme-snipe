// Opt-in check of every FEED-1 adapter against the real endpoints. Never part of CI or `pnpm test`.
// Run on the host (or by the owner) with keys from systemd credentials:
//   ZEROED_LIVE_PROBE=1 CREDENTIALS_DIRECTORY=/run/credentials/zeroed-worker.service node packages/worker/scripts/live-probe.ts
// It prints field names, counts and timings only, never a key or a URL that holds one.
import { PUMP_GLOBAL, PUMP_PROGRAM, transactionEvents } from '../../core/src/chain/index.ts';
import {
  alchemyRpcUrl, alchemyWsUrl, credentialsDirectorySecrets, DEFAULT_LIVE_FEED, fetchHttp, globalSocketFactory, heliusRpcUrl, heliusWsUrl,
  JupiterClient, LiveFeed, PumpPortalSource, RpcHttp, RpcStream, RugCheckClient, type Frame,
} from '../src/providers/index.ts';
import {
  ALCHEMY_FREE, ALCHEMY_WS_CU_PER_BYTE, HELIUS_FREE, HELIUS_WS_CREDITS_PER_BYTE, HELIUS_WS_CREDITS_PER_CONNECTION, JUPITER_FREE, P2, P3,
  RUGCHECK_FREE, Scheduler, systemTimers,
} from '../src/scheduler/index.ts';

if (process.env.ZEROED_LIVE_PROBE !== '1') {
  console.error('live probe is opt-in: set ZEROED_LIVE_PROBE=1 (it uses real provider credits)');
  process.exit(2);
}
const dir = process.env.CREDENTIALS_DIRECTORY;
if (!dir) {
  console.error('set CREDENTIALS_DIRECTORY to the directory holding HELIUS_API_KEY, ALCHEMY_API_KEY and JUPITER_API_KEY');
  process.exit(2);
}

const secrets = credentialsDirectorySecrets(dir);
const timers = systemTimers();
const frames: Frame[] = [];
const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, onFrame: (f) => frames.push(f) });
const helius = new Scheduler(HELIUS_FREE, { timers });
const alchemy = new Scheduler(ALCHEMY_FREE, { timers });
const results: Record<string, string> = {};
const wait = (ms: number) => new Promise<void>((r) => timers.setTimeout(r, ms));
const check = async (name: string, f: () => Promise<string>) => {
  const t0 = timers.now();
  try {
    results[name] = `ok (${await f()}, ${timers.now() - t0} ms)`;
  } catch (e) {
    results[name] = `FAILED: ${(e as Error).message}`;
  }
};

const hRpc = new RpcHttp({ provider: 'helius', url: () => heliusRpcUrl(secrets), http: fetchHttp, scheduler: helius, timeoutMs: 10_000 });
const aRpc = new RpcHttp({ provider: 'alchemy', url: () => alchemyRpcUrl(secrets), http: fetchHttp, scheduler: alchemy, timeoutMs: 10_000 });

await check('helius getTransaction decodes through DEC-1', async () => {
  const [s] = await hRpc.getSignaturesForAddress(PUMP_PROGRAM, { limit: 5 }, P2);
  if (!s) throw new Error('no signature');
  const rec = await hRpc.getTransaction(s.signature, P2);
  return rec ? `${transactionEvents(rec).length} events` : 'not found yet';
});
await check('alchemy getAccountInfo', async () => `${(await aRpc.getAccountInfo(PUMP_GLOBAL, P2)).value?.data.length ?? 0} bytes`);

for (const [name, url, scheduler, perByte] of [['helius', () => heliusWsUrl(secrets), helius, HELIUS_WS_CREDITS_PER_BYTE], ['alchemy', () => alchemyWsUrl(secrets), alchemy, ALCHEMY_WS_CU_PER_BYTE]] as const) {
  await check(`${name} slotSubscribe`, async () => {
    const stream = new RpcStream({ provider: name, url, factory: globalSocketFactory, timers, feed, scheduler, creditsPerByte: perByte, creditsPerConnection: name === 'helius' ? HELIUS_WS_CREDITS_PER_CONNECTION : 0, http: name === 'helius' ? hRpc : aRpc, socket: { initialMs: 1_000, maxMs: 4_000, idleMs: 30_000 }, backfillLimit: 10 });
    const before = frames.length;
    stream.watchSlots();
    stream.start();
    await wait(4_000);
    stream.stop();
    return `${frames.slice(before).filter((f) => f.source === name && f.body.type === 'slot').length} slot notices in 4 s`;
  });
}

await check('pumpportal one connection', async () => {
  const pp = new PumpPortalSource({ factory: globalSocketFactory, timers, feed });
  const before = frames.length;
  pp.start();
  await wait(20_000);
  pp.stop();
  const got = frames.slice(before).filter((f) => f.source === 'pumpportal');
  const fields = new Set(got.flatMap((f) => (f.body.type === 'seen' && f.body.detail ? Object.keys(f.body.detail) : [])));
  return `${got.length} messages in 20 s; fields: ${[...fields].sort().join(', ')}`;
});

await check('parsed streams describeProgram has migrate', async () => {
  const ws = globalSocketFactory(`wss://fs-beta.helius-rpc.com/?api-key=${encodeURIComponent(secrets.get('HELIUS_API_KEY'))}`);
  const answer = await new Promise<string>((resolve, reject) => {
    timers.setTimeout(() => reject(new Error('no answer in 10 s')), 10_000);
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'describeProgram', params: [{ program: PUMP_PROGRAM }] }));
    ws.onmessage = (ev) => resolve(String(ev.data));
    ws.onclose = () => reject(new Error('closed'));
  });
  ws.close();
  const instructions = (JSON.parse(answer) as { result?: { instructions?: string[] } }).result?.instructions ?? [];
  if (!instructions.includes('migrate')) throw new Error(`instructions: ${instructions.join(', ')}`);
  return `${instructions.length} instructions`;
});

const jupiter = new JupiterClient({ http: fetchHttp, secrets, scheduler: new Scheduler(JUPITER_FREE, { timers }), feed, timers, timeoutMs: 10_000 });
let mint: string | null = null;
await check('jupiter tokens/recent', async () => {
  const rows = await jupiter.tokensRecent(P3);
  const first = rows[0] as { id?: string } | undefined;
  mint = first?.id ?? null;
  return `${rows.length} rows`;
});
await check('rugcheck summary', async () => {
  if (mint === null) throw new Error('no mint from Jupiter');
  const r = (await new RugCheckClient({ http: fetchHttp, scheduler: new Scheduler(RUGCHECK_FREE, { timers }), feed, timers, timeoutMs: 10_000 }).summary(mint, P3)) as Record<string, unknown>;
  return `fields: ${Object.keys(r).sort().join(', ')}`;
});

for (const [k, v] of Object.entries(results)) console.log(`${k}: ${v}`);
console.log(`helius credits used by this probe: ${helius.status().creditsUsed.toFixed(1)}; alchemy CU: ${alchemy.status().creditsUsed.toFixed(1)}`);
process.exit(Object.values(results).some((v) => v.startsWith('FAILED')) ? 1 : 0);
