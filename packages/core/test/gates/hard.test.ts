// GATE-1: a fixture that triggers each hard reject and one that passes (docs/ARCHITECTURE.md §7.1, §20 GATE-1).
// The passing world is real mainnet state (world.ts); each trigger changes one fact.
import { describe, expect, it } from 'vitest';
import { decodeMint, fromBase64, type Address } from '../../src/chain/index.ts';
import { noQuote } from '../../src/amm/index.ts';
import type { QualityFlag } from '../../src/domain/index.ts';
import {
  DAY_MS, HARD_GATES, HARD_ORDER, MINUTE_MS, SOL_USD_KEY,
  candlesKey, createKey, curveKey, deployerKey, evaluateHardRejects, holdersKey, insidersKey, lpKey, migrationKey, mintKey,
  poolKey, simKey, streamKey, xcheckKey,
  type GateReason, type HardGate, type HardResult, type Mode,
} from '../../src/gates/index.ts';
import {
  BASE_VAULT, CREATED_AT, DEV, MIGRATED_AT, MIGRATION_PRICE, MINT, NON_CANONICAL_POOL, NOW, POOL, POOL_ADDRESS, QUOTE_VAULT, SLOT, SPEND, SUPPLY, T,
  ACC, SOL_PRICE, VAULT_AMOUNT, W, account, balanced, contextOf, decodedPool, deps, drop, holderAccounts, obs, passingFacts, patch, request, roundTrip, session, streamObs, type Facts,
} from './world.ts';
import { microUsd } from '../../src/units/index.ts';
import { NATIVE_MINT, PUMP_AMM_PROGRAM } from '../../src/chain/index.ts';

const run = (facts: Facts, mode: Mode = 'live', req = request(), all = false): HardResult =>
  evaluateHardRejects(contextOf(facts), deps(mode, session(), 'RUG-1'), req, { stopAtFirst: !all });

/** Every reason of every gate, with all gates evaluated. */
const reasonsOf = (facts: Facts, mode: Mode = 'live', req = request()): readonly GateReason[] => run(facts, mode, req, true).reasons;
const codesFor = (r: readonly GateReason[], gate: HardGate) => r.filter((x) => x.gate === gate || x.neededBy === gate).map((x) => x.code);

const mintFrom = (label: string) => {
  const a = account(label);
  return { owner: a.owner, account: decodeMint(fromBase64(a.dataBase64), a.owner as Address) };
};
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';

describe('the passing world', () => {
  it.each(['live', 'backtest'] as const)('passes every hard reject in %s mode', (mode) => {
    const r = run(passingFacts(), mode, request(), true);
    expect(r.reasons).toEqual([]);
    expect(r.pass).toBe(true);
    expect(r.passed).toEqual(HARD_ORDER.map((s) => s.gate));
  });

  it('records the live-only vetoes it did not apply in the backtest', () => {
    const notes = run(passingFacts(), 'backtest').notes.filter((n) => n.code === 'live-only-not-applied').map((n) => n.gate);
    expect(notes).toEqual(['H16', 'H15']);
    expect(run(passingFacts(), 'live').notes.filter((n) => n.code === 'live-only-not-applied')).toEqual([]);
  });
});

/** [gate, trigger name, change to the passing world (or request), expected reject code]. */
type Case = readonly [HardGate, string, (f: Facts) => Facts, string, ReturnType<typeof request>?, Mode?];
const mintPatch = (m: ReturnType<typeof mintFrom>) => (f: Facts) => patch(f, mintKey(MINT), m);
const withExtensions = (extensions: unknown[]) => (f: Facts) => {
  const base = mintFrom(MINT);
  return patch(f, mintKey(MINT), { account: { ...base.account, extensions } });
};
const holders = (accounts: ReturnType<typeof holderAccounts>) => (f: Facts) => patch(f, holdersKey(MINT), { accounts: balanced(accounts) });

