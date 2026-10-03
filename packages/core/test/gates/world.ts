// A passing world for the gate tests: one graduated pump coin built from real mainnet accounts (the canonical
// PumpSwap pool 9KBF3…, its mint HAcEq…, its vaults), plus the event, holder, insider, deployer and regime facts the
// gates need. Each test changes one fact and checks the one gate that must react. Facts go through a real AsOfStore,
// so every read is as of the decision moment.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { decodeMint, decodePool, decodeTokenAccount, encodeBase58, fromBase64, isOnCurve, type Address } from '../../src/chain/index.ts';
import { pumpSwapRoundTrip } from '../../src/costs/index.ts';
import { startSession, TRIAL_POLICY, type PolicySession } from '../../src/config/index.ts';
import { AsOfStore, OFF_CHAIN, SimClock, type Moment } from '../../src/engine/index.ts';
import {
  CURVE_VOLUME_KEY, DAY_MS, EXEC_HEALTH_KEY, GRADUATES_KEY, HOUR_MS, MINUTE_MS, SOL_USD_KEY,
  candlesKey, createKey, deployerKey, holdersKey, insidersKey, lpKey, migrationKey, mintKey, poolKey, simKey, softKey, streamKey, xcheckKey,
  type FactObs, type GateContext, type GateRequest, type HolderAccount, type Mode, type Universe,
} from '../../src/gates/index.ts';
import { bps, lamports, microUsd, type MicroUsd } from '../../src/units/index.ts';
import type { PoolFeeContext } from '../../src/amm/index.ts';
import type { Pool } from '../../src/chain/index.ts';

interface AccountFixture { label: string; address: string; slot: string; owner: string; dataBase64: string }
const read = (path: string): AccountFixture[] => (JSON.parse(readFileSync(join(import.meta.dirname, '..', path), 'utf8')) as { accounts: AccountFixture[] }).accounts;
export const CHAIN_ACCOUNTS = read('chain/fixtures/accounts.json');
export const HOLDER_ACCOUNTS = read('gates/fixtures/holders.json');
export const HOLDERS_META = (JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'holders.json'), 'utf8')) as { meta: { creator: string } }).meta;
const all = [...CHAIN_ACCOUNTS, ...HOLDER_ACCOUNTS];
export const account = (address: string): AccountFixture => {
  const a = all.find((x) => x.address === address);
  if (!a) throw new Error(`no fixture ${address}`);
  return a;
};
export const byLabel = (label: string): AccountFixture => {
  const a = all.find((x) => x.label === label);
  if (!a) throw new Error(`no fixture "${label}"`);
  return a;
};

export const POOL_ADDRESS = '9KBF3KqYErfs1NXRK35gb4J8wnAD2i9ePZAzcwn7yhFT';
export const NON_CANONICAL_POOL = 'GgxBQH5so4CyNKF6sXmcGYcQn4feqGwivYjfpXNUaZud';
export const decodedPool = (address: string): Pool => decodePool(fromBase64(account(address).dataBase64)).value;
export const POOL = decodedPool(POOL_ADDRESS);
export const MINT = POOL.baseMint;
export const mintFixture = (address: string) => {
  const a = account(address);
  return { owner: a.owner, account: decodeMint(fromBase64(a.dataBase64), a.owner as Address) };
};
const vault = (address: string): bigint => {
  const a = account(address);
  return decodeTokenAccount(fromBase64(a.dataBase64), a.owner as Address).amount;
};
export const BASE_VAULT = vault(POOL.poolBaseTokenAccount);
export const QUOTE_VAULT = vault(POOL.poolQuoteTokenAccount);

/** Wallets (on-curve keys taken from the fixtures: they are ordinary signers). */
export const DEV = HOLDERS_META.creator;
export const WALLETS = [
  '4YU7edpRVioZhNaHwr3E69SCvmfyFFzjfDRscCar5God', 'BqSTVy4zi2gE6N3JHeLBB5rpj1hySzYVSRBepzncrA1M',
] as const;

export const SLOT = 452_957_000n;
export const T = 1_791_039_600_000; // ms; an hour boundary (2026-10-03 15:00 UTC)
export const NOW: Moment = { slot: SLOT, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: T };
export const MIGRATED_AT = T - 90 * MINUTE_MS;
export const CREATED_AT = MIGRATED_AT - 30 * MINUTE_MS;
export const SOL_PRICE = 150_000_000n; // $150 in micro-dollars

