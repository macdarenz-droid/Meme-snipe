// GATE-1d: holder concentration cannot be hidden by splitting a balance across accounts the view does not list.
// The reviewer's case: the dev truly holds 50% of circulating in many small accounts; the largest-accounts view
// lists one of them (about 1.4%). H12/H13 must not pass on that view. Tokens no listed account holds could all
// belong to any one owner, listed or not, so the gates pass a partial view only when that worst case stays inside
// every limit; otherwise they need a complete account set.
import { describe, expect, it } from 'vitest';
import { INCINERATOR, RAYDIUM_LOCKER_PROGRAM, evaluateHardRejects, holdersKey, insidersKey, type GateReason, type HolderAccount } from '../../src/gates/index.ts';
import { ACC, DEV, MINT, POOL, POOL_ADDRESS, SUPPLY, VAULT_AMOUNT, W, contextOf, deps, holderAccounts, passingFacts, patch, request, session, type Facts } from './world.ts';

const CIRC = SUPPLY - VAULT_AMOUNT;
const vault: HolderAccount = { address: POOL.poolBaseTokenAccount, owner: POOL_ADDRESS, ownerProgram: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', amount: VAULT_AMOUNT };
const acct = (owner: string, amount: bigint, tag: string, ownerProgram: string | null = null): HolderAccount => ({ address: ACC(tag), owner, ownerProgram, amount });
/** `total` split over `n` accounts of one owner. */
const split = (owner: string, total: bigint, n: number, tag: string): HolderAccount[] =>
  Array.from({ length: n }, (_, i) => acct(owner, i === 0 ? total - (total / BigInt(n)) * BigInt(n - 1) : total / BigInt(n), `${tag}${i}`));

/** `total` spread over `n` wallets of one account each. */
const spread = (total: bigint, n: number, tag: string): HolderAccount[] =>
  Array.from({ length: n }, (_, i) => acct(W(`${tag}${i}`), i === 0 ? total - (total / BigInt(n)) * BigInt(n - 1) : total / BigInt(n), `${tag}${i}`));

/** The truth: the dev owns 50% of circulating in 100 accounts; 50 other wallets share the rest. */
const truth = (): HolderAccount[] => [vault, ...split(DEV, CIRC / 2n, 100, 'dev'), ...Array.from({ length: 50 }, (_, i) => split(W(`o${i}`), (CIRC - CIRC / 2n) / 50n + (i === 0 ? (CIRC - CIRC / 2n) % 50n : 0n), 1, `o${i}-`)).flat()];

/** What getTokenLargestAccounts shows: the 20 largest accounts only. */
const largest = (all: readonly HolderAccount[], n = 20): HolderAccount[] =>
  [...all].sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : a.address < b.address ? -1 : 1)).slice(0, n);

const sum = (as: readonly HolderAccount[]): bigint => as.reduce((s, a) => s + a.amount, 0n);
const evaluate = (f: Facts) => evaluateHardRejects(contextOf(f), deps('live', session(), 'RUG-1'), request(), { stopAtFirst: false });
const view = (accounts: readonly HolderAccount[], coverage: 'all' | 'largest', f = passingFacts()): Facts => patch(f, holdersKey(MINT), { accounts, coverage });
const concentrationReasons = (f: Facts): readonly GateReason[] =>
  evaluate(f).reasons.filter((r) => r.gate === 'H12' || r.gate === 'H13' || r.neededBy === 'H12' || r.neededBy === 'H13');
const notCovered = (neededBy: 'H12' | 'H13', unlisted: bigint) => expect.objectContaining({ gate: 'H16', code: 'not-covered', input: 'holders', neededBy, value: String(unlisted) });