const CASES: readonly Case[] = [
  ['H1', 'a mint owned by another program', (f) => patch(f, mintKey(MINT), { owner: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', account: null }), 'mint-program'],
  ['H2', 'a mint authority (USDC, mainnet)', mintPatch(mintFrom(USDC)), 'mint-authority'],
  ['H3', 'a freeze authority (USDC, mainnet)', (f) => patch(f, mintKey(MINT), { account: { ...mintFrom(MINT).account, freezeAuthority: mintFrom(USDC).account.freezeAuthority } }), 'freeze-authority'],
  ['H4', 'PermanentDelegate, TransferHook, TransferFeeConfig (PYUSD, mainnet)', (f) => patch(f, mintKey(MINT), { account: { ...mintFrom(PYUSD).account, mintAuthority: null, freezeAuthority: null } }), 'extension-blocked'],
  ['H4', 'an unknown extension type', withExtensions([{ kind: 'unknown', type: 99, data: '' }]), 'extension-blocked'],
  ['H4', 'DefaultAccountState frozen', withExtensions([{ kind: 'DefaultAccountState', type: 6, fields: { state: 'frozen' }, data: '02' }]), 'extension-blocked'],
  ['H5', 'a non-canonical pool (mainnet)', (f) => patch(f, poolKey(MINT), { address: NON_CANONICAL_POOL, pool: { ...decodedPool(NON_CANONICAL_POOL), baseMint: MINT, quoteMint: POOL.quoteMint } }), 'not-canonical'],
  ['H5', 'a pool owned by another program', (f) => patch(f, poolKey(MINT), { owner: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C' }), 'pool-owner'],
  ['H5', 'a mayhem-mode pool', (f) => patch(f, poolKey(MINT), { pool: { ...POOL, isMayhemMode: true } }), 'mayhem'],
  ['H5', 'a USDC-quoted pool', (f) => patch(f, poolKey(MINT), { pool: { ...POOL, quoteMint: USDC } }), 'quote-mint'],
  ['H6', 'outstanding LP tokens', (f) => patch(f, lpKey(MINT), { supply: 1_000n }), 'lp-withdrawable'],
  ['H7', 'a complete curve with no migration', (f) => drop(f, migrationKey(MINT)).set(curveKey(MINT), { value: { obs: streamObs(), complete: true }, moment: { ...NOW, slot: SLOT - 500n, receivedAt: T - 200_000 } }), 'curve-stuck'],
  ['H8', 'under 5 SOL at migration', (f) => patch(f, migrationKey(MINT), { quoteAtMigration: 4_999_999_999n }), 'dust-at-migration'],
  ['H8', 'below the U1 floor of $50k', (f) => f, 'below-liquidity-floor', request({ universe: 'U1' })],
  ['H8', 'below $15k at a lower SOL price', (f) => patch(f, SOL_USD_KEY, { points: [{ tMs: T, price: 50_000_000n }] }), 'below-liquidity-floor'],
  ['H9', 'graduation 4 min 59 s after creation', (f) => patch(f, migrationKey(MINT), { graduatedAtMs: CREATED_AT + 5 * MINUTE_MS - 1 }), 'instant-graduation'],
  ['H10', 'inside 60 min of migration', (f) => patch(f, migrationKey(MINT), { migratedAtMs: T - 60 * MINUTE_MS + 1 }), 'excluded-window'],
  ['H11', 'a +25.01% candle in the last 3 minutes', (f) => patch(f, candlesKey(MINT), {
    candles: [{ startMs: T - 3 * MINUTE_MS + 1, open: { quote: 10_000n, base: 1n }, high: { quote: 12_501n, base: 1n }, close: { quote: 10_000n, base: 1n } }],
  }), 'candle-spike'],
  ['H11', 'above the migration price at +5 min (U2)', (f) => patch(f, candlesKey(MINT), {
    candles: [{ startMs: MIGRATED_AT + 4 * MINUTE_MS, open: MIGRATION_PRICE, high: MIGRATION_PRICE, close: { quote: MIGRATION_PRICE.quote + 1n, base: MIGRATION_PRICE.base } }],
  }), 'chase-at-5m'],
  ['H12', 'one wallet with 40% of circulating', holders([...holderAccounts(), { mint: MINT, delegate: null, delegatedAmount: 0n, address: ACC('whale'), owner: W('whale'), ownerProgram: null, amount: 200_000_000_000_000n }]), 'hard-holder'],
  ['H12', 'the dev with 40% of circulating', holders([...holderAccounts(), { mint: MINT, delegate: null, delegatedAmount: 0n, address: ACC('devbag'), owner: DEV, ownerProgram: null, amount: 200_000_000_000_000n }]), 'dev-holder'],
  ['H12', 'one wallet above 10%', holders([...holderAccounts(), { mint: MINT, delegate: null, delegatedAmount: 0n, address: ACC('big'), owner: W('big'), ownerProgram: null, amount: 40_000_000_000_000n }]), 'single-holder'],
  ['H12', 'top 10 above 30%', holders(holderAccounts().map((a, i) => (i >= 2 && i < 12 ? { ...a, amount: 9_100_000_000_000n } : a))), 'top10'],
  ['H13', 'insiders above 15%', (f) => patch(f, insidersKey(MINT), { insiders: [0, 1, 2, 3, 4, 5].map(W) }), 'insider-supply'],
  ['H13', "the dev's cluster above 5%", (f) => patch(f, insidersKey(MINT), { devCluster: [W(0), W(1)] }), 'dev-cluster'],
  ['H14', 'a third mint in 24 h', (f) => patch(f, deployerKey(DEV), { mints: [{ mint: MINT, createdAtMs: CREATED_AT }, { mint: 'A', createdAtMs: T - DAY_MS + 1 }, { mint: 'B', createdAtMs: T - 1 }] }), 'serial-deployer'],
  ['H14', 'a rug 14 days ago', (f) => patch(f, deployerKey(DEV), { rugs: [{ mint: 'Old1', knownAtMs: T - 14 * DAY_MS }] }), 'prior-rug'],
  ['H15', 'no round trip at size', (f) => f, 'round-trip-failed', request({ roundTrip: noQuote('exceeds-reserves', 'too big') })],
  ['H15', 'a failed simulation (live)', (f) => patch(f, simKey(MINT), { ok: false, proceeds: 0n, error: 'custom program error: 0x1772' }), 'sim-failed'],
  ['H15', 'a simulation that loses more than the model', (f) => patch(f, simKey(MINT), { proceeds: 1n }), 'sim-loss'],
  ['H16', 'a third party reads a mint authority (live)', (f) => patch(f, xcheckKey(MINT), { sources: [{ provider: 'rugcheck', mintAuthority: 'set', freezeAuthority: 'none' }] }), 'xcheck-disagree'],
  ['H16', 'stale pool state (3 slots)', (f) => patch(f, poolKey(MINT), { obs: obs({ slot: SLOT - 3n }) }), 'stale'],
  // TX-1b: H4 allows these (sellable), but the builders cannot trade them, so the shape gate rejects before any entry.
  ['H17', 'a GroupPointer extension', withExtensions([...mintFrom(MINT).account.extensions, { kind: 'GroupPointer', type: 20, fields: { authority: null, groupAddress: null }, data: '' }]), 'unsupported-shape'],
  ['H17', 'DefaultAccountState initialized', withExtensions([...mintFrom(MINT).account.extensions, { kind: 'DefaultAccountState', type: 6, fields: { state: 'initialized' }, data: '01' }]), 'unsupported-shape'],
  ['H17', 'a cashback pool', (f) => patch(f, poolKey(MINT), { pool: { ...POOL, isCashbackCoin: true } }), 'unsupported-shape'],
  ['H17', 'a 287-byte pool (needs extend_account)', (f) => patch(f, poolKey(MINT), { accountBytes: 287 }), 'unsupported-shape'],
  ['H17', 'pool account size not read', (f) => patch(f, poolKey(MINT), { accountBytes: undefined }), 'missing'],
  ['H17', 'cashback flag not read', (f) => patch(f, poolKey(MINT), { pool: { ...POOL, isCashbackCoin: undefined } }), 'missing'],
];

describe('each hard reject has a trigger and a pass', () => {
  it.each(CASES.map((c) => [`${c[0]}: ${c[1]}`, c] as const))('%s', (_n, [gate, , change, code, req]) => {
    const world = passingFacts();
    const r = reasonsOf(change(world), 'live', req ?? request());
    expect(codesFor(r, gate)).toContain(code);
    // The same gate passes on the untouched world.
    expect(codesFor(reasonsOf(world), gate)).toEqual([]);
  });

  it('covers every gate', () => {
    expect(new Set(CASES.map((c) => c[0]))).toEqual(new Set(HARD_GATES));
  });

  it('rejects at the boundaries the policy names and passes just inside them', () => {
    const world = passingFacts();
    const at = (f: Facts, gate: HardGate) => codesFor(reasonsOf(f), gate);
    expect(at(patch(world, migrationKey(MINT), { graduatedAtMs: CREATED_AT + 5 * MINUTE_MS }), 'H9')).toEqual([]);
    expect(at(patch(world, migrationKey(MINT), { migratedAtMs: T - 60 * MINUTE_MS }), 'H10')).toEqual([]);
    expect(at(patch(world, migrationKey(MINT), { quoteAtMigration: 5_000_000_000n }), 'H8')).toEqual([]);
    expect(at(patch(world, poolKey(MINT), { obs: obs({ slot: SLOT - 2n }) }), 'H5')).toEqual([]);
    expect(at(patch(world, deployerKey(DEV), { rugs: [{ mint: 'Old1', knownAtMs: T - 14 * DAY_MS - 1 }] }), 'H14')).toEqual([]);
    expect(at(patch(world, deployerKey(DEV), { mints: [{ mint: MINT, createdAtMs: CREATED_AT }, { mint: 'A', createdAtMs: T - DAY_MS }, { mint: 'B', createdAtMs: T - 1 }] }), 'H14')).toEqual([]);
    expect(at(patch(world, candlesKey(MINT), {
      candles: [
        { startMs: MIGRATED_AT + 4 * MINUTE_MS, open: MIGRATION_PRICE, high: MIGRATION_PRICE, close: MIGRATION_PRICE },
        { startMs: T - 3 * MINUTE_MS + 1, open: { quote: 10_000n, base: 1n }, high: { quote: 12_500n, base: 1n }, close: { quote: 10_000n, base: 1n } },
      ],
    }), 'H11')).toEqual([]);
  });

  it('allows DefaultAccountState only as Initialized with no freeze authority', () => {
    const ok = withExtensions([{ kind: 'DefaultAccountState', type: 6, fields: { state: 'initialized' }, data: '01' }])(passingFacts());
    expect(codesFor(reasonsOf(ok), 'H4')).toEqual([]);
  });

  it('applies the chase check only to U2', () => {
    const chase = patch(passingFacts(), candlesKey(MINT), {
      candles: [{ startMs: MIGRATED_AT + 4 * MINUTE_MS, open: MIGRATION_PRICE, high: MIGRATION_PRICE, close: { quote: MIGRATION_PRICE.quote * 2n, base: MIGRATION_PRICE.base } }],
    });
    expect(codesFor(reasonsOf(chase, 'live', request({ universe: 'S0' })), 'H11')).toEqual([]);
  });
});

describe('unknown, stale or degraded input rejects with a reason (H16)', () => {
  const FLAGS: readonly QualityFlag[] = ['fork-suspect', 'provider-degraded', 'partial', 'estimated', 'rate-limited'];
  it.each(FLAGS)('a %s flag on pool state rejects', (flag) => {
    const r = reasonsOf(patch(passingFacts(), poolKey(MINT), { obs: obs({ quality: [flag] }) }));
    expect(r).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'degraded', input: 'pool', value: flag }));
  });

  it.each(FLAGS)('a %s flag on the stream that keeps the mint current rejects', (flag) => {
    const f = patch(passingFacts(), streamKey('chain'), { obs: obs({ slot: SLOT - 1n, quality: [flag] }) });
    expect(reasonsOf(f)).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'degraded', input: 'stream', neededBy: 'H1' }));
  });

  it('a chain read at processed commitment rejects; one without a commitment is malformed', () => {
    const processed = reasonsOf(patch(passingFacts(), holdersKey(MINT), { obs: obs({ commitment: 'processed' }) }));
    expect(processed).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'degraded', input: 'holders', value: 'processed' }));
    const { commitment: _c, ...bare } = obs();
    const none = reasonsOf(patch(passingFacts(), migrationKey(MINT), { obs: bare }));
    expect(none).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'malformed', input: 'migration' }));
    const head = reasonsOf(patch(passingFacts(), streamKey('chain'), { obs: obs({ commitment: 'processed' }) }));
    expect(head).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'degraded', input: 'stream' }));
  });

  it('backfilled and deduplicated are not degradation', () => {
    const f = patch(passingFacts(), poolKey(MINT), { obs: obs({ quality: ['backfilled', 'deduplicated'] }) });
    expect(run(f).pass).toBe(true);
  });

  it.each([
    ['mint', mintKey(MINT), 'H1'], ['pool', poolKey(MINT), 'H6'], ['lp', lpKey(MINT), 'H6'], ['create', createKey(MINT), 'H9'],
    ['migration', migrationKey(MINT), 'H8'], ['candles', candlesKey(MINT), 'H11'], ['holders', holdersKey(MINT), 'H12'],
    ['insiders', insidersKey(MINT), 'H13'], ['deployer', deployerKey(DEV), 'H14'], ['sim', simKey(MINT), 'H15'], ['xcheck', xcheckKey(MINT), 'H16'],
    ['sol-usd', SOL_USD_KEY, 'H8'],
  ] as const)('missing %s rejects, naming the gate that needed it', (input, key, neededBy) => {
    const r = reasonsOf(drop(passingFacts(), key));
    expect(r).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'missing', input, neededBy }));
  });

  it('a malformed value rejects', () => {
    const r = reasonsOf(patch(passingFacts(), holdersKey(MINT), { supply: -1n }));
    expect(r).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'malformed', input: 'holders' }));
  });

  it('chain state more than 2 slots old rejects; a one-shot read is judged on its own slot', () => {
    const r = reasonsOf(patch(passingFacts(), holdersKey(MINT), { obs: obs({ slot: SLOT - 3n }) }));
    expect(r).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'stale', input: 'holders', value: '3', limit: '2' }));
  });

  it('with an observed tip (a backtest\'s observation delay), chain state is judged against it, never past now', () => {
    const withTip = (facts: Facts, observedTip: bigint) =>
      evaluateHardRejects({ ...contextOf(facts), observedTip }, deps('live', session(), 'RUG-1'), request(), { stopAtFirst: false }).reasons;
    const stale = (r: readonly GateReason[], input: string) => r.filter((x) => x.code === 'stale' && x.input === input);
    // Seen 3 slots late: a value read at the newest observed slot is fresh, and a stream head there keeps it current.
    const late = patch(patch(passingFacts(), holdersKey(MINT), { obs: obs({ slot: SLOT - 3n }) }), streamKey('chain'), { obs: obs({ slot: SLOT - 3n }) });
    expect(stale(withTip(late, SLOT - 3n), 'holders')).toEqual([]);
    expect(stale(withTip(late, SLOT - 3n), 'stream')).toEqual([]);
    // Older than the tip by more than 2 slots is stale, as live.
    const old = stale(withTip(patch(passingFacts(), holdersKey(MINT), { obs: obs({ slot: SLOT - 6n }) }), SLOT - 3n), 'holders');
    expect(old.length).toBeGreaterThan(0);
    for (const r of old) expect(r).toMatchObject({ value: '3', limit: '2' });
    // A tip ahead of the clock is not believed: now's slot is used.
    const ahead = stale(withTip(late, SLOT + 10n), 'holders');
    expect(ahead.length).toBeGreaterThan(0);
    for (const r of ahead) expect(r).toMatchObject({ value: '3' });
  });

  it('a stream head more than 2 slots behind makes every value it keeps stale', () => {
    const f = patch(passingFacts(), streamKey('chain'), { obs: obs({ slot: SLOT - 3n }) });
    expect(reasonsOf(f)).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'stale', input: 'stream', neededBy: 'H1' }));
  });

  it('a stream gap after the value was observed rejects (dataset gaps are flagged, never filled)', () => {
    const f = patch(passingFacts(), streamKey('chain'), { gapFreeSince: SLOT - 100n });
    expect(reasonsOf(f, 'backtest')).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'gap', input: 'stream', neededBy: 'H1' }));
  });

  it('off-chain reads older than 2 s reject (live)', () => {
    const f = patch(passingFacts(), simKey(MINT), { obs: obs({ slot: null, receivedAt: T - 2_001 }) });
    expect(reasonsOf(f)).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'stale', input: 'sim', neededBy: 'H15', value: '2001', limit: '2000' }));
    const ok = patch(passingFacts(), simKey(MINT), { obs: obs({ slot: null, receivedAt: T - 2_000 }) });
    expect(codesFor(reasonsOf(ok), 'H15')).toEqual([]);
  });

  it('a value whose own stamp is after now rejects as future', () => {
    const r = reasonsOf(patch(passingFacts(), poolKey(MINT), { obs: obs({ slot: SLOT + 1n }) }));
    expect(r).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'future', input: 'pool' }));
  });

  it('a deployer index younger than the 14-day look-back is not covered', () => {
    const r = reasonsOf(patch(passingFacts(), deployerKey(DEV), { coverageFromMs: T - 14 * DAY_MS + 1 }));
    expect(r).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'not-covered', input: 'deployer', neededBy: 'H14' }));
  });

  it('an incomplete insider precompute is not covered', () => {
    const r = reasonsOf(patch(passingFacts(), insidersKey(MINT), { complete: false }));
    expect(r).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'not-covered', input: 'insiders', neededBy: 'H13' }));
  });

  it('a pool without the is_mayhem_mode field is unknown', () => {
    const { isMayhemMode: _drop, ...older } = POOL;
    const r = reasonsOf(patch(passingFacts(), poolKey(MINT), { pool: older }));
    expect(r).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'missing', input: 'pool', neededBy: 'H5' }));
  });

  it('no candle after migration means the +5 min price is unknown (U2)', () => {
    const r = reasonsOf(patch(passingFacts(), candlesKey(MINT), { candles: [] }));
    expect(r).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'not-covered', input: 'candles', neededBy: 'H11' }));
  });

  it('a third-party check that reports nothing is unknown (live)', () => {
    const r = reasonsOf(patch(passingFacts(), xcheckKey(MINT), { sources: [{ provider: 'goplus', mintAuthority: null, freezeAuthority: null }] }));
    expect(r).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'missing', input: 'xcheck' }));
  });

  it('live-only inputs are absent in the backtest, never required: missing sim and cross-checks do not reject there', () => {
    const f = drop(drop(passingFacts(), simKey(MINT)), xcheckKey(MINT));
    expect(run(f, 'backtest').pass).toBe(true);
    expect(run(f, 'live').pass).toBe(false);
  });

  it('every other input is required in the backtest too', () => {
    const r = reasonsOf(drop(passingFacts(), holdersKey(MINT)), 'backtest');
    expect(r).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'missing', input: 'holders' }));
  });
});

