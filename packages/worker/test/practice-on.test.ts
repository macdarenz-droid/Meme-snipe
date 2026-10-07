// PRACTICE-ON, then RESUME-WORKER: the host's S0 shakedown runs only for its diagnostic, with no paper edge, so it makes
// no trade (owner, 2026-10-06: no knowingly losing trades). Its settings reach the worker through the one place that
// reads the environment, a shakedown boot passes parity, /health names the entry rule, risk refuses every entry, and the
// qualifying run still refuses all of it (DECISIONS "Resume: the release's worker, no practice trades").
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CURVE_VOLUME_KEY, EXEC_HEALTH_KEY, GRADUATES_KEY, S0_DIAGNOSTIC_PARTS, simKey } from '../../core/src/gates/index.ts';
import { readEnvironment, ENV_NAMES } from '../boot/environment.ts';
import { SHAKEDOWN_WALLET, parseConfig } from '../src/run/config.ts';
import { strategyConfig } from '../src/run/settings.ts';
import { walletDerived } from '../src/dryrun/standin.ts';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { usd } from '../../core/src/config/amounts.ts';
import { feasibleSize, pumpSwapRoundTrip } from '../../core/src/costs/index.ts';
import { type MicroUsd, bps, lamportsToMicroUsd, microUsd, microUsdToLamports } from '../../core/src/units/index.ts';
import { findProgramAddress, isOnCurve } from '../../core/src/chain/address.ts';
import {
  NATIVE_MINT, PUMP_AMM_GLOBAL_CONFIG, PUMP_AMM_PROGRAM, PUMP_PROGRAM, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, decodeBase58, toAddress,
} from '../../core/src/chain/index.ts';
import { HELIUS_SENDER_TIP_ACCOUNTS } from '../../core/src/tx/programs.ts';
import { s0EntryAt } from '../src/engine/strategy.ts';
import { blockNetwork } from './helpers.ts';
import { MIGRATED_AT, MINT, T, makeWorker, passingMarket } from './worker-harness.ts';

blockNetwork();

const ROOT = join(import.meta.dirname, '..', '..', '..');
const DAY = 86_400_000;
const HELD = { heldPoolFacts: true } as const;
const from = MIGRATED_AT + 60 * 60_000;
const to = MIGRATED_AT + 240 * 60_000;
const early = (() => {
  for (let k = 0; ; k++) if (s0EntryAt(`salt-${k}`, MINT, from, to) < T - 60_000) return `salt-${k}`;
})();

/** Runs `f` with these process environment values (undefined deletes), then puts the environment back. */
const withEnv = <R>(vars: Record<string, string | undefined>, f: () => R): R => {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const set = (v: Record<string, string | undefined>) => {
    for (const [k, x] of Object.entries(v)) if (x === undefined) delete process.env[k]; else process.env[k] = x;
  };
  set(vars);
  try {
    return f();
  } finally {
    set(before);
  }
};

describe('the worker environment', () => {
  it('carries ZEROED_S0_DIAGNOSTIC from the process to the config, as main.ts reads it', () => {
    const env = withEnv({
      ZEROED_STATE_DIR: '/tmp/practice-on', ZEROED_MODE: 'paper', ZEROED_STRATEGY: 'S0', ZEROED_S0_DIAGNOSTIC: 'on', ZEROED_PAPER_EDGE_PPM: undefined,
      CREDENTIALS_DIRECTORY: undefined,
    }, () => readEnvironment());
    expect(env.env['ZEROED_S0_DIAGNOSTIC']).toBe('on');
    const p = parseConfig(env.env, () => null, null);
    expect(p.ok && p.config.strategy).toEqual({ name: 'S0', paperEdgePpm: null, qualifying: false, s0Diagnostic: true });
    // Read, it still meets every refusal: no S0, or a release that names a qualifying run.
    const noS0 = withEnv({ ZEROED_STATE_DIR: '/tmp/practice-on', ZEROED_MODE: 'paper', ZEROED_STRATEGY: undefined, ZEROED_PAPER_EDGE_PPM: undefined, ZEROED_S0_DIAGNOSTIC: 'on' }, () => readEnvironment());
    expect(parseConfig(noS0.env, () => null, null)).toMatchObject({ ok: false, message: 'refused: ZEROED_S0_DIAGNOSTIC is only for the S0 shakedown' });
    expect(parseConfig({ ...env.env, ZEROED_RUN_ID: 'shakedown-1' }, () => null, 'qual-1')).toMatchObject({ ok: false, message: 'refused: ZEROED_S0_DIAGNOSTIC is never used in a release with a qualifying run' });
  });

  it('reads every ZEROED_ setting config.ts reads (a name missing from ENV_NAMES could never be set in production)', () => {
    const src = readFileSync(join(ROOT, 'packages/worker/src/run/config.ts'), 'utf8');
    const read = [...new Set([...src.matchAll(/env\['([A-Z0-9_]+)'\]/g)].map((m) => m[1]!))];
    expect(read.length).toBeGreaterThan(15);
    expect(read.filter((n) => !(ENV_NAMES as readonly string[]).includes(n))).toEqual([]);
  });
});

