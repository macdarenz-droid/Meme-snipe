// Hard rejects H1-H16 (docs/ARCHITECTURE.md §7.1). Any one fails, no entry. Every threshold comes from the locked
// session policy; every input is read as of the decision moment through `Evidence`, so unknown, stale or degraded
// input rejects under H16 with the gate that needed it. Evaluation order is fixed and cheapest first.
import type { Address } from '../chain/bytes.ts';
import type { Pool } from '../chain/pump-amm.ts';
import { isCanonicalPool } from '../chain/pump-amm.ts';
import { NATIVE_MINT, PUMP_AMM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../chain/programs.ts';
import type { Extension } from '../chain/token.ts';
import type { Quote } from '../amm/fees.ts';
import type { PolicySession } from '../config/session.ts';
import type { Policy } from '../config/policy.ts';
import { ROUND_TRIP_ROUNDING_LAMPORTS, type RoundTrip } from '../costs/index.ts';
import { isMint } from '../domain/index.ts';
import { BPS_DENOMINATOR, type Lamports, type MicroUsd, lamportsToMicroUsd } from '../units/index.ts';
import { Evidence, type GateContext, type Read } from './evidence.ts';
import {
  type CreateFact, type MintFact, type PoolFact, type Price,
  SOL_USD_KEY, candlesKey, createKey, curveKey, deployerKey, holdersKey, insidersKey, lpKey, migrationKey, mintKey,
  parseCandles, parseCreate, parseCurve, parseDeployer, parseHolders, parseInsiders, parseLp, parseMigration, parseMint,
  parsePool, parseSim, parseSolUsd, parseXcheck, poolKey, simKey, xcheckKey,
} from './facts.ts';
import { checkCurveTails, checkPoolTails } from './tails.ts';
import { LOG_CREATE_PREFIX, TX_CREATE_PREFIX, createOf, createsCoverage } from './deployer-index.ts';
import type { AsOfEntry } from '../engine/asof.ts';
import type { Commitment } from '../domain/index.ts';
import { type Concentration, concentration, mintAccounts, ownerBalance, shareBps } from './holders.ts';
import type { GateNote, GateReason, HardGate, RejectCode } from './reasons.ts';
import { DAY_MS, HOURLY_MAX_AGE_MS, MINUTE_MS, solUsdAt } from './series.ts';

export type Mode = 'live' | 'backtest';
/** Universes of §3.2, and S0, the random-entry control. */
export type Universe = 'U1' | 'U2' | 'U3' | 'S0';

export interface GateRequest {
  readonly mint: string;
  readonly universe: Universe;
  /** Trade size in dollars (sets the liquidity floor, R12). */
  readonly notional: MicroUsd;
  /** Lamports the entry would spend. */
  readonly spend: Lamports;
  /**
   * The exact local round trip at `spend` (CORE-2 `pumpSwapRoundTrip`), built by the caller from the same as-of pool
   * and fee reads. H15 in both modes; in the backtest it stands in for the live simulation (§16.3).
   */
  readonly roundTrip: Quote<RoundTrip>;
}

export interface GateDeps {
  /** The locked session policy: thresholds come only from here. */
  readonly session: PolicySession;
  readonly mode: Mode;
  /**
   * Set only once a reviewed rug labeller (RUG-1) is wired. Until then H14's prior-rug half is not applied and every
   * evaluation that reaches H14 carries a `rug-labels-unavailable` note: no labels is never read as zero rugs.
   */
  readonly rugLabeller?: 'RUG-1';
}

export const RUG_LABELS_UNAVAILABLE = 'rug labels unavailable (no reviewed labeller; RUG-1)';

export interface HardOptions {
  /** Stop at the first failing gate (default). False evaluates every gate, for calibration logs. */
  readonly stopAtFirst?: boolean;
}

export interface HardResult {
  readonly pass: boolean;
  readonly mode: Mode;
  readonly mint: string;
  /** Gates evaluated, in order. */
  readonly evaluated: readonly HardGate[];
  readonly passed: readonly HardGate[];
  readonly failed: readonly HardGate[];
  readonly reasons: readonly GateReason[];
  readonly notes: readonly GateNote[];
}

interface Env {
  readonly ev: Evidence;
  readonly history: GateContext['history'];
  readonly deployers: GateContext['deployers'];
  readonly rugLabeller: GateDeps['rugLabeller'];
  readonly policy: Policy;
  readonly mode: Mode;
  readonly req: GateRequest;
  readonly memo: Map<string, unknown>;
}

interface Outcome {
  readonly reasons: readonly GateReason[];
  readonly notes?: readonly GateNote[];
}

const PASS: Outcome = { reasons: [] };
const reject = (gate: HardGate, code: RejectCode, detail: string, extra: Partial<Pick<GateReason, 'input' | 'value' | 'limit'>> = {}): Outcome =>
  ({ reasons: [{ gate, code, detail, ...extra }] });
const fromRead = (r: Read<unknown> & { ok: false }): Outcome => ({ reasons: [r.reason] });

const memo = <T>(env: Env, key: string, f: () => T): T => {
  if (!env.memo.has(key)) env.memo.set(key, f());
  return env.memo.get(key) as T;
};

// ---------- Shared reads ----------

const CREATE_ALIASES: readonly (readonly [string, Commitment])[] = [[TX_CREATE_PREFIX, 'confirmed'], [LOG_CREATE_PREFIX, 'processed']];

/** FEED-1's create event as a create fact, or null when it is not this mint's create. */
const aliasCreate = (v: unknown, at: AsOfEntry, mint: string, commitment: Commitment): CreateFact | null => {
  const c = createOf(v);
  const o = typeof v === 'object' && v !== null ? (v as Readonly<Record<string, unknown>>) : {};
  const slot = o['txSlot'];
  if (c === null || c.mint !== mint || typeof slot !== 'bigint') return null;
  return {
    obs: { provider: typeof o['source'] === 'string' ? o['source'] : 'feed', slot, receivedAt: at.moment.receivedAt, quality: o['backfilled'] === true ? ['backfilled'] : [], commitment },
    createdAtMs: c.createdAtMs,
    creator: c.creator,
  };
};

const readMint = (env: Env, gate: HardGate) => env.ev.read('mint', mintKey(env.req.mint), parseMint, 'state', gate);
const readPool = (env: Env, gate: HardGate) => env.ev.read('pool', poolKey(env.req.mint), parsePool, 'state', gate);
/**
 * The create fact: our own, else FEED-1's create event (GATE-1b alias). A create read from a fetched transaction is
 * at confirmed commitment; one read from the logs stream is at processed, which H16 refuses.
 */
const readCreate = (env: Env, gate: HardGate): Read<CreateFact> => {
  const own = createKey(env.req.mint);
  if (env.ev.raw(own) !== undefined) return env.ev.read('create', own, parseCreate, 'event', gate);
  for (const [prefix, commitment] of CREATE_ALIASES) {
    const key = `${prefix}${env.req.mint}`;
    const at = env.ev.entry(key);
    if (at !== undefined) return env.ev.read('create', key, (v) => aliasCreate(v, at, env.req.mint, commitment), 'event', gate);
  }
  return env.ev.read('create', own, parseCreate, 'event', gate);
};
const readMigration = (env: Env, gate: HardGate) => env.ev.read('migration', migrationKey(env.req.mint), parseMigration, 'event', gate);

/** The decoded mint, or the reason it cannot be used. A mint the token programs do not own fails H1 first. */
const mintAccount = (env: Env, gate: HardGate): { ok: true; account: NonNullable<MintFact['account']> } | { ok: false; out: Outcome } => {
  const r = readMint(env, gate);
  if (!r.ok) return { ok: false, out: fromRead(r) };
  if (r.fact.account === null) {
    return { ok: false, out: { reasons: [{ gate: 'H16', code: 'malformed', input: 'mint', neededBy: gate, detail: `mint owned by ${r.fact.owner} could not be decoded` }] } };
  }
  return { ok: true, account: r.fact.account };
};

/** a > b * (1 + bps/10,000), exactly. */
const priceAbove = (a: Price, b: Price, bpsAbove: number): boolean => a.quote * b.base * BPS_DENOMINATOR > b.quote * a.base * (BPS_DENOMINATOR + BigInt(bpsAbove));
const showPrice = (p: Price): string => `${p.quote}/${p.base}`;

// ---------- H1-H4: the mint ----------

const h1: (env: Env) => Outcome = (env) => {
  const r = readMint(env, 'H1');
  if (!r.ok) return fromRead(r);
  return r.fact.owner === TOKEN_PROGRAM || r.fact.owner === TOKEN_2022_PROGRAM
    ? PASS : reject('H1', 'mint-program', `mint owned by ${r.fact.owner}, not SPL Token or Token-2022`, { input: 'mint', value: r.fact.owner });
};

const h2 = (env: Env): Outcome => {
  const m = mintAccount(env, 'H2');
  if (!m.ok) return m.out;
  return m.account.mintAuthority === null ? PASS : reject('H2', 'mint-authority', `mint authority is ${m.account.mintAuthority}`, { input: 'mint', value: m.account.mintAuthority });
};

const h3 = (env: Env): Outcome => {
  const m = mintAccount(env, 'H3');
  if (!m.ok) return m.out;
  return m.account.freezeAuthority === null ? PASS : reject('H3', 'freeze-authority', `freeze authority is ${m.account.freezeAuthority}`, { input: 'mint', value: m.account.freezeAuthority });
};

/** Token-2022 extensions a sellable pump coin may carry (§7.1 H4). DefaultAccountState only as Initialized with no freeze authority. */
const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set(['MetadataPointer', 'TokenMetadata', 'GroupPointer', 'TokenGroup', 'GroupMemberPointer', 'TokenGroupMember']);

const extensionAllowed = (e: Extension, freezeAuthority: string | null): boolean => {
  if (ALLOWED_EXTENSIONS.has(e.kind)) return true;
  if (e.kind === 'DefaultAccountState') return e.fields.state === 'initialized' && freezeAuthority === null;
  return false;
};

const h4 = (env: Env): Outcome => {
  const m = mintAccount(env, 'H4');
  if (!m.ok) return m.out;
  const blocked = m.account.extensions.filter((e) => !extensionAllowed(e, m.account.freezeAuthority)).map((e) => (e.kind === 'unknown' ? `unknown(${e.type})` : e.kind));
  return blocked.length === 0 ? PASS : reject('H4', 'extension-blocked', `blocked Token-2022 extensions: ${blocked.join(', ')}`, { input: 'mint', value: blocked.join(',') });
};

// ---------- H5-H8: venue, pool and liquidity ----------

const h5 = (env: Env): Outcome => {
  const r = readPool(env, 'H5');
  if (!r.ok) return fromRead(r);
  const { pool, owner, address } = r.fact;
  if (owner !== PUMP_AMM_PROGRAM) return reject('H5', 'pool-owner', `pool ${address} is owned by ${owner}, not PumpSwap`, { input: 'pool', value: owner });
  if (pool.baseMint !== env.req.mint) return { reasons: [{ gate: 'H16', code: 'inconsistent', input: 'pool', neededBy: 'H5', detail: `pool base mint ${pool.baseMint} is not ${env.req.mint}` }] };
  if (pool.quoteMint !== NATIVE_MINT) return reject('H5', 'quote-mint', `pool quote mint ${pool.quoteMint} is not wrapped SOL`, { input: 'pool', value: pool.quoteMint });
  if (pool.isMayhemMode === undefined) return { reasons: [{ gate: 'H16', code: 'missing', input: 'pool', neededBy: 'H5', detail: 'pool has no is_mayhem_mode field' }] };
  if (pool.isMayhemMode) return reject('H5', 'mayhem', `pool ${address} is a mayhem-mode coin`, { input: 'pool' });
  const canonical = isCanonicalPool(pool as unknown as Pool, address as Address);
  if (!canonical) return reject('H5', 'not-canonical', `pool ${address} (index ${pool.index}, creator ${pool.creator}) is not the canonical pool`, { input: 'pool' });
  // GATE-1c: the pool's trade events since migration must carry the upgrade's tail as zeros, at the right length.
  const m = readMigration(env, 'H5');
  if (!m.ok) return fromRead(m);
  const ctx = { history: env.history, now: env.ev.now };
  const pt = checkPoolTails(ctx, address, { slot: m.fact.obs.slot, ms: m.fact.migratedAtMs });
  const t = pt.ok ? checkCurveTails(ctx, env.req.mint) : pt;
  if (t.ok) return PASS;
  if (t.code === 'event-tail') return reject('H5', 'event-tail', `unpublished trade-event bytes are live on this SOL pool: ${t.detail}`, { input: 'trades', ...(t.signature ? { value: t.signature } : {}) });
  return { reasons: [{ gate: 'H16', code: t.code, input: 'trades', neededBy: 'H5', detail: t.detail, ...(t.signature ? { value: t.signature } : {}) }] };
};

const h6 = (env: Env): Outcome => {
  const p = readPool(env, 'H6');
  if (!p.ok) return fromRead(p);
  const l = env.ev.read('lp', lpKey(env.req.mint), parseLp, 'state', 'H6');
  if (!l.ok) return fromRead(l);
  if (l.fact.lpMint !== p.fact.pool.lpMint) return { reasons: [{ gate: 'H16', code: 'inconsistent', input: 'lp', neededBy: 'H6', detail: `LP read is for ${l.fact.lpMint}, the pool's LP mint is ${p.fact.pool.lpMint}` }] };
  // Migration LP is burned, so a canonical pool has no LP outstanding. Any outstanding LP is liquidity someone can pull.
  return l.fact.supply === 0n ? PASS : reject('H6', 'lp-withdrawable', `${l.fact.supply} LP tokens outstanding of ${p.fact.pool.lpSupply}`, { input: 'lp', value: String(l.fact.supply), limit: '0' });
};

const h7 = (env: Env): Outcome => {
  const raw = env.ev.raw(migrationKey(env.req.mint));
  if (raw !== undefined) {
    const m = readMigration(env, 'H7');
    return m.ok ? PASS : fromRead(m);
  }
  const c = env.ev.read('curve', curveKey(env.req.mint), parseCurve, 'state', 'H7');
  if (!c.ok) return fromRead(c);
  return c.fact.complete ? reject('H7', 'curve-stuck', 'curve is complete but no migration is recorded', { input: 'curve' }) : PASS;
};

/** R12: max(floor, multiple x size), and the U1 floor for U1. */
const liquidityFloor = (policy: Policy, req: GateRequest): MicroUsd => {
  const { floorUsd, floorNotionalMultiple, u1FloorUsd } = policy.liquidity;
  let floor: bigint = floorUsd;
  const bySize = req.notional * BigInt(floorNotionalMultiple);
  if (bySize > floor) floor = bySize;
  if (req.universe === 'U1' && u1FloorUsd > floor) floor = u1FloorUsd;
  return floor as MicroUsd;
};

const h8 = (env: Env): Outcome => {
  const m = readMigration(env, 'H8');
  if (!m.ok) return fromRead(m);
  const dust = env.policy.gates.dustPoolMinAtMigration;
  if (m.fact.quoteAtMigration < dust) {
    return reject('H8', 'dust-at-migration', `${m.fact.quoteAtMigration} lamports at migration`, { input: 'migration', value: String(m.fact.quoteAtMigration), limit: String(dust) });
  }
  const p = readPool(env, 'H8');
  if (!p.ok) return fromRead(p);
  const s = env.ev.read('sol-usd', SOL_USD_KEY, parseSolUsd, 'series', 'H8');
  if (!s.ok) return fromRead(s);
  const now = env.ev.now.receivedAt;
  const point = solUsdAt(s.fact, now);
  if (point === null) return { reasons: [{ gate: 'H16', code: 'missing', input: 'sol-usd', neededBy: 'H8', detail: 'no SOL/USD point at or before now' }] };
  if (now - point.tMs > HOURLY_MAX_AGE_MS) {
    return { reasons: [{ gate: 'H16', code: 'stale', input: 'sol-usd', neededBy: 'H8', detail: `latest SOL/USD point is ${now - point.tMs} ms old`, value: String(now - point.tMs), limit: String(HOURLY_MAX_AGE_MS) }] };
  }
  const effective = p.fact.quoteVault + (p.fact.pool.virtualQuoteReserves ?? 0n);
  const floor = liquidityFloor(env.policy, env.req);
  // The quote side alone, valued in dollars and rounded down: the literal reading of H8 and the stricter one.
  const usd = effective > 0n ? lamportsToMicroUsd(effective as Lamports, point.price as MicroUsd, 'floor') : 0n;
  return usd >= floor ? PASS : reject('H8', 'below-liquidity-floor', `effective quote reserve ${effective} lamports is ${usd} micro-USD`, { input: 'pool', value: String(usd), limit: String(floor) });
};

// ---------- H9-H11: timing and price path ----------

const h9 = (env: Env): Outcome => {
  const c = readCreate(env, 'H9');
  if (!c.ok) return fromRead(c);
  const m = readMigration(env, 'H9');
  if (!m.ok) return fromRead(m);
  const took = m.fact.graduatedAtMs - c.fact.createdAtMs;
  const min = env.policy.gates.instantGraduationMinMs;
  return took >= min ? PASS : reject('H9', 'instant-graduation', `graduated ${took} ms after creation`, { input: 'migration', value: String(took), limit: String(min) });
};

const h10 = (env: Env): Outcome => {
  const m = readMigration(env, 'H10');
  if (!m.ok) return fromRead(m);
  const since = env.ev.now.receivedAt - m.fact.migratedAtMs;
  const min = env.policy.gates.excludedWindowMs;
  return since >= min ? PASS : reject('H10', 'excluded-window', `${since} ms since migration`, { input: 'migration', value: String(since), limit: String(min) });
};

const h11 = (env: Env): Outcome => {
  const c = env.ev.read('candles', candlesKey(env.req.mint), parseCandles, 'state', 'H11');
  if (!c.ok) return fromRead(c);
  const now = env.ev.now.receivedAt;
  const { candleWindowMs, candleSpikeBps, chaseCheckAfterMs, chaseMaxAboveMigrationBps } = env.policy.gates;
  const { intervalMs } = c.fact;
  // §7.1 names 1-minute candles: shorter ones split a spike into small steps, longer ones blur its timing.
  if (intervalMs !== MINUTE_MS) {
    return { reasons: [{ gate: 'H16', code: 'malformed', input: 'candles', neededBy: 'H11', detail: `candles are ${intervalMs} ms, not 1 minute`, value: String(intervalMs), limit: String(MINUTE_MS) }] };
  }
  const known = c.fact.candles.filter((k) => k.startMs <= now);
  for (const k of known) {
    if (k.startMs + intervalMs > now - candleWindowMs && priceAbove(k.high, k.open, candleSpikeBps)) {
      return reject('H11', 'candle-spike', `candle at ${k.startMs} rose from ${showPrice(k.open)} to ${showPrice(k.high)}`, { input: 'candles', limit: String(candleSpikeBps) });
    }
  }
  if (env.req.universe !== 'U2') return PASS;
  const m = readMigration(env, 'H11');
  if (!m.ok) return fromRead(m);
  const at = m.fact.migratedAtMs + chaseCheckAfterMs;
  // The close of the last candle that ended by migration + 5 min: the price as of that moment.
  let last: (typeof known)[number] | null = null;
  for (const k of known) if (k.startMs + intervalMs <= at && (last === null || k.startMs > last.startMs)) last = k;
  if (last === null || last.startMs + intervalMs <= m.fact.migratedAtMs) {
    return { reasons: [{ gate: 'H16', code: 'not-covered', input: 'candles', neededBy: 'H11', detail: `no candle between migration and ${at}` }] };
  }
  return priceAbove(last.close, m.fact.price, chaseMaxAboveMigrationBps)
    ? reject('H11', 'chase-at-5m', `price ${showPrice(last.close)} at +5 min is above the migration price ${showPrice(m.fact.price)}`, { input: 'candles', limit: String(chaseMaxAboveMigrationBps) })
    : PASS;
};

// ---------- H12-H14: holders, insiders, deployer ----------

type Conc = { ok: true; c: Concentration; create: CreateFact; notes: GateNote[] } | { ok: false; out: Outcome };

const conc = (env: Env, gate: HardGate): Conc => {
  const h = env.ev.read('holders', holdersKey(env.req.mint), parseHolders, 'state', gate);
  if (!h.ok) return { ok: false, out: fromRead(h) };
  const p = readPool(env, gate);
  if (!p.ok) return { ok: false, out: fromRead(p) };
  const cr = readCreate(env, gate);
  if (!cr.ok) return { ok: false, out: fromRead(cr) };
  const pool: PoolFact = p.fact;
  const m = mintAccount(env, gate);
  if (!m.ok) return { ok: false, out: m.out };
  if (m.account.supply !== h.fact.supply) {
    return { ok: false, out: { reasons: [{ gate: 'H16', code: 'inconsistent', input: 'holders', neededBy: gate, detail: `holder read has supply ${h.fact.supply}, the mint ${m.account.supply}` }] } };
  }
  const c = memo(env, 'concentration', () => concentration(h.fact, mintAccounts(env.req.mint, { address: pool.address, baseVault: pool.pool.poolBaseTokenAccount })));
  if (c.circulating <= 0n) return { ok: false, out: reject(gate, 'no-circulating', `supply ${c.supply}, excluded ${c.excluded}`, { input: 'holders' }) };
  const notes: GateNote[] = c.classes.filter((x) => x.cls === 'unknown-program' || x.cls === 'locker')
    .map((x) => (x.cls === 'locker'
      ? { gate, code: 'locker-holder' as const, detail: `${x.address} (owner ${x.owner}, a locker account) kept as a holder` }
      : { gate, code: 'unknown-program-holder' as const, detail: `${x.address} (owner ${x.owner}, a PDA of an unknown program) kept as a holder` }));
  return { ok: true, c, create: cr.fact, notes };
};

const h12 = (env: Env): Outcome => {
  const r = conc(env, 'H12');
  if (!r.ok) return r.out;
  const { c, create, notes } = r;
  const g = env.policy.gates;
  const reasons: GateReason[] = [];
  const top1 = c.top1 === null ? 0n : shareBps(c.top1.amount, c.circulating);
  const dev = shareBps(ownerBalance(c, create.creator).amount, c.circulating);
  const top10 = shareBps(c.top10, c.circulating);
  const of = `of circulating ${c.circulating} (supply ${c.supply}, excluded ${c.excluded})`;
  if (top1 >= BigInt(g.hardHolderBps)) reasons.push({ gate: 'H12', code: 'hard-holder', input: 'holders', detail: `${c.top1?.owner} holds ${top1} bps ${of}`, value: String(top1), limit: String(g.hardHolderBps) });
  if (dev >= BigInt(g.hardHolderBps)) reasons.push({ gate: 'H12', code: 'dev-holder', input: 'holders', detail: `dev ${create.creator} holds ${dev} bps ${of}`, value: String(dev), limit: String(g.hardHolderBps) });
  if (top1 > BigInt(g.singleHolderBps) && top1 < BigInt(g.hardHolderBps)) {
    reasons.push({ gate: 'H12', code: 'single-holder', input: 'holders', detail: `${c.top1?.owner} holds ${top1} bps ${of}`, value: String(top1), limit: String(g.singleHolderBps) });
  }
  if (top10 > BigInt(g.top10Bps)) reasons.push({ gate: 'H12', code: 'top10', input: 'holders', detail: `top 10 hold ${top10} bps ${of}`, value: String(top10), limit: String(g.top10Bps) });
  return { reasons, notes };
};

const h13 = (env: Env): Outcome => {
  const r = conc(env, 'H13');
  if (!r.ok) return r.out;
  const i = env.ev.read('insiders', insidersKey(env.req.mint), parseInsiders, 'event', 'H13');
  if (!i.ok) return fromRead(i);
  if (!i.fact.complete) return { reasons: [{ gate: 'H16', code: 'not-covered', input: 'insiders', neededBy: 'H13', detail: 'insider precompute is not complete' }] };
  const { c, create } = r;
  const notes: GateNote[] = [];
  const held = (wallets: readonly string[]): bigint => {
    let sum = 0n;
    for (const w of [...new Set([create.creator, ...wallets])].sort()) {
      const b = ownerBalance(c, w);
      if (!b.listed) notes.push({ gate: 'H13', code: 'missing-insider-bounded', detail: `${w} is not among the listed holders; counted at the bound ${b.amount}` });
      sum += b.amount;
    }
    return sum;
  };
  const g = env.policy.gates;
  const reasons: GateReason[] = [];
  const insider = shareBps(held(i.fact.insiders), c.circulating);
  if (insider > BigInt(g.insiderBps)) reasons.push({ gate: 'H13', code: 'insider-supply', input: 'insiders', detail: `dev, creation-slot buyers and deployer-funded wallets hold ${insider} bps of circulating`, value: String(insider), limit: String(g.insiderBps) });
  const cluster = shareBps(held(i.fact.devCluster), c.circulating);
  if (cluster > BigInt(g.devClusterBps)) reasons.push({ gate: 'H13', code: 'dev-cluster', input: 'insiders', detail: `the dev's linked cluster holds ${cluster} bps of circulating`, value: String(cluster), limit: String(g.devClusterBps) });
  return { reasons, notes: [...new Map(notes.map((n) => [n.detail, n])).values()] };
};

const h14 = (env: Env): Outcome => {
  const cr = readCreate(env, 'H14');
  if (!cr.ok) return fromRead(cr);
  const now = env.ev.now.receivedAt;
  const g = env.policy.gates;
  const lookback = g.deployerRugLookbackDays * DAY_MS;
  const need = now - Math.max(lookback, DAY_MS);
  // Second guard, whatever built the index: the creates stream must have been complete over the whole look-back.
  const cov = createsCoverage(env.history, env.ev.now, need);
  if (!cov.covered) return { reasons: [{ gate: 'H16', code: 'not-covered', input: 'coverage', neededBy: 'H14', detail: cov.detail }] };
  const d = env.deployers !== undefined
    ? { ok: true as const, fact: env.deployers.factFor(cr.fact.creator, env.ev.now, cov.fromMs) }
    : env.ev.read('deployer', deployerKey(cr.fact.creator), parseDeployer, 'state', 'H14');
  if (!d.ok) return fromRead(d);
  const lost = env.deployers?.lostCreate(need, env.ev.now) ?? null;
  if (lost !== null) {
    return { reasons: [{ gate: 'H16', code: 'not-covered', input: 'coverage', neededBy: 'H14', detail: `creates log ${lost.signature} on ${lost.via} was cut or undecodable at ${lost.atMs} and its transaction is not fetched` }] };
  }
  if (d.fact.coverageFromMs > need) {
    return { reasons: [{ gate: 'H16', code: 'not-covered', input: 'deployer', neededBy: 'H14', detail: `deployer index covers from ${d.fact.coverageFromMs}, the rule needs ${need}` }] };
  }
  const recent = new Set(d.fact.mints.filter((m) => m.createdAtMs > now - DAY_MS && m.createdAtMs <= now).map((m) => m.mint));
  if (cr.fact.createdAtMs > now - DAY_MS) recent.add(env.req.mint);
  const reasons: GateReason[] = [];
  if (recent.size > g.serialMaxMints24h) {
    reasons.push({ gate: 'H14', code: 'serial-deployer', input: 'deployer', detail: `${cr.fact.creator} created ${recent.size} mints in 24 h`, value: String(recent.size), limit: String(g.serialMaxMints24h) });
  }
  // Rug labels count only from a reviewed labeller (an explicit flag) that covered the whole look-back (its own
  // coverage:rugs:* facts). Otherwise the prior-rug half is not judged and says so: no labels is never zero rugs.
  if (env.rugLabeller === undefined) return { reasons, notes: [{ gate: 'H14', code: 'rug-labels-unavailable', detail: RUG_LABELS_UNAVAILABLE }] };
  const rugCov = createsCoverage(env.history, env.ev.now, now - lookback, 'rugs');
  if (!rugCov.covered) {
    return { reasons, notes: [{ gate: 'H14', code: 'rug-labels-unavailable', detail: `${RUG_LABELS_UNAVAILABLE}: ${env.rugLabeller} coverage: ${rugCov.detail}` }] };
  }
  const rugs = d.fact.rugs.filter((x) => x.mint !== env.req.mint && x.knownAtMs <= now && x.knownAtMs >= now - lookback).map((x) => x.mint).sort();
  if (rugs.length > 0) reasons.push({ gate: 'H14', code: 'prior-rug', input: 'deployer', detail: `${cr.fact.creator} rugged ${rugs.join(', ')} within ${g.deployerRugLookbackDays} days`, value: String(rugs.length), limit: '0' });
  return { reasons };
};

// ---------- H15, H16: sellability and cross-checks ----------

const h15 = (env: Env): Outcome => {
  const q = env.req.roundTrip;
  if (!q.ok) return reject('H15', 'round-trip-failed', `no round trip at ${env.req.spend} lamports: ${q.reason} (${q.detail})`, { value: q.reason });
  if (q.trade.spend !== env.req.spend) return reject('H15', 'bad-request', `round trip quoted for ${q.trade.spend}, request spends ${env.req.spend}`);
  if (env.mode === 'backtest') {
    return { reasons: [], notes: [{ gate: 'H15', code: 'live-only-not-applied', detail: 'simulateTransaction is live only; the exact local round trip stands in (§16.3)' }] };
  }
  const s = env.ev.read('sim', simKey(env.req.mint), parseSim, 'offchain', 'H15');
  if (!s.ok) return fromRead(s);
  if (s.fact.spend !== env.req.spend) return { reasons: [{ gate: 'H16', code: 'inconsistent', input: 'sim', neededBy: 'H15', detail: `simulated ${s.fact.spend}, request spends ${env.req.spend}` }] };
  if (!s.fact.ok) return reject('H15', 'sim-failed', `round-trip simulation failed: ${s.fact.error ?? 'no error given'}`, { input: 'sim' });
  const simLoss = s.fact.paid - s.fact.proceeds;
  const modelled = q.trade.paid - q.trade.proceeds + ROUND_TRIP_ROUNDING_LAMPORTS;
  return simLoss > modelled
    ? reject('H15', 'sim-loss', `simulated round trip lost ${simLoss} lamports, the model allows ${modelled}`, { input: 'sim', value: String(simLoss), limit: String(modelled) })
    : PASS;
};

const AUTHORITY_FIELDS = ['mintAuthority', 'freezeAuthority'] as const;

const h16 = (env: Env): Outcome => {
  if (env.mode === 'backtest') {
    return { reasons: [], notes: [{ gate: 'H16', code: 'live-only-not-applied', detail: 'third-party cross-checks are live only (§16.3); staleness still applies' }] };
  }
  const m = mintAccount(env, 'H16');
  if (!m.ok) return m.out;
  const x = env.ev.read('xcheck', xcheckKey(env.req.mint), parseXcheck, 'offchain', 'H16');
  if (!x.ok) return fromRead(x);
  const own = { mintAuthority: m.account.mintAuthority === null ? 'none' : 'set', freezeAuthority: m.account.freezeAuthority === null ? 'none' : 'set' } as const;
  const reported = x.fact.sources.filter((s) => s.mintAuthority !== null || s.freezeAuthority !== null);
  if (reported.length === 0) return { reasons: [{ gate: 'H16', code: 'missing', input: 'xcheck', neededBy: 'H16', detail: 'no third party reported the authorities' }] };
  const reasons: GateReason[] = [];
  for (const s of [...reported].sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0))) {
    for (const field of AUTHORITY_FIELDS) {
      const theirs = s[field];
      if (theirs !== null && theirs !== own[field]) {
        reasons.push({ gate: 'H16', code: 'xcheck-disagree', input: 'xcheck', detail: `${s.provider} reads ${field} as ${theirs}, our read is ${own[field]}`, value: theirs, limit: own[field] });
      }
    }
  }
  return { reasons };
};

