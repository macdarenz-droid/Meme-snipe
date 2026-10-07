// RED TEAM C (probe driver, not product code; not a test file): the real Worker on virtual time, fed for hours of
// simulated time with a steady stream of creates (logs on the create authority, CreateEvent + initial TradeEvent),
// migrations (the candidate's migration and pool facts, its pool's trade stream with swaps and coverage gaps), cut
// logs and SOL prices. Every simulated hour it collects garbage and prints the heap and the worker's own MEM-PROBE
// collection counts as one JSON line. Run by heap-*.test.ts in a child: node --expose-gc --max-old-space-size=560.
//   argv: hours creates_per_min migrations_per_min [step_ms]
import { readdirSync } from 'node:fs';
import { CreateEventLayout, TradeEventLayout, PUMP_PROGRAM, encodeBase58, toBase64 } from '../../../core/src/chain/index.ts';
import { encode } from '../../../core/test/chain/encode.ts';
import { FEE_CONTEXT, passingFacts } from '../../../core/test/gates/world.ts';
import { poolKey, migrationKey, lpKey, holdersKey, softKey, xcheckKey, simKey } from '../../../core/src/gates/index.ts';
import { RAW } from '../../../core/src/facts/index.ts';
import { account } from '../../../core/test/gates/world.ts';
import { SOL_PRICE_KEY, feesKey } from '../../src/engine/strategy.ts';
import { readProbe } from '../../src/run/mem-trace.ts';
import { POOL, POOL_ADDRESS, MINT, SOL_PRICE, makeWorker, slotAt, dueTimers, T } from '../worker-harness.ts';

const [hours, cpm, mpm, stepMs] = [Number(process.argv[2] ?? 2), Number(process.argv[3] ?? 25), Number(process.argv[4] ?? 1), Number(process.argv[5] ?? 1000)];
const gc = (globalThis as { gc?: () => void }).gc!;
const CREATE_AUTH = 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';

let seq = 0;
const key32 = (tag: string): string => {
  const b = new Uint8Array(32);
  const n = ++seq;
  for (let i = 0; i < 8; i++) b[i] = (n >>> (i * 4)) & 0xff ^ (i * 37);
  for (let i = 0; i < tag.length && i < 8; i++) b[8 + i] = tag.charCodeAt(i);
  b[31] = n & 0xff;
  b[30] = (n >>> 8) & 0xff;
  b[29] = (n >>> 16) & 0xff;
  b[16] = 7;
  return encodeBase58(b);
};
const sig = (): string => {
  const b = new Uint8Array(64);
  const n = ++seq;
  for (let i = 0; i < 64; i++) b[i] = (n * (i + 13) + i * 101) & 0xff;
  b[0] = 1 + (n & 0x7f);
  return encodeBase58(b);
};
type F = readonly (readonly [string, { idl: unknown }])[];
/** The fixture encoder, with an empty `vec` (shareholders) written as its zero length. */
const enc = (fields: F, v: Record<string, unknown>): number[] =>
  fields.flatMap((f) => (typeof f[1].idl === 'object' && f[1].idl !== null && 'vec' in (f[1].idl as object) ? [0, 0, 0, 0] : encode([f], v)));
const data = (l: { discriminator: readonly number[]; base: readonly unknown[]; added: readonly unknown[] }, v: Record<string, unknown>): string =>
  `Program data: ${toBase64(Uint8Array.from([...l.discriminator, ...enc([...l.base, ...l.added] as unknown as F, v)]))}`;

const SOL = 'So11111111111111111111111111111111111111112';
const deployers = Array.from({ length: 4_000 }, () => key32('dev'));
const createLogs = (mint: string, dev: string, atMs: number, cut: boolean): string[] => {
  const ts = BigInt(Math.floor(atMs / 1000));
  const curve = key32('curve');
  const create = data(CreateEventLayout, {
    name: `Coin ${mint.slice(0, 6)} of the day`, symbol: mint.slice(0, 5).toUpperCase(), uri: `https://ipfs.io/ipfs/Qm${mint}${mint.slice(0, 2)}`, mint, bondingCurve: curve, user: dev, creator: dev, timestamp: ts,
    virtualTokenReserves: 1_073_000_000_000_000n, virtualSolReserves: 30_000_000_000n, realTokenReserves: 793_100_000_000_000n, tokenTotalSupply: 1_000_000_000_000_000n,
    tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', isMayhemMode: false, isCashbackEnabled: false, quoteMint: SOL, virtualQuoteReserves: 0n, creatorFeeBps: 0n, isHolderReward: false,
  });
  const trade = data(TradeEventLayout, {
    mint, solAmount: 500_000_000n, tokenAmount: 17_000_000_000_000n, isBuy: true, user: dev, timestamp: ts, virtualSolReserves: 30_500_000_000n, virtualTokenReserves: 1_056_000_000_000_000n,
    realSolReserves: 500_000_000n, realTokenReserves: 776_100_000_000_000n, feeRecipient: dev, feeBasisPoints: 95n, fee: 4_750_000n, creator: dev, creatorFeeBasisPoints: 30n, creatorFee: 1_500_000n,
    trackVolume: true, totalUnclaimedTokens: 0n, totalClaimedTokens: 0n, currentSolVolume: 500_000_000n, lastUpdateTimestamp: ts, ixName: 'buy', mayhemMode: false, cashbackFeeBasisPoints: 0n, cashback: 0n,
    buybackFeeBasisPoints: 0n, buybackFee: 0n, shareholders: [], quoteMint: SOL, quoteAmount: 0n, virtualQuoteReserves: 0n, realQuoteReserves: 0n, holderRewardsBps: 0n, holderRewards: 0n,
  });
  const lines = [`Program ${PUMP_PROGRAM} invoke [1]`, 'Program log: Instruction: Create', create, `Program ${PUMP_PROGRAM} consumed 120000 of 200000 compute units`, `Program ${PUMP_PROGRAM} success`, `Program ${PUMP_PROGRAM} invoke [1]`, 'Program log: Instruction: Buy', trade, `Program ${PUMP_PROGRAM} success`];
  return cut ? [...lines.slice(0, 3), 'Log truncated'] : lines;
};