export const obs = (over: Partial<FactObs> = {}): FactObs => ({ provider: 'test', slot: SLOT - 1n, receivedAt: T - 300, quality: [], commitment: 'confirmed', ...over });
export const streamObs = (over: Partial<FactObs> = {}): FactObs => obs({ slot: SLOT - 500n, receivedAt: T - 200_000, stream: 'chain', ...over });
/** An event fact recorded when it happened. */
export const eventObs = (atMs: number, slot: bigint): FactObs => ({ provider: 'test', slot, receivedAt: atMs, quality: [], commitment: 'confirmed' });

const price = (quote: bigint, base: bigint) => ({ quote, base });
/** Migration price: the pool's starting reserves (85 SOL effective, 206.9M tokens): any ratio works for the tests. */
export const MIGRATION_PRICE = price(84_990_359_561n, 206_900_000_000_000n);

/** A deterministic on-curve address (an ordinary wallet key), `n`-th of its kind. */
export const W = (n: number | string): string => {
  for (let j = 0; ; j++) {
    const bytes = new Uint8Array(createHash('sha256').update(`wallet:${n}:${j}`).digest());
    if (isOnCurve(bytes)) return encodeBase58(bytes);
  }
};
/** A deterministic token-account address. */
export const ACC = (n: number | string): string => encodeBase58(new Uint8Array(createHash('sha256').update(`account:${n}`).digest()));

const wallet = (owner: string, amount: bigint, address = ACC(owner)): HolderAccount => ({ address, owner, ownerProgram: null, amount });

export type Facts = Map<string, { value: unknown; moment: Moment }>;

const at = (receivedAt: number, slot: bigint): Moment => ({ slot, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt });

/** Supply split: pool vault holds most; ten small wallets; the dev holds a little. */
export const SUPPLY = mintFixture(MINT).account.supply;