// ---------- Order and evaluation ----------

/**
 * Cheapest first: 0 compares fields of facts already read; 1 derives addresses (PDAs) or classifies holders;
 * 2 checks a quote and a simulation. Within a cost, table order (§7.1). Fixed, so the same input gives the same result.
 */
const STEPS: readonly { readonly gate: HardGate; readonly cost: 0 | 1 | 2; readonly run: (env: Env) => Outcome }[] = [
  { gate: 'H1', cost: 0, run: h1 },
  { gate: 'H2', cost: 0, run: h2 },
  { gate: 'H3', cost: 0, run: h3 },
  { gate: 'H4', cost: 0, run: h4 },
  { gate: 'H6', cost: 0, run: h6 },
  { gate: 'H7', cost: 0, run: h7 },
  { gate: 'H8', cost: 0, run: h8 },
  { gate: 'H9', cost: 0, run: h9 },
  { gate: 'H10', cost: 0, run: h10 },
  { gate: 'H11', cost: 0, run: h11 },
  { gate: 'H14', cost: 0, run: h14 },
  { gate: 'H16', cost: 0, run: h16 },
  { gate: 'H5', cost: 1, run: h5 },
  { gate: 'H12', cost: 1, run: h12 },
  { gate: 'H13', cost: 1, run: h13 },
  { gate: 'H15', cost: 2, run: h15 },
];