describe('split-account bypass (GATE-1d)', () => {
  it('the truth sums to the supply, and the complete account view rejects the dev at 50% (H12 dev-holder, H13)', () => {
    expect(sum(truth())).toBe(SUPPLY);
    const codes = concentrationReasons(view(truth(), 'all')).map((x) => x.code);
    expect(codes).toEqual(expect.arrayContaining(['dev-holder', 'insider-supply', 'dev-cluster']));
  });

  it('the largest-accounts view of the same holders is not covered for H12 and H13', () => {
    const shown = largest(truth());
    const devShown = sum(shown.filter((a) => a.owner === DEV));
    expect((devShown * 10_000n) / CIRC).toBeLessThan(200n); // the dev looks like about 1.4%
    expect(concentrationReasons(view(shown, 'largest'))).toEqual([notCovered('H12', SUPPLY - sum(shown)), notCovered('H13', SUPPLY - sum(shown))]);
  });

  it('owners left out of the view with many small accounts each are not covered', () => {
    // Eight unlisted wallets hold 9% of circulating each in 50 accounts of 0.18%; every listed holder is small.
    const listed = [vault, ...Array.from({ length: 19 }, (_, i) => acct(W(`l${i}`), CIRC / 100n, `l${i}`))];
    const hidden = Array.from({ length: 8 }, (_, k) => split(W(`h${k}`), (CIRC * 9n) / 100n, 50, `h${k}-`)).flat();
    const all = [...listed, ...hidden, ...spread(SUPPLY - sum(listed) - sum(hidden), 100, 'dust')];
    expect(sum(all)).toBe(SUPPLY);
    expect(largest(all)).toEqual(largest(listed)); // the view the RPC returns is the listed accounts
    const r = concentrationReasons(view(listed, 'largest'));
    expect(r).toContainEqual(notCovered('H12', SUPPLY - sum(listed)));
    expect(r.filter((x) => x.gate === 'H12')).toEqual([]); // nothing listed breaks a limit on its own
    // The complete set of the same holders is judged on what it shows: each of them under 10%, top 10 above 30%.
    expect(concentrationReasons(view(all, 'all')).map((x) => x.code)).toEqual(['top10']);
  });

  it('a listed owner with extra accounts the view does not show is not covered', () => {
    // The dev shows 3.5% in one listed account and holds 40% more in 200 accounts below the listed ones.
    const others = holderAccounts().filter((a) => a.owner !== POOL_ADDRESS && a.owner !== DEV);
    const devListed = acct(DEV, (CIRC * 35n) / 1_000n, 'dev-listed');
    const devHidden = split(DEV, (CIRC * 40n) / 100n, 200, 'dev-hidden');
    const v = { ...vault, amount: SUPPLY - sum(others) - devListed.amount - sum(devHidden) };
    const all = [v, devListed, ...devHidden, ...others];
    expect(sum(all)).toBe(SUPPLY);
    const shown = largest(all);
    expect(shown.filter((a) => a.owner === DEV)).toEqual([devListed]);
    expect(concentrationReasons(view(shown, 'largest'))).toEqual([notCovered('H12', SUPPLY - sum(shown)), notCovered('H13', SUPPLY - sum(shown))]);
    // Complete: the dev's 43.5% came from the vault, so it is about 30% of the larger circulating (above 10%, under 40%).
    expect(concentrationReasons(view(all, 'all')).map((x) => x.code)).toEqual(expect.arrayContaining(['single-holder', 'insider-supply', 'dev-cluster']));
  });

  it('a partial view passes only while all unlisted tokens on the top 10 stay at 30%; one unit more is not covered', () => {
    // Listed: the passing world without its small wallets. Top 10 listed hold 80/271.6 (29.45%); H13 has more room.
    const core = holderAccounts().slice(0, 32); // the vault, the dev and the thirty wallets
    const top10 = 10n * 8_000_000_000_000n;
    const room = (CIRC * 3_000n) / 10_000n - top10; // unlisted tokens that keep top 10 + all of them at 3000 bps
    const shownWith = (unlisted: bigint): HolderAccount[] => {
      const seen = SUPPLY - sum(core) - unlisted;
      return [...core, ...Array.from({ length: Number(seen / 1_000_000_000_000n) + 1 }, (_, i) => i).map((i) => acct(W(`seen${i}`), i === 0 ? seen % 1_000_000_000_000n : 1_000_000_000_000n, `seen${i}`))];
    };
    expect(sum(shownWith(room))).toBe(SUPPLY - room);
    expect(concentrationReasons(view(shownWith(room), 'largest'))).toEqual([]);
    expect(concentrationReasons(view(shownWith(room + 1n), 'largest'))).toEqual([notCovered('H12', room + 1n)]);
  });

  it('H13 alone: unlisted tokens that could take the dev cluster over 5% are not covered, while H12 has room', () => {
    // Thirty wallets of 6e12 (top 10 at 22%, room about 21e12); the cluster is the dev and W(0): 10e12, 3.68% (room about 3.6e12).
    const core = [vault, acct(DEV, 4_000_000_000_000n, DEV), ...Array.from({ length: 30 }, (_, i) => acct(W(i), 6_000_000_000_000n, W(i)))];
    const f = patch(passingFacts(), insidersKey(MINT), { devCluster: [W(0)] });
    const roomH13 = (CIRC * 500n) / 10_000n - 10_000_000_000_000n;
    // The rest of the listed supply sits in 40 small wallets, each below the thirty.
    const small = (unlisted: bigint) => [...core, ...spread(SUPPLY - sum(core) - unlisted, 40, 'rest')];
    expect(concentrationReasons(view(small(roomH13), 'largest', f))).toEqual([]);
    expect(concentrationReasons(view(small(roomH13 + 1n), 'largest', f))).toEqual([notCovered('H13', roomH13 + 1n)]);
  });

  // Each worst-case bound decides on its own: one test per bound where it is the tightest.
  const bps = (n: bigint) => (CIRC * n) / 10_000n;
  /** Unlisted tokens that keep `held` + all of them at `limit` bps of circulating. */
  const room = (limit: bigint, held: bigint) => (limit * CIRC - 10_000n * held) / 10_000n;
  const withBig = (big: readonly HolderAccount[], unlisted: bigint) => [vault, ...big, ...spread(CIRC - sum(big) - unlisted, 200, 'small')];

  it('the top-holder bound: one wallet at 8% leaves room for 2% unlisted; one unit more is not covered', () => {
    const big = [acct(W(0), bps(800n), 'big0'), ...Array.from({ length: 9 }, (_, i) => acct(W(i + 1), bps(100n), `big${i + 1}`))];
    const u = room(1_000n, bps(800n));
    expect(concentrationReasons(view(withBig(big, u), 'largest'))).toEqual([]);
    expect(concentrationReasons(view(withBig(big, u + 1n), 'largest'))).toEqual([notCovered('H12', u + 1n)]);
  });

  it('the insider bound: five insiders at 14% leave room for 1% unlisted; one unit more is not covered', () => {
    const insiders = Array.from({ length: 5 }, (_, i) => W(i + 1));
    const big = insiders.map((w, i) => acct(w, bps(280n), `ins${i}`));
    const f = patch(passingFacts(), insidersKey(MINT), { insiders, devCluster: [] });
    const u = room(1_500n, sum(big));
    expect(concentrationReasons(view(withBig(big, u), 'largest', f))).toEqual([]);
    expect(concentrationReasons(view(withBig(big, u + 1n), 'largest', f))).toEqual([notCovered('H13', u + 1n)]);
  });

  it('burn and locker accounts are handled exactly as before on a partial view', () => {
    // 100e12 moves from the vault to the incinerator: burned tokens are listed, excluded, and not unlisted.
    const burned = holderAccounts().map((a) => (a.owner === POOL_ADDRESS ? { ...a, amount: a.amount - 100_000_000_000_000n } : a));
    const withBurn = [...burned, acct(INCINERATOR, 100_000_000_000_000n, 'burn')];
    expect(sum(withBurn)).toBe(SUPPLY);
    expect(concentrationReasons(view(withBurn, 'largest'))).toEqual([]);
    // A locker holding 40% of circulating is a holder: a hard reject with a note, on a partial view as on a full one.
    const lockerAmount = (CIRC * 2n) / 3n + 1n;
    const locked = [...holderAccounts().map((a) => (a.owner === POOL_ADDRESS ? { ...a, amount: a.amount - lockerAmount } : a)), acct(ACC('locker-pda'), lockerAmount, 'locker', RAYDIUM_LOCKER_PROGRAM)];
    for (const coverage of ['all', 'largest'] as const) {
      const r = evaluate(view(locked, coverage));
      expect(r.reasons.filter((x) => x.gate === 'H12').map((x) => x.code)).toEqual(['hard-holder', 'top10']);
      expect(r.notes).toContainEqual(expect.objectContaining({ gate: 'H12', code: 'locker-holder' }));
    }
  });

  it('a complete set that does not add up to the supply, or listed accounts above it, is inconsistent', () => {
    const short = holderAccounts().slice(0, -1);
    expect(evaluate(view(short, 'all')).reasons).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'inconsistent', input: 'holders', neededBy: 'H12' }));
    const over = [...holderAccounts(), acct(W('extra'), 1n, 'extra')];
    for (const coverage of ['all', 'largest'] as const) {
      expect(evaluate(view(over, coverage)).reasons).toContainEqual(expect.objectContaining({ gate: 'H16', code: 'inconsistent', input: 'holders', neededBy: 'H12' }));
    }
  });
});