describe('evaluation', () => {
  it('runs cheapest first, in a fixed order that names every gate once', () => {
    const costs = HARD_ORDER.map((s) => s.cost);
    expect([...costs].sort()).toEqual(costs);
    expect(new Set(HARD_ORDER.map((s) => s.gate)).size).toBe(17);
  });

  it('stops at the first failing gate by default and names it', () => {
    const f = patch(patch(passingFacts(), mintKey(MINT), mintFrom(USDC)), lpKey(MINT), { supply: 5n });
    const r = run(f);
    expect(r.failed).toEqual(['H2']);
    expect(r.evaluated).toEqual(['H1', 'H2']);
    const all = run(f, 'live', request(), true);
    expect(all.failed).toEqual(expect.arrayContaining(['H2', 'H3', 'H6']));
    expect(all.evaluated).toHaveLength(17);
  });

  it('gives the same result for the same input, every time (determinism)', () => {
    const f = patch(passingFacts(), holdersKey(MINT), { accounts: [...holderAccounts()].reverse() });
    const first = JSON.stringify(run(f, 'live', request(), true), (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v));
    for (let i = 0; i < 10; i++) {
      expect(JSON.stringify(run(f, 'live', request(), true), (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v))).toBe(first);
    }
    // Holder order in the input does not change the result.
    expect(run(passingFacts(), 'live', request(), true)).toEqual(run(f, 'live', request(), true));
  });

  it('reads every threshold from the session policy', () => {
    const strict = session({ maxStateSlotLag: 0 });
    const r = evaluateHardRejects(contextOf(passingFacts()), { session: strict, mode: 'live' }, request(), { stopAtFirst: false });
    expect(r.reasons).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'stale', input: 'pool', limit: '0' }));
    const tightHolder = evaluateHardRejects(contextOf(passingFacts()), { session: session({ singleHolderBps: 200 }), mode: 'live' }, request(), { stopAtFirst: false });
    expect(codesFor(tightHolder.reasons, 'H12')).toContain('single-holder');
  });

  it('refuses an ended session and a malformed request', () => {
    const s = session();
    s.end();
    expect(evaluateHardRejects(contextOf(passingFacts()), { session: s, mode: 'live' }, request()).reasons[0]?.code).toBe('policy-session-ended');
    expect(run(passingFacts(), 'live', request({ mint: 'not-a-mint' })).reasons[0]?.code).toBe('bad-request');
    expect(run(passingFacts(), 'live', request({ spend: 0n as never })).reasons[0]?.code).toBe('bad-request');
  });

  it('every reason is plain data the journal can hash', () => {
    const r = run(patch(passingFacts(), lpKey(MINT), { supply: 7n }), 'live', request(), true);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    expect(r.reasons[0]).toEqual({ gate: 'H6', code: 'lp-withdrawable', input: 'lp', detail: `7 LP tokens outstanding of ${POOL.lpSupply}`, value: '7', limit: '0' });
  });

  it('uses the real vault balances of the mainnet pool', () => {
    expect(BASE_VAULT).toBeGreaterThan(0n);
    expect(QUOTE_VAULT).toBeGreaterThan(5_000_000_000n);
    expect(SUPPLY).toBeGreaterThan(0n);
    expect(POOL_ADDRESS).toBe('9KBF3KqYErfs1NXRK35gb4J8wnAD2i9ePZAzcwn7yhFT');
    expect(SPEND).toBe(13_000_000n);
  });
});