export const HARD_ORDER: readonly { readonly gate: HardGate; readonly cost: 0 | 1 | 2 }[] = STEPS.map(({ gate, cost }) => ({ gate, cost }));

const requestProblem = (req: GateRequest): string | null => {
  if (typeof req.mint !== 'string' || !isMint(req.mint)) return `mint "${String(req.mint)}" is not a 32-byte address`;
  if (!['U1', 'U2', 'U3', 'S0'].includes(req.universe)) return `unknown universe ${String(req.universe)}`;
  if (typeof req.spend !== 'bigint' || req.spend <= 0n) return 'spend must be positive';
  if (typeof req.notional !== 'bigint' || req.notional <= 0n) return 'notional must be > 0';
  return null;
};

/** Evaluates H1-H16 as of `ctx.now`. Pure: the same context, policy and request always give the same result. */
export const evaluateHardRejects = (ctx: GateContext, deps: GateDeps, req: GateRequest, options: HardOptions = {}): HardResult => {
  const stopAtFirst = options.stopAtFirst ?? true;
  const base = { mode: deps.mode, mint: String(req.mint) };
  const fail = (code: RejectCode, detail: string): HardResult =>
    ({ ...base, pass: false, evaluated: [], passed: [], failed: ['H16'], reasons: [{ gate: 'H16', code, detail }], notes: [] });
  if (!deps.session.running) return fail('policy-session-ended', 'the policy session has ended; start a new session');
  const problem = requestProblem(req);
  if (problem !== null) return fail('bad-request', problem);
  const env: Env = { ev: new Evidence(ctx, deps.session.policy), history: (k, f, t) => ctx.history(k, f, t), deployers: ctx.deployers, rugLabeller: deps.rugLabeller, policy: deps.session.policy, mode: deps.mode, req, memo: new Map() };
  const evaluated: HardGate[] = [];
  const passed: HardGate[] = [];
  const failed: HardGate[] = [];
  const reasons: GateReason[] = [];
  const notes: GateNote[] = [];
  for (const step of STEPS) {
    const out = step.run(env);
    evaluated.push(step.gate);
    notes.push(...(out.notes ?? []));
    if (out.reasons.length === 0) {
      passed.push(step.gate);
      continue;
    }
    failed.push(step.gate);
    reasons.push(...out.reasons);
    if (stopAtFirst) break;
  }
  return { ...base, pass: reasons.length === 0, evaluated, passed, failed, reasons, notes };
};