const facts = passingFacts();
const poolT = (facts.get(poolKey(MINT))!.value) as { obs: Record<string, unknown>; pool: Record<string, unknown> } & Record<string, unknown>;
const migT = (facts.get(migrationKey(MINT))!.value) as { obs: Record<string, unknown> } & Record<string, unknown>;

process.stderr.write('mod\n');
const READS = process.env['READS'] === '1';
const LIFE_MIN = Number(process.env['LIFE_MIN'] ?? (READS ? 240 : 30));
const accountsT = [POOL_ADDRESS, POOL.poolBaseTokenAccount, POOL.poolQuoteTokenAccount, MINT].map((a) => {
  const x = account(a);
  return { address: a, owner: x.owner, data: x.dataBase64 };
});
/** 20 largest holders, fresh strings each read (a live read's addresses are new strings every time). */
const holdersT = () => Array.from({ length: 20 }, (_, i) => ({ address: `${'H'.repeat(40)}${String(i).padStart(4, '0')}`, owner: `${'O'.repeat(40)}${String(i).padStart(4, '0')}`, ownerProgram: null, amount: BigInt(1_000_000 + i), delegate: null, delegatedAmount: 0n }));
const timers = dueTimers(T - 16 * 86_400_000);
const h = makeWorker({ timers, seedWaitMs: 0, config: { ZEROED_RECORDER: process.env['REC'] ?? 'on' } });
process.stderr.write('made\n');
const feed = h.worker.feed;
process.stderr.write('starting\n');
const started = h.worker.start();
process.stderr.write('started call\n');
while (!h.order.includes('start helius-ws')) {
  timers.set(timers.now() + 100);
  await new Promise<void>((r) => setImmediate(r));
}
let lastSlot = 0n;
const slot = (): bigint => {
  const want = slotAt(timers.now());
  const s = want > lastSlot && want > feed.releasedThrough ? want : (lastSlot > feed.releasedThrough ? lastSlot : feed.releasedThrough) + 1n;
  if (s > lastSlot) {
    lastSlot = s;
    feed.ingest('helius', { type: 'slot', slot: s, parent: s - 1n, root: null }, { receivedAt: timers.now() });
  }
  return lastSlot;
};
slot();
let up = false;
void started.then(() => (up = true));
while (!up) {
  timers.set(timers.now() + 100);
  slot();
  await new Promise<void>((r) => setImmediate(r));
}
const now = () => timers.now();
feed.ingest('helius', { type: 'offchain', key: 'coverage:creates:start', value: { fromSlot: slot(), via: `logs:${CREATE_AUTH}` } }, { receivedAt: now() });