// Review round 1 (PR #22): every trigger and boundary the mutation run found untested.
describe('boundaries found by mutation testing', () => {
  const codes = (f: Facts, gate: HardGate, req = request()) => codesFor(reasonsOf(f, 'live', req), gate);
  const effective = QUOTE_VAULT + (POOL.virtualQuoteReserves ?? 0n);
  const usd = (effective * SOL_PRICE) / 1_000_000_000n;

  it('a: the R12 floor rises with trade size (1,000 x notional)', () => {
    const fail = usd / 1_000n + 1n; // floor = notional x 1,000 > usd
    const pass = usd / 1_000n;
    expect(codes(passingFacts(), 'H8', request({ notional: microUsd(fail) }))).toEqual(['below-liquidity-floor']);
    expect(codes(passingFacts(), 'H8', request({ notional: microUsd(pass) }))).toEqual([]);
  });

  it('b: a SOL/USD point more than 2 h old is stale for H8; exactly 2 h is not', () => {
    const at = (tMs: number) => patch(passingFacts(), SOL_USD_KEY, { points: [{ tMs, price: SOL_PRICE }] });
    expect(reasonsOf(at(T - 2 * 60 * MINUTE_MS - 1))).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'stale', input: 'sol-usd', neededBy: 'H8' }));
    expect(codes(at(T - 2 * 60 * MINUTE_MS), 'H8')).toEqual([]);
  });

  it('c: a negative virtual quote reserve lowers the effective reserve', () => {
    const f = patch(passingFacts(), poolKey(MINT), { pool: { ...POOL, virtualQuoteReserves: -(QUOTE_VAULT - 1_000_000_000n) } });
    expect(codes(f, 'H8')).toEqual(['below-liquidity-floor']);
  });

  it('d: a holder at exactly 40% of circulating is a hard reject', () => {
    // The whale takes its tokens from the vault: whale = 2/3 of the other holders is 40% of circulating exactly.
    const others = holderAccounts().filter((a) => a.owner !== POOL_ADDRESS);
    const rest = others.reduce((s, a) => s + a.amount, 0n);
    const trim = rest % 3n;
    const accounts = others.map((a, i) => (i === others.length - 1 ? { ...a, amount: a.amount - trim } : a));
    const whale = { mint: MINT, delegate: null, delegatedAmount: 0n, address: ACC('w40'), owner: W('w40'), ownerProgram: null, amount: ((rest - trim) * 2n) / 3n };
    const exact = balanced([...holderAccounts().filter((a) => a.owner === POOL_ADDRESS), ...accounts, whale]);
    expect(codes(patch(passingFacts(), holdersKey(MINT), { accounts: exact }), 'H12')).toEqual(['hard-holder', 'top10']);
  });

  it('e: the H15 tolerance is the rounding bound exactly; a simulated spend that differs is inconsistent', () => {
    const q = roundTrip();
    if (!q.ok) throw new Error('quote');
    expect(codes(patch(passingFacts(), simKey(MINT), { proceeds: q.trade.proceeds - 16n }), 'H15')).toEqual([]);
    expect(codes(patch(passingFacts(), simKey(MINT), { proceeds: q.trade.proceeds - 17n }), 'H15')).toEqual(['sim-loss']);
    expect(reasonsOf(patch(passingFacts(), simKey(MINT), { spend: SPEND + 1n }))).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'inconsistent', input: 'sim', neededBy: 'H15' }));
  });

  it('f: a pool for another mint and an LP read for another LP mint are inconsistent', () => {
    expect(reasonsOf(patch(passingFacts(), poolKey(MINT), { pool: { ...POOL, baseMint: NATIVE_MINT } }))).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'inconsistent', input: 'pool', neededBy: 'H5' }));
    expect(reasonsOf(patch(passingFacts(), lpKey(MINT), { lpMint: NATIVE_MINT }))).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'inconsistent', input: 'lp', neededBy: 'H6' }));
  });

  it('g: the dev counts in the insider total; this mint counts in the serial total', () => {
    const circulating = SUPPLY - VAULT_AMOUNT; // the dev's bag comes from the vault: about 20% of the new circulating
    const devBag = balanced(holderAccounts().map((a) => (a.owner === DEV ? { ...a, amount: circulating / 4n } : a)));
    const f = patch(patch(passingFacts(), holdersKey(MINT), { accounts: devBag }), insidersKey(MINT), { insiders: [], devCluster: [] });
    expect(codes(f, 'H13')).toEqual(['insider-supply', 'dev-cluster']);
    const two = patch(passingFacts(), deployerKey(DEV), { mints: [{ mint: 'A', createdAtMs: T - 1_000 }, { mint: 'B', createdAtMs: T - 2_000 }] });
    expect(codes(two, 'H14')).toEqual(['serial-deployer']);
  });

  it('h: a value received after now is future even with a valid slot; a missing stream head rejects', () => {
    expect(reasonsOf(patch(passingFacts(), poolKey(MINT), { obs: obs({ receivedAt: T + 1 }) }))).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'future', input: 'pool' }));
    expect(reasonsOf(drop(passingFacts(), streamKey('chain')))).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'missing', input: 'stream', neededBy: 'H1' }));
  });

  it('i: a SOL/USD point dated after now inside a snapshot received before now is never used', () => {
    const f = patch(passingFacts(), SOL_USD_KEY, { points: [{ tMs: T - 3 * 60 * MINUTE_MS, price: SOL_PRICE }, { tMs: T + 1_000, price: SOL_PRICE }] });
    expect(reasonsOf(f)).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'stale', input: 'sol-usd', neededBy: 'H8' }));
  });

  it('j: the 3-minute candle window and the +5 min candle have exact edges', () => {
    const spike = (startMs: number) => ({ startMs, open: { quote: 100n, base: 1n }, high: { quote: 200n, base: 1n }, close: { quote: 100n, base: 1n } });
    const chase = { startMs: MIGRATED_AT + 4 * MINUTE_MS, open: MIGRATION_PRICE, high: MIGRATION_PRICE, close: MIGRATION_PRICE };
    const withCandles = (candles: unknown[]) => patch(passingFacts(), candlesKey(MINT), { candles });
    // A candle that ended exactly 3 minutes ago is outside the window; one that ended 1 ms later is inside.
    expect(codes(withCandles([chase, spike(T - 4 * MINUTE_MS)]), 'H11')).toEqual([]);
    expect(codes(withCandles([chase, spike(T - 4 * MINUTE_MS + 1)]), 'H11')).toEqual(['candle-spike']);
    // The +5 min price is a candle that ended by migration + 5 min and after migration.
    expect(codes(withCandles([{ ...chase, startMs: MIGRATED_AT + 4 * MINUTE_MS + 1 }]), 'H11')).toEqual(['not-covered']);
    expect(codes(withCandles([{ ...chase, startMs: MIGRATED_AT - MINUTE_MS }]), 'H11')).toEqual(['not-covered']);
  });
});