/** An S0 shakedown boot as the host runs it, with or without the set: rejects that rely on the set's parts when it is on. */
const shakedownBoot = async (diag: boolean) => {
  const h = makeWorker({ edgePpm: 0n, entry: { timing: 'random', salt: early, s0Diagnostic: diag }, config: { ZEROED_STRATEGY: 'S0', ...(diag ? { ZEROED_S0_DIAGNOSTIC: 'on' } : {}) } });
  expect(await h.worker.reconcile()).toEqual({ ok: true });
  const m = await passingMarket(h, { ...HELD, omit: [CURVE_VOLUME_KEY, GRADUATES_KEY, EXEC_HEALTH_KEY, simKey(MINT)], coverageAt: T - 2 * DAY });
  await m.run(4_000, 400, () => {
    m.slot();
    m.pool();
  });
  await h.worker.stop();
  return h.stateDir;
};
const journalOf = (dir: string) => join(dir, 'journal.jsonl');
const linesOf = (dir: string) => readFileSync(journalOf(dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const parity = (dir: string) => spawnSync(process.execPath, ['--no-warnings', join(ROOT, 'packages/worker/scripts/parity.ts'), dir, '--replays', '2'], { encoding: 'utf8' });
/** Rewrites the journal's start line (its first) with `f`; `extra` appends further lines after it. */
const editStart = (dir: string, f: (start: Record<string, unknown>) => Record<string, unknown>, extra: (start: Record<string, unknown>) => Record<string, unknown>[] = () => []) => {
  const text = readFileSync(journalOf(dir), 'utf8').trim().split('\n');
  const at = text.findIndex((l) => (JSON.parse(l) as { kind: string }).kind === 'start');
  const start = JSON.parse(text[at]!) as Record<string, unknown>;
  text.splice(at, 1, JSON.stringify(f(start)), ...extra(start).map((x) => JSON.stringify(x)));
  writeFileSync(journalOf(dir), `${text.join('\n')}\n`);
};

describe('parity of an S0 shakedown boot with the diagnostic set', () => {
  it('the parity command rebuilds the set from the start line and replays the boot to its live decisions', async () => {
    const dir = await shakedownBoot(true);
    const journal = linesOf(dir);
    expect(journal.find((l) => l['kind'] === 'start')).toMatchObject({ entry_rule: 'S0', s0_salt: early, s0_diagnostic: S0_DIAGNOSTIC_PARTS });
    // The comparison covers lines that only the set produces.
    expect(journal.some((l) => l['kind'] === 'decision' && Array.isArray(l['s0_diagnostic']))).toBe(true);
    const run = parity(dir);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ ok: true });
  });

  it('an S0 boot without the set replays without it', async () => {
    const dir = await shakedownBoot(false);
    const journal = linesOf(dir);
    expect(journal.find((l) => l['kind'] === 'start')).toMatchObject({ entry_rule: 'S0', s0_diagnostic: null });
    expect(journal.some((l) => l['kind'] === 'decision' && l['action'] === 'reject')).toBe(true);
    const run = parity(dir);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });

  it('boots that differ in the set are refused: replay them one by one', async () => {
    const dir = await shakedownBoot(true);
    editStart(dir, (s) => s, (s) => [{ ...s, seq: Number(s['seq']) + 0.5, boot: 'boot-other', s0_diagnostic: null }]);
    const run = parity(dir);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('ran another policy or strategy than boot');
  });

  it('a set other than this code\'s is refused', async () => {
    const dir = await shakedownBoot(true);
    editStart(dir, (s) => ({ ...s, s0_diagnostic: ['regime-volume', 'exec-health'] }));
    const run = parity(dir);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('this code has');
  });

  it('a set on an entry rule other than S0 is refused', async () => {
    const dir = await shakedownBoot(true);
    editStart(dir, (s) => ({ ...s, entry_rule: 'none' }));
    const run = parity(dir);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('names S0\'s diagnostic set on entry rule none');
  });
});