export const holderAccounts = (): HolderAccount[] => [
  { address: POOL.poolBaseTokenAccount, owner: POOL_ADDRESS, ownerProgram: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', amount: 700_000_000_000_000n },
  wallet(DEV, 4_000_000_000_000n),
  ...Array.from({ length: 30 }, (_, i) => wallet(W(i), 8_000_000_000_000n)),
];

const GRAD_ITEMS = (() => {
  const items: { mint: string; migratedAtMs: number; reserveAfter: bigint }[] = [];
  // 16 days of graduates, 24 a day; 1 in 3 survives, and slightly more in the last day.
  for (let d = 0; d < 16 * 24; d++) {
    const migratedAtMs = T - 30 * MINUTE_MS - d * HOUR_MS;
    const survives = d < 24 ? d % 2 === 0 : d % 3 === 0;
    items.push({ mint: `G${d}`, migratedAtMs, reserveAfter: survives ? 40_000_000_000n : 10_000_000_000n });
  }
  return items;
})();

export const solPoints = (endMs: number, count: number, f: (k: number) => bigint = () => SOL_PRICE) =>
  Array.from({ length: count }, (_, k) => ({ tMs: endMs - k * HOUR_MS, price: f(k) }));

export const volumeDays = (lastDay: number, count: number, f: (k: number) => bigint = (k) => (k === 0 ? 20_000_000_000n : 10_000_000_000n + BigInt(k % 7) * 1_000_000_000n)) =>
  Array.from({ length: count }, (_, k) => ({ day: lastDay - k, volumeUsd: f(k) }));

/** Every fact a passing live decision needs, keyed as the gates read them. */
export const passingFacts = (): Facts => {
  const f: Facts = new Map();
  const put = (key: string, value: unknown, moment: Moment) => f.set(key, { value, moment });
  const head = at(T - 300, SLOT - 1n);
  const m = mintFixture(MINT);
  // FEED-1's creates stream started 30 days ago and has had no gap (GATE-1b coverage).
  put('coverage:creates:start', { value: { fromSlot: SLOT - 6_000_000n, via: 'logs:creates' }, source: 'worker', backfilled: false, seq: 1 }, at(T - 30 * DAY_MS, SLOT - 6_000_000n));
  // A reviewed rug labeller (RUG-1, not built yet) covering the same 30 days.
  put('coverage:rugs:start', { value: { fromSlot: SLOT - 6_000_000n, via: 'rug-labeller' }, source: 'worker', backfilled: false, seq: 2 }, at(T - 30 * DAY_MS + 1, SLOT - 5_999_999n));
  // A PumpSwap trade on the pool after migration, carrying the 2026-10-02 upgrade's 8-byte tail as zeros (GATE-1c).
  put(`pump_amm:BuyEvent:${POOL_ADDRESS}`, tradeEvent('BuyEvent', 8, '0000000000000000', SLOT - 1_500n, 'SigBuy1'), at(T - 10 * MINUTE_MS, SLOT - 1_500n));
  put(streamKey('chain'), { obs: obs({ slot: SLOT - 1n }), gapFreeSince: SLOT - 10_000n }, head);
  put(mintKey(MINT), { obs: streamObs(), owner: m.owner, account: m.account }, at(T - 200_000, SLOT - 500n));
  put(poolKey(MINT), { obs: obs(), address: POOL_ADDRESS, owner: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', pool: POOL, baseVault: BASE_VAULT, quoteVault: QUOTE_VAULT }, head);
  put(lpKey(MINT), { obs: obs(), lpMint: POOL.lpMint, supply: 0n }, head);
  put(createKey(MINT), { obs: eventObs(CREATED_AT, SLOT - 20_000n), createdAtMs: CREATED_AT, creator: DEV }, at(CREATED_AT, SLOT - 20_000n));
  put(migrationKey(MINT), {
    obs: eventObs(MIGRATED_AT, SLOT - 15_000n), graduatedAtMs: MIGRATED_AT - 1_000, migratedAtMs: MIGRATED_AT, pool: POOL_ADDRESS,
    quoteAtMigration: 84_990_359_561n, price: MIGRATION_PRICE,
  }, at(MIGRATED_AT, SLOT - 15_000n));
  put(candlesKey(MINT), {
    obs: streamObs(), intervalMs: MINUTE_MS, candles: [
      // At +5 min the price is below migration (it dumped), and no recent spike.
      { startMs: MIGRATED_AT + 4 * MINUTE_MS, open: MIGRATION_PRICE, high: MIGRATION_PRICE, close: price(70_000_000_000n, 206_900_000_000_000n) },
      { startMs: T - 2 * MINUTE_MS, open: price(100n, 1_000_000n), high: price(110n, 1_000_000n), close: price(105n, 1_000_000n) },
    ],
  }, at(T - 200_000, SLOT - 500n));
  put(holdersKey(MINT), { obs: obs(), supply: SUPPLY, coverage: 'all', accounts: holderAccounts() }, head);
  put(insidersKey(MINT), { obs: eventObs(CREATED_AT + 60_000, SLOT - 19_000n), complete: true, insiders: [W(0), W(1)], devCluster: [] }, at(CREATED_AT + 60_000, SLOT - 19_000n));
  put(deployerKey(DEV), {
    obs: streamObs({ stream: 'chain' }), coverageFromMs: T - 30 * DAY_MS,
    mints: [{ mint: MINT, createdAtMs: CREATED_AT }, { mint: 'Old1', createdAtMs: T - 20 * DAY_MS }],
    rugs: [{ mint: 'Old1', knownAtMs: T - 19 * DAY_MS }],
  }, at(T - 200_000, SLOT - 500n));
  put(simKey(MINT), { obs: obs({ slot: null, receivedAt: T - 500 }), ok: true, spend: SPEND, ...simAmounts(), error: null }, at(T - 500, SLOT - 2n));
  put(xcheckKey(MINT), {
    obs: obs({ slot: null, receivedAt: T - 900 }),
    sources: [{ provider: 'rugcheck', mintAuthority: 'none', freezeAuthority: 'none' }, { provider: 'goplus', mintAuthority: 'none', freezeAuthority: null }],
  }, at(T - 900, SLOT - 3n));
  put(softKey(MINT), { obs: obs(), solPerTrade: 400_000_000n, creationSlotBuyers: 3, rugcheckSingleHolderFlag: true }, head);
  put(SOL_USD_KEY, { obs: eventObs(T - 120_000, SLOT - 300n), points: solPoints(T, 72) }, at(T - 120_000, SLOT - 300n));
  put(CURVE_VOLUME_KEY, { obs: eventObs(T - 10 * HOUR_MS, SLOT - 90_000n), days: volumeDays(Math.floor(T / DAY_MS) - 1, 400) }, at(T - 10 * HOUR_MS, SLOT - 90_000n));
  put(GRADUATES_KEY, { obs: eventObs(T - 1_000, SLOT - 3n), items: GRAD_ITEMS }, at(T - 1_000, SLOT - 3n));
  put(EXEC_HEALTH_KEY, { obs: obs({ slot: null, receivedAt: T - 400 }), green: true, detail: 'failure share 0, landing p50 2 slots' }, at(T - 400, SLOT - 2n));
  return f;
};

/** A PumpSwap trade event as FEED-1 emits it from a fetched transaction (`pump_amm:<name>:<pool>`). */
export const tradeEvent = (name: 'BuyEvent' | 'SellEvent', trailing: number, extra: string, txSlot: bigint, signature: string) => ({
  event: { name, program: 'pump_amm', data: {}, trailing, extra }, txSlot, signature, blockTime: null, source: 'helius', backfilled: false, seq: 1,
});

export const SPEND = lamports(13_000_000n); // 0.013 SOL, about $2 at $150
export const NOTIONAL: MicroUsd = microUsd(2_000_000n);

/** The exact local round trip from the same pool, as the caller would build it. */
export const FEE_CONTEXT: PoolFeeContext = {
  feeConfig: {
    flatFees: { lp: bps(25), protocol: bps(5), creator: bps(0) },
    feeTiers: [{ marketCapThreshold: 0n, fees: { lp: bps(2), protocol: bps(93), creator: bps(30) } }],
    exoticFlatFees: { lp: bps(0), protocol: bps(0), creator: bps(0) },
  },
  canonical: true, quote: 'sol', baseSupply: SUPPLY, creatorFeeCharged: true, coin: { mayhemMode: false, transferFee: false, transferHook: false },
  instruction: 'v2', buybackFeeBps: bps(5000),
};
export const roundTrip = (spend = SPEND) =>
  pumpSwapRoundTrip({ baseReserve: BASE_VAULT, quoteVault: QUOTE_VAULT, virtualQuoteReserves: POOL.virtualQuoteReserves ?? 0n }, FEE_CONTEXT)(spend);

/** The simulation agrees with the local model to the lamport. */
const simAmounts = () => {
  const q = roundTrip();
  if (!q.ok) throw new Error(`the passing world must quote: ${q.detail}`);
  return { paid: q.trade.paid, proceeds: q.trade.proceeds };
};

export const request = (over: Partial<GateRequest> = {}): GateRequest => ({ mint: MINT, universe: 'U2', notional: NOTIONAL, spend: SPEND, roundTrip: roundTrip(), ...over });

/** Builds a gate context over a real AsOfStore: facts are recorded in time order, then the clock stands at `now`. */
export const contextOf = (facts: Facts, now: Moment = NOW): GateContext => {
  const clock = new SimClock({ slot: 0n, txIndex: 0, ixIndex: 0, receivedAt: 0 });
  const store = new AsOfStore(clock);
  const sorted = [...facts].sort(([ka, a], [kb, b]) =>
    a.moment.slot < b.moment.slot ? -1 : a.moment.slot > b.moment.slot ? 1 : a.moment.receivedAt - b.moment.receivedAt || (ka < kb ? -1 : 1));
  for (const [key, { value, moment }] of sorted) {
    if (moment.slot > now.slot || moment.receivedAt > now.receivedAt) continue; // the future is not recorded yet
    clock.advanceTo(moment);
    store.record(key, value, moment, key);
  }
  clock.advanceTo(now);
  return { now: clock.now(), lookup: (key, asOf) => store.lookup(key, asOf), history: (key, from, to) => store.history(key, from, to) };
};

export const session = (over: Partial<PolicySession['policy']['gates']> = {}): PolicySession =>
  startSession({ ...TRIAL_POLICY, gates: { ...TRIAL_POLICY.gates, ...over } });

/** Gate deps. `rug` wires a reviewed rug labeller (RUG-1); without it H14's prior-rug half is noted as unavailable. */
export const deps = (mode: Mode = 'live', s: PolicySession = session(), rug?: 'RUG-1') => ({ session: s, mode, ...(rug ? { rugLabeller: rug } : {}) });

/** Replaces the value of one fact (shallow merge into the value), keeping its moment. */
export const patch = (facts: Facts, key: string, change: Record<string, unknown>): Facts => {
  const f = new Map(facts);
  const e = f.get(key);
  if (!e) throw new Error(`no fact ${key}`);
  f.set(key, { value: { ...(e.value as object), ...change }, moment: e.moment });
  return f;
};
export const drop = (facts: Facts, key: string): Facts => {
  const f = new Map(facts);
  f.delete(key);
  return f;
};
export type { Universe };