describe('review round 1 blockers', () => {
  it('a whale in a non-canonical PumpSwap pool or a pump PDA is still a holder', () => {
    const extra = 20_000_000_000_000n;
    const plain = balanced(holderAccounts().concat({ mint: MINT, delegate: null, delegatedAmount: 0n, address: ACC('x'), owner: W('x'), ownerProgram: null, amount: extra }));
    expect(codesFor(reasonsOf(patch(passingFacts(), holdersKey(MINT), { accounts: plain })), 'H12')).toContain('top10');
    for (const ownerProgram of [PUMP_AMM_PROGRAM, '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P']) {
      const hidden = balanced(holderAccounts().concat({ mint: MINT, delegate: null, delegatedAmount: 0n, address: ACC('x'), owner: NON_CANONICAL_POOL, ownerProgram, amount: extra }));
      expect(codesFor(reasonsOf(patch(passingFacts(), holdersKey(MINT), { accounts: hidden })), 'H12')).toContain('top10');
    }
  });

  it('candles that are not 1 minute long are malformed (a 1 s series could split a spike)', () => {
    const f = patch(passingFacts(), candlesKey(MINT), { intervalMs: 1_000 });
    expect(reasonsOf(f)).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'malformed', input: 'candles', neededBy: 'H11' }));
  });

  it('a holder read whose supply differs from the mint is inconsistent', () => {
    const f = patch(passingFacts(), holdersKey(MINT), { supply: SUPPLY + 1n });
    expect(reasonsOf(f)).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'inconsistent', input: 'holders', neededBy: 'H12' }));
  });
});