describe('/health on the shakedown', () => {
  it('names the entry rule and the diagnostic parts; a worker on none names none and no set', () => {
    const s0 = makeWorker({ entry: { timing: 'random', salt: 'S0', s0Diagnostic: true }, config: { ZEROED_STRATEGY: 'S0', ZEROED_S0_DIAGNOSTIC: 'on' } });
    expect(s0.worker.health()).toMatchObject({ entry_rule: 'S0', s0_diagnostic: S0_DIAGNOSTIC_PARTS, mode: 'paper' });
    const none = makeWorker();
    expect(none.worker.health().entry_rule).toBe('none');
    expect(none.worker.health().s0_diagnostic).toBeUndefined();
  });
});

// The host's shakedown values (ops/host-config.json) and the rules each one is derived from.
const HOST = JSON.parse(readFileSync(join(ROOT, 'ops/host-config.json'), 'utf8')) as { shakedown: Record<string, string> };
const SHAKEDOWN = HOST.shakedown;
const hostEnv = (more: Record<string, string> = {}) => ({ ZEROED_STATE_DIR: '/tmp/practice-on', ZEROED_MODE: 'paper', ...SHAKEDOWN, ...more });

describe("the host's shakedown settings", () => {
  it('parse to S0 with the diagnostic set, no paper edge, the stand-in and the keyless wallet', () => {
    expect(Object.keys(SHAKEDOWN).sort()).toEqual(['ZEROED_S0_DIAGNOSTIC', 'ZEROED_STANDINS', 'ZEROED_STRATEGY', 'ZEROED_WALLET']);
    const p = parseConfig(hostEnv(), () => null, null);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.config.strategy).toEqual({ name: 'S0', paperEdgePpm: null, qualifying: false, s0Diagnostic: true });
    expect(p.config.standIns).toEqual(['CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM']);
    expect(p.config.wallet).toBe(SHAKEDOWN_WALLET);
  });

  it('are refused in any release that names a qualifying run, with or without a run id', () => {
    for (const runId of [undefined, '', 'qual-1', 'shakedown-1']) {
      const env = hostEnv(runId === undefined ? {} : { ZEROED_RUN_ID: runId });
      const p = parseConfig(env, () => null, 'qual-1');
      expect(p.ok, String(runId)).toBe(false);
    }
    // With the old practice edge too.
    expect(parseConfig(hostEnv({ ZEROED_PAPER_EDGE_PPM: '178092' }), () => null, 'qual-1').ok).toBe(false);
    // The keyless wallet alone (no S0, no edge, no set) is refused there too: items 3 and 4 need the signer's wallet.
    expect(parseConfig({ ZEROED_STATE_DIR: '/tmp/practice-on', ZEROED_MODE: 'paper', ZEROED_RUN_ID: 'rehearsal-1', ZEROED_WALLET: SHAKEDOWN_WALLET }, () => null, 'qual-1'))
      .toMatchObject({ ok: false, message: expect.stringContaining('ZEROED_WALLET is the shakedown') });
    expect(parseConfig({ ZEROED_STATE_DIR: '/tmp/practice-on', ZEROED_MODE: 'paper', ZEROED_WALLET: SHAKEDOWN_WALLET }, () => null, null).ok).toBe(true);
  });

  it('the wallet is the program-derived address of "zeroed-shakedown-wallet": off the curve, so no key exists for it', () => {
    const pda = findProgramAddress(['zeroed-shakedown-wallet'], SYSTEM_PROGRAM);
    expect(pda.address).toBe(SHAKEDOWN_WALLET);
    expect(isOnCurve(decodeBase58(SHAKEDOWN_WALLET))).toBe(false);
  });

  it('the stand-in can stand in (TEST-2, SIM-1): not the wallet and named by no PumpSwap build, so the structure check holds', () => {
    const standIn = SHAKEDOWN['ZEROED_STANDINS']!;
    expect(standIn).not.toBe(SHAKEDOWN_WALLET);
    // A stand-in that a build also names (a tip account, a program) collides with it: sameStructure refuses that leg.
    expect(HELIUS_SENDER_TIP_ACCOUNTS).not.toContain(standIn);
    expect([SYSTEM_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, PUMP_AMM_PROGRAM, PUMP_PROGRAM, NATIVE_MINT, PUMP_AMM_GLOBAL_CONFIG]).not.toContain(standIn);
    // The wallet's own derived accounts never equal the stand-in's.
    const mint = toAddress('4gBSeMHUHK4yhgvjRYuMYsRaep3iTSDzxMMmdCQhoPgU');
    const real = walletDerived(toAddress(SHAKEDOWN_WALLET), mint, TOKEN_2022_PROGRAM);
    const stand = walletDerived(toAddress(standIn), mint, TOKEN_2022_PROGRAM);
    expect(real.filter((a) => stand.includes(a))).toEqual([]);
  });
});