process.stderr.write('up\n');
const pools: { mint: string; pool: string; until: number }[] = [];
let createsDone = 0;
let migDone = 0;
let cuts = 0;
const start = now();
const t0 = Date.now();
const report = (hour: number) => {
  gc();
  gc();
  const mu = process.memoryUsage();
  const p = readProbe(h.stateDir).at(-1);
  const counts = Object.fromEntries((p?.counts ?? []).map((c) => [c.code, c.count]));
  console.log(JSON.stringify({ hour, wall_s: Math.round((Date.now() - t0) / 1000), heap_mb: +(mu.heapUsed / 1_048_576).toFixed(1), rss_mb: +(mu.rss / 1_048_576).toFixed(1), creates: createsDone, migrations: migDone, cuts, counts }));
};
report(0);
const total = hours * 3_600_000;
let createDebt = 0;
let migDebt = 0;
let lastHour = 0;
while (now() - start < total) {
  const s = slot();
  createDebt += (cpm * stepMs) / 60_000;
  migDebt += (mpm * stepMs) / 60_000;
  while (createDebt >= 1) {
    createDebt -= 1;
    const mint = key32('mint');
    const cut = createsDone % 15 === 7; // ~7% of create logs cut (S1: 41 of 600)
    if (cut) cuts++;
    feed.ingest('helius', { type: 'logs', signature: sig(), slot: s, err: null, via: `logs:${CREATE_AUTH}`, logs: createLogs(mint, deployers[createsDone % deployers.length]!, now(), cut) }, { receivedAt: now() });
    createsDone++;
    if (migDebt >= 1) {
      migDebt -= 1;
      const pool = key32('pool');
      migDone++;
      const obs = { ...migT.obs, slot: s - 1n, receivedAt: now() - 50 };
      feed.ingest('worker', { type: 'fact', key: migrationKey(mint), value: { ...migT, obs, graduatedAtMs: now() - 1_000, migratedAtMs: now() - 500, pool } }, { receivedAt: now() });
      pools.push({ mint, pool, until: now() + LIFE_MIN * 60_000 });
      feed.ingest('worker', { type: 'offchain', key: `coverage:trades:${pool}:start`, value: { fromSlot: s, via: `logs:${pool}` } }, { receivedAt: now() });
    }
  }
  // Each live candidate pool: a pool fact every 10 s while it is watched (what the facts producer keeps current), a
  // coverage gap now and then.
  if ((now() - start) % 10_000 < stepMs) {
    for (const p of pools) {
      const obs = { ...poolT.obs, slot: s - 1n, receivedAt: now() - 50 };
      feed.ingest('worker', { type: 'fact', key: poolKey(p.mint), value: { ...poolT, obs, address: p.pool, pool: { ...poolT.pool, baseMint: p.mint } } }, { receivedAt: now() });
      if (!READS) feed.ingest('worker', { type: 'fact', key: feesKey(p.mint), value: FEE_CONTEXT }, { receivedAt: now() });
    }
    feed.ingest('worker', { type: 'fact', key: SOL_PRICE_KEY, value: { value: SOL_PRICE, atMs: now() - 50 } }, { receivedAt: now() });
  }
  // READS: each live candidate's coherent batch read once a minute (minReadGapMs = 60 s), as FactReaders puts it on the
  // feed: the raw reads (accounts, largest holders, simulation) and the fee context as offchain frames, and the gate
  // facts the producer makes of them.
  if (READS && (now() - start) % 60_000 < stepMs) {
    for (const p of pools) {
      const at = now() - 50;
      const o = (k: (m: string) => string) => {
        const v = facts.get(k(MINT))!.value as { obs: object };
        return { ...v, obs: { ...v.obs, slot: s - 1n, receivedAt: at } };
      };
      feed.ingest('helius', { type: 'offchain', key: RAW.accounts(p.mint), value: { mint: p.mint, slot: s - 1n, commitment: 'confirmed', accounts: accountsT.map((a) => ({ ...a, address: a.address === POOL_ADDRESS ? p.pool : a.address })) } }, { receivedAt: now() });
      feed.ingest('helius', { type: 'offchain', key: RAW.holders(p.mint), value: { mint: p.mint, slot: s - 1n, commitment: 'confirmed', supply: 1_000_000_000_000_000n, accounts: holdersT() } }, { receivedAt: now() });
      feed.ingest('helius', { type: 'offchain', key: RAW.sim(p.mint), value: { mint: p.mint, slot: s - 1n, spend: 13_333_334n, ok: true, paid: 13_400_000n, proceeds: 12_900_000n, error: null } }, { receivedAt: now() });
      feed.ingest('helius', { type: 'offchain', key: feesKey(p.mint), value: FEE_CONTEXT }, { receivedAt: now() });
      for (const k of [lpKey, holdersKey, softKey, xcheckKey, simKey]) feed.ingest('worker', { type: 'fact', key: k(p.mint), value: o(k) }, { receivedAt: now() });
    }
  }
  if ((now() - start) % 600_000 < stepMs) {
    for (const p of pools) feed.ingest('worker', { type: 'offchain', key: `coverage:trades:${p.pool}:gap`, value: { fromSlot: s - 10n, toSlot: s - 5n, reason: 'disconnect', via: `logs:${p.pool}` } }, { receivedAt: now() });
  }
  for (let i = pools.length - 1; i >= 0; i--) if (pools[i]!.until < now()) pools.splice(i, 1);
  h.worker.step();
  timers.set(now() + stepMs);
  await new Promise<void>((r) => setImmediate(r));
  const hour = Math.floor((now() - start) / 3_600_000);
  if (hour > lastHour) {
    lastHour = hour;
    report(hour);
  }
}
const recDir = readdirSync(h.stateDir);
console.log(JSON.stringify({ done: true, logs: h.logs.slice(-5), state: recDir }));
await h.worker.stop();
process.exit(0);