describe('review round 2 blockers', () => {
  it('a locker-owned 40% balance is a holder and rejects under H12, with a note', () => {
    const locker = { mint: MINT, delegate: null, delegatedAmount: 0n, address: ACC('locker40'), owner: ACC('locker-pda'), ownerProgram: 'LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE', amount: ((SUPPLY - VAULT_AMOUNT) * 2n) / 3n + 1n };
    const r = run(patch(passingFacts(), holdersKey(MINT), { accounts: balanced([...holderAccounts(), locker]) }), 'live', request(), true);
    expect(codesFor(r.reasons, 'H12')).toContain('hard-holder');
    expect(r.notes).toContainEqual(expect.objectContaining({ gate: 'H12', code: 'locker-holder' }));
  });

  it('top 10 at exactly 30% of circulating passes; one unit more rejects', () => {
    // Ten wallets hold 30 units of 100 in circulation, seventy wallets 1 each; the vault holds the rest of the supply.
    const unit = 1_000_000_000_000n;
    const vault = holderAccounts().filter((a) => a.owner === POOL_ADDRESS);
    const build = (extra: bigint) => balanced([
      ...vault,
      ...Array.from({ length: 10 }, (_, i) => ({ mint: MINT, delegate: null, delegatedAmount: 0n, address: ACC(`top${i}`), owner: W(`top${i}`), ownerProgram: null, amount: 3n * unit + (i === 0 ? extra : 0n) })),
      ...Array.from({ length: 70 }, (_, i) => ({ mint: MINT, delegate: null, delegatedAmount: 0n, address: ACC(`low${i}`), owner: W(`low${i}`), ownerProgram: null, amount: unit })),
    ]);
    expect(codesFor(reasonsOf(patch(passingFacts(), holdersKey(MINT), { accounts: build(0n) })), 'H12')).toEqual([]);
    const over = reasonsOf(patch(passingFacts(), holdersKey(MINT), { accounts: build(1n) }));
    expect(over).toContainEqual(expect.objectContaining({ gate: 'H12', code: 'top10', value: '3001', limit: '3000' }));
  });
});