describe("the host's shakedown makes no trade: no paper edge, so risk refuses every entry", () => {
  // Owner (2026-10-06): no knowingly losing trades, never as practice. The host runs S0 with its diagnostic set only so
  // the hard gates are evaluated and logged; with no ZEROED_PAPER_EDGE_PPM, main.ts gives risk an edge of 0.
  const boot = async (edgePpm: bigint) => {
    const h = makeWorker({ edgePpm, entry: { timing: 'random', salt: early, s0Diagnostic: true }, config: { ...SHAKEDOWN } });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    // The parts the set waives stay missing, as on the host today; every hard gate's own inputs are there.
    const m = await passingMarket(h, { ...HELD, omit: [CURVE_VOLUME_KEY, GRADUATES_KEY, EXEC_HEALTH_KEY], coverageAt: T - 2 * DAY });
    await m.run(4_000, 100, () => m.pool());
    await m.run(10_000, 400, () => {
      m.slot();
      m.pool();
    });
    const entries = Object.values(h.worker.book.intents).filter((i) => i.intent.purpose === 'entry');
    await h.worker.stop();
    const decisions = linesOf(h.stateDir).filter((l) => l['kind'] === 'decision' && l['action'] === 'reject').map((l) => (l['reasons'] as string[])[3]!);
    return { entries, decisions, journal: linesOf(h.stateDir) };
  };

  it('a candidate that passes every hard gate is refused by risk (expected net not positive) and no entry intent is made', async () => {
    expect(SHAKEDOWN).not.toHaveProperty('ZEROED_PAPER_EDGE_PPM');
    const p = parseConfig(hostEnv(), () => null, null);
    if (!p.ok) throw new Error(p.message);
    expect(p.config.strategy).toEqual({ name: 'S0', paperEdgePpm: null, qualifying: false, s0Diagnostic: true });
    // As main.ts builds it: the parsed edge, or 0 when none is set.
    expect(readFileSync(join(ROOT, 'packages/worker/src/main.ts'), 'utf8')).toContain('config.strategy.paperEdgePpm ?? 0n');
    const run = await boot(p.config.strategy.paperEdgePpm ?? 0n);
    expect(run.journal.find((l) => l['kind'] === 'start')).toMatchObject({ entry_rule: 'S0', paper_edge_ppm: null, qualifying: false, s0_diagnostic: S0_DIAGNOSTIC_PARTS });
    expect(run.entries).toEqual([]);
    expect(run.journal.some((l) => l['kind'] === 'entry' || l['action'] === 'enter')).toBe(false);
    // Past the hard gates (none of them rejects it), risk refuses it on R14: no edge clears the cost.
    expect(run.decisions.some((r) => r.startsWith('hard reject'))).toBe(false);
    const risk = run.decisions.filter((r) => r.startsWith('risk '));
    expect(risk.length).toBeGreaterThan(0);
    for (const r of risk) expect(r).toMatch(/^risk R14 expected_net_not_positive: sizing refused: edge-not-above-cost/);
  });

  it('the same candidate with the old practice edge (178,092 ppm) would have been entered: only the edge stops it', async () => {
    const run = await boot(178_092n);
    expect(run.entries.length).toBeGreaterThan(0);
  });
});

describe('the former practice edge (no longer on the host): the smallest that let a first S0 trade pass the cost gate at the trial size', () => {
  // As risk sizes at the minimum stage (core risk/evaluate.ts): q from minNotional to max(minNotional, its lamports
  // rounded up), the policy's impact limit, and the minimum size must clear its fixed costs. The thinnest pool the
  // liquidity floor admits, at PumpSwap's highest canonical tier (1.25%: lp 2, protocol 93, creator 30 bps; RESEARCH.md),
  // and the first trade of a fresh paper wallet, which also pays the one-time volume-accumulator rent.
  const SOL_HIGH = '205.32'; // Coinbase SOL-USD daily high, 20 Oct 2025 to 4 Oct 2026 (DECISIONS "Practice trades on the host")
  const firstTradePasses = (edgePpm: bigint, solUsd: string, oneTime = true) => {
    const c = strategyConfig(TRIAL_POLICY, FILL_CONFIG, RESEARCH_CONFIG, edgePpm, { timing: 'random', salt: 'S0', s0Diagnostic: true });
    const price = usd(solUsd);
    const qMin = TRIAL_POLICY.capital.minNotional;
    const minSpend = microUsdToLamports(qMin, price, 'ceil');
    const minSpendUsd = lamportsToMicroUsd(minSpend, price, 'ceil');
    const qCap = (minSpendUsd > qMin ? minSpendUsd : qMin) as MicroUsd;
    const quoteSide = microUsdToLamports(microUsd(TRIAL_POLICY.liquidity.floorUsd / 2n), price, 'ceil');
    const pool = { baseReserve: 200_000_000_000_000n, quoteVault: quoteSide, virtualQuoteReserves: 0n };
    const fees = { lp: bps(2), protocol: bps(93), creator: bps(30) };
    const ctx = {
      feeConfig: { flatFees: fees, feeTiers: [{ marketCapThreshold: 0n, fees }], exoticFlatFees: { lp: bps(0), protocol: bps(0), creator: bps(0) } },
      canonical: true, quote: 'sol' as const, baseSupply: 1_000_000_000_000_000n, creatorFeeCharged: true,
      coin: { mayhemMode: false, transferFee: false, transferHook: false }, instruction: 'v2' as const, buybackFeeBps: bps(5_000),
    };
    const big = microUsd(qCap + 1_000_000_000n);
    const s = feasibleSize({
      quote: pumpSwapRoundTrip(pool, ctx), solPrice: price, edgePpm, network: c.network, rent: { ...c.rent, oneTime: oneTime ? c.rent.oneTime : 0n },
      policy: { minNotional: qMin, maxNotional: qCap, maxImpactPpm: BigInt(TRIAL_POLICY.liquidity.maxImpactBps) * 100n },
      caps: { lossAllowance: big, riskBudget: big, executableDepth: qCap, cash: big },
    });
    return s.trade && s.range.minLamports <= minSpend;
  };

  it('178,092 ppm passes at the year-high SOL price and 178,091 does not; lower SOL prices need less', () => {
    const edge = 178_092n;
    expect(firstTradePasses(edge, SOL_HIGH)).toBe(true);
    expect(firstTradePasses(edge - 1n, SOL_HIGH)).toBe(false);
    // At the price on 4 Oct 2026 the first trade needs 115,529 ppm, later trades 32,019: the edge covers both.
    expect(firstTradePasses(115_529n, '120.94')).toBe(true);
    expect(firstTradePasses(115_528n, '120.94')).toBe(false);
    expect(firstTradePasses(32_019n, '120.94', false)).toBe(true);
    expect(firstTradePasses(32_018n, '120.94', false)).toBe(false);
    expect(firstTradePasses(edge, '120.94')).toBe(true);
  });
});
