// The risk policy, docs/ARCHITECTURE.md §8 (R1 to R16), as pure functions over injected inputs. Every limit is read from
// the locked session policy (CFG-1); nothing here is a money amount. Unknown or stale input refuses an entry, never
// defaults. Exits never pass through these checks: `evaluateExit` always allows and only reports what is tripped.
// SOL-BOOKS (owner, 2026-10-05: "as long as the quantity of SOL keeps increasing"): every figure and limit is in
// lamports. The policy's dollar amounts are converted once at the session's opening SOL price (`openingSolPrice`); risk
// never reads the live SOL/USD price, so a price move alone never moves equity, counts as a loss or trips a limit.
import type { Policy } from '../config/index.ts';
import { PPM, type RoundTrip, costAtSize, feasibleSize, fixedCosts } from '../costs/index.ts';
import {
  BPS_DENOMINATOR, LAMPORTS_PER_SOL, type Lamports, type MicroUsd, type Rounding, lamports, microUsdToLamports, mulDiv,
} from '../units/index.ts';
import { melbourneDay, melbourneWeek } from './melbourne.ts';
import type { ReservationRequest } from './reservation.ts';
import {
  CODE_CONTROL, type AccountHistory, type ClosedTrade, type EntryDecision, type EntryRequest, type ExitDecision,
  type Latches, type NavMark, type OpenPosition, type RiskCode, type RiskInput, type RiskReason, type RiskSnapshot, type SizeCapEntry, type Trip,
  type WithdrawalDecision, type WithdrawalRequest,
} from './types.ts';

const BPS = BPS_DENOMINATOR;
/** Basis points to parts per million. */
const PPM_PER_BPS = PPM / BPS;

const reason = (code: RiskCode, detail: string): RiskReason => ({ control: CODE_CONTROL[code], code, detail });
const lam = (v: bigint): Lamports => v as Lamports;
/**
 * The sizing search (`feasibleSize`) works in micro-dollars at a SOL price. At this price one micro-unit is one lamport
 * exactly (lamports × 10⁹ / 10⁹), so sizing runs in lamports with no rounding of its own.
 */
const LAMPORT_UNIT = LAMPORTS_PER_SOL as unknown as MicroUsd;
/** The policy's dollar amount `v` in lamports at the session's opening SOL price; null without a valid opening price. */
const atOpening = (a: AccountHistory, v: MicroUsd, rounding: Rounding): bigint | null =>
  a.openingSolPrice > 0n && v >= 0n ? microUsdToLamports(v, a.openingSolPrice, rounding) : null;
const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const maxBig = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const sumBig = (xs: readonly bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);
const ofBps = (amount: bigint, rateBps: number, rounding: 'floor' | 'ceil'): bigint => mulDiv(amount, BigInt(rateBps), BPS, rounding);

const isTime = (t: number): boolean => Number.isSafeInteger(t);
/** Fresh: not from the future and no older than `maxAgeMs`. */
const fresh = (atMs: number, nowMs: number, maxAgeMs: number): boolean => isTime(atMs) && atMs <= nowMs && nowMs - atMs <= maxAgeMs;

const byClose = (a: ClosedTrade, b: ClosedTrade): number => a.closedAtMs - b.closedAtMs;
const isLoss = (t: ClosedTrade): boolean => t.netPnl < 0n;

// ---------- Account figures (R1, R6 to R10) ----------

interface Figures {
  readonly snapshot: RiskSnapshot;
  /** R1 problems with the account history or marks. */
  readonly problems: readonly RiskReason[];
  readonly trades: readonly ClosedTrade[];
}

/** Realized equity just before `t` (events at `t` or later excluded), and the flows at or after `t` up to now. */
/**
 * Realized trading results in time (RISK-PARTIAL): each partial sale at its time, then the rest of a closed trade's
 * whole result at its close. The parts of a closed trade sum to its `netPnl`.
 */
const realized = (a: AccountHistory): { readonly at: number; readonly amount: bigint }[] => [
  ...a.closedTrades.flatMap((c) => {
    const parts = c.partials ?? [];
    return [...parts.map((x) => ({ at: x.atMs, amount: x.pnl as bigint })), { at: c.closedAtMs, amount: c.netPnl - sumBig(parts.map((x) => x.pnl)) }];
  }),
  ...a.openPositions.flatMap((p) => (p.partials ?? []).map((x) => ({ at: x.atMs, amount: x.pnl as bigint }))),
];

const partialTimes = (a: AccountHistory): number[] =>
  [...a.closedTrades.flatMap((c) => c.partials ?? []), ...a.openPositions.flatMap((p) => p.partials ?? [])].map((x) => x.atMs);

const realizedBefore = (a: AccountHistory, t: number): { readonly equity: bigint; readonly flowsSince: bigint } => ({
  equity: a.openingEquity + sumBig(a.flows.filter((f) => f.atMs < t).map((f) => f.amount))
    + sumBig(realized(a).filter((r) => r.at < t).map((r) => r.amount))
    - sumBig(a.costs.filter((c) => c.atMs < t).map((c) => c.amount)),
  flowsSince: sumBig(a.flows.filter((f) => f.atMs >= t).map((f) => f.amount)),
});

type AccountEvent = { readonly at: number; readonly kind: 'flow' | 'trade' | 'cost'; readonly amount: bigint; readonly navBefore: bigint };

/**
 * Flows, realized trade results (`realized`) and account costs in time order. At the same instant trades and costs
 * come first, then flows:
 * they are listed first and Array.prototype.sort is stable. A cost lowers equity like a loss and never raises the mark.
 */
const accountEvents = (a: AccountHistory): AccountEvent[] => [
  ...realized(a).map((r): AccountEvent => ({ at: r.at, kind: 'trade', amount: r.amount, navBefore: 0n })),
  ...a.costs.map((c): AccountEvent => ({ at: c.atMs, kind: 'cost', amount: -c.amount, navBefore: 0n })),
  ...a.flows.map((f): AccountEvent => ({ at: f.atMs, kind: 'flow', amount: f.amount, navBefore: f.navBefore })),
].sort((x, y) => x.at - y.at);

/**
 * Time-weighted (unitized): units are issued or redeemed at the flow's executable valuation, so a deposit or withdrawal
 * scales a per-unit reference figure by (value after / value before), rounded up, and the drawdown measured against
 * it is unchanged by the flow. A non-positive valuation is refused (R1); there the flow is simply added.
 */
const scaleByFlow = (reference: bigint, navBefore: bigint, amount: bigint): bigint =>
  navBefore > 0n ? mulDiv(reference, navBefore + amount, navBefore, 'ceil') : reference + amount;

/**
 * High-water mark of realized equity, time-weighted: trades raise it to a new equity peak, flows scale it with equity
 * (RISK-1b; a withdrawal during a drawdown no longer deepens it, a deposit no longer hides it). An owner re-arm of the
 * kill switch restarts the mark at the equity of that moment.
 */
const highWaterMark = (a: AccountHistory, rearmAtMs: number | null, nowMs: number): bigint => {
  let equity: bigint = a.openingEquity;
  let hwm = equity;
  let rearmPending = rearmAtMs !== null && rearmAtMs <= nowMs;
  for (const e of accountEvents(a)) {
    if (rearmPending && rearmAtMs !== null && e.at >= rearmAtMs) { hwm = equity; rearmPending = false; }
    if (e.kind === 'flow') hwm = scaleByFlow(hwm, e.navBefore, e.amount);
    equity += e.amount;
    if (e.kind === 'trade') hwm = maxBig(hwm, equity);
  }
  return rearmPending ? equity : hwm;
};

/** The week's base, time-weighted: realized equity at the week start, scaled by every flow since. */
const weekBase = (a: AccountHistory, weekStartMs: number, equityAtStart: bigint): bigint => {
  let base = equityAtStart;
  for (const e of accountEvents(a).filter((x) => x.at >= weekStartMs && x.kind === 'flow')) base = scaleByFlow(base, e.navBefore, e.amount);
  return base;
};

/**
 * Economic NAV (RISK-1b, one definition for flow pricing and for the kill switch), in lamports (SOL-BOOKS): the
 * wallet's whole SOL, the operations floor included as in opening equity, plus every open position at its executable
 * mark, gains included. Null if a position has no valid mark. The worker prices each deposit and withdrawal
 * (`navBefore`) and each `NavMark` with it.
 */
export const economicNav = (balance: Lamports, positions: readonly OpenPosition[]): Lamports | null => {
  let marks = 0n;
  for (const p of positions) {
    if (p.mark === null || p.mark < 0n) return null;
    marks += p.mark;
  }
  return lam(balance + marks);
};

/**
 * High-water mark of economic NAV per unit, in lamports: every observation (NAV marks, each flow's `navBefore`, NAV now)
 * raises it, and flows scale it. An owner re-arm restarts it at the first NAV seen at or after the re-arm.
 */
const navHighWaterMark = (a: AccountHistory, rearmAtMs: number | null, nowMs: number, navNow: bigint): bigint => {
  type Obs = { readonly at: number; readonly nav: bigint; readonly flow: bigint | null };
  const obs: Obs[] = [
    ...a.navMarks.map((m: NavMark): Obs => ({ at: m.atMs, nav: m.nav, flow: null })),
    ...a.flows.map((f): Obs => ({ at: f.atMs, nav: f.navBefore, flow: f.amount })),
  ].sort((x, y) => x.at - y.at);
  let hwm: bigint = a.openingEquity;
  let rearmPending = rearmAtMs !== null && rearmAtMs <= nowMs;
  for (const o of obs) {
    if (rearmPending && rearmAtMs !== null && o.at >= rearmAtMs) { hwm = o.nav; rearmPending = false; }
    hwm = maxBig(hwm, o.nav);
    if (o.flow !== null) hwm = scaleByFlow(hwm, o.nav, o.flow);
  }
  return rearmPending ? navNow : maxBig(hwm, navNow);
};

const figures = (policy: Policy, a: AccountHistory, latches: Latches, nowMs: number): Figures => {
  const problems: RiskReason[] = [];
  const latchTimes = [latches.killTrippedAtMs, latches.killRearmedAtMs, latches.weeklyTrippedAtMs, latches.weeklyReviewedAtMs, latches.lossReviewedAtMs]
    .filter((t): t is number => t !== null);
  const times = [a.openedAtMs, ...a.flows.map((f) => f.atMs), ...a.navMarks.map((m) => m.atMs), ...a.costs.map((c) => c.atMs), ...a.closedTrades.map((c) => c.closedAtMs), ...partialTimes(a), ...a.entries.map((e) => e.atMs), ...latchTimes];
  if (times.some((t) => !isTime(t) || t > nowMs)) problems.push(reason('bankroll_invalid', 'account history or a latch has an invalid or future time'));
  if (a.heldReservations < 0n) problems.push(reason('bankroll_invalid', 'held reservations are negative'));
  if (a.flows.some((f) => f.navBefore <= 0n)) problems.push(reason('bankroll_invalid', 'a deposit or withdrawal has no positive valuation'));
  // A withdrawal of everything or more would scale the marks to zero or below and silence the kill switch (RISK-1b review).
  if (a.flows.some((f) => f.navBefore + f.amount <= 0n)) problems.push(reason('bankroll_invalid', 'a withdrawal leaves no positive valuation'));
  if (a.costs.some((c) => c.amount < 0n)) problems.push(reason('bankroll_invalid', 'an account cost is negative'));
  if (a.navMarks.some((m) => m.nav <= 0n)) problems.push(reason('bankroll_invalid', 'a recorded NAV is not positive'));
  // The bankroll B in lamports, fixed at the opening SOL price for the session. Floor: every limit is a share of it.
  const bankroll = atOpening(a, policy.capital.bankroll, 'floor');
  if (bankroll === null || bankroll <= 0n) problems.push(reason('bankroll_invalid', 'no valid opening SOL price fixes the bankroll in SOL'));

  // Marked loss of open positions. An unknown or stale mark counts as a total loss here, and refuses entries.
  let markedLoss = 0n;
  let openExposure = 0n;
  for (const p of a.openPositions) {
    const mark = p.mark !== null && p.markAtMs !== null && p.mark >= 0n ? p.mark : null;
    if (mark === null) problems.push(reason('mark_unknown', `no valid executable value for the open position in ${p.mint}`));
    else if (!fresh(p.markAtMs ?? 0, nowMs, policy.gates.maxQuoteAgeMs)) problems.push(reason('mark_stale', `the value of the open position in ${p.mint} is stale`));
    const value = mark ?? 0n;
    const remaining = minBig(value, p.notional);
    markedLoss += remaining - p.notional; // <= 0: unrealized gains are not counted
    openExposure += remaining;
  }

  const realizedNow = realizedBefore(a, nowMs + 1);
  const equity = realizedNow.equity + markedLoss;
  // Never below equity: the mark only moves with flows (as equity does) and rises with realized equity; marks are <= 0.
  const highWaterMark_ = highWaterMark(a, latches.killRearmedAtMs, nowMs);
  const day = melbourneDay(nowMs);
  const week = melbourneWeek(nowMs);
  const atDay = realizedBefore(a, day.start);
  const atWeek = realizedBefore(a, week.start);
  // The day's and week's loss: the stricter of two measures (WORKER-1c ruling, 2026-10-04). From realized equity at the
  // boundary (an open loss carried over it counts again), and from marked equity recorded at the boundary when there is
  // one. A boundary not recorded leaves the realized measure alone: never read as zero loss.
  const dayChange = a.markedAtDayStart === null ? null : equity - a.markedAtDayStart - atDay.flowsSince;
  const weekChange = a.markedAtWeekStart === null ? null : equity - a.markedAtWeekStart - atWeek.flowsSince;
  const dayLoss = maxBig(maxBig(0n, atDay.equity + atDay.flowsSince - equity), dayChange === null ? 0n : -dayChange);
  const weekLoss = maxBig(maxBig(0n, atWeek.equity + atWeek.flowsSince - equity), weekChange === null ? 0n : -weekChange);
  const base = weekBase(a, week.start, atWeek.equity);

  const trades = [...a.closedTrades].sort(byClose);
  let lossStreak = 0;
  for (let i = trades.length - 1; i >= 0 && isLoss(trades[i] as ClosedTrade); i--) lossStreak++;

  if (equity <= 0n || atWeek.equity <= 0n) problems.push(reason('bankroll_invalid', 'equity is not positive'));
  return {
    problems,
    trades,
    snapshot: {
      nowMs, dayStartMs: day.start, weekStartMs: week.start,
      // With no valid opening price the bankroll is zero: every limit is then reached, and R1 refuses entries.
      bankroll: lam(bankroll !== null && bankroll > 0n ? bankroll : 0n),
      // Filled in by accountCheck.
      dailyLimit: lam(0n), weeklyLimit: lam(0n),
      equity: lam(equity), highWaterMark: lam(highWaterMark_), dayLoss: lam(dayLoss), weekLoss: lam(weekLoss),
      weekStartEquity: lam(atWeek.equity), weekBase: lam(base), weekBaseLoss: lam(maxBig(0n, base - equity)),
      openExposure: lam(openExposure), lossStreak,
      dayChangeMarked: dayChange === null ? null : lam(dayChange),
      weekChangeMarked: weekChange === null ? null : lam(weekChange),
      // Filled in by accountCheck, which has the market.
      walletEquity: null, capital: lam(equity), nav: null, navHighWaterMark: null,
    },
  };
};

// ---------- Account-level controls (no trade needed) ----------

interface AccountCheck {
  readonly figures: Figures;
  readonly reasons: readonly RiskReason[];
  readonly trips: readonly Trip[];
  readonly killRoom: bigint;
  readonly weekRoom: bigint;
  readonly dailyLimit: bigint;
}

const accountCheck = (input: RiskInput, nowMs: number): AccountCheck => {
  const { session, mode, account, latches, market } = input;
  const policy = session.policy;
  const f = figures(policy, account, latches, nowMs);
  // Capital measured from the wallet as well: its SOL plus open positions marked as in equity. Every size and limit
  // that scales with equity uses the lower of the two, so the wallet short of the ledger tightens and never loosens.
  const balance = market.solBalance !== null && fresh(market.solBalance.atMs, nowMs, policy.gates.maxQuoteAgeMs) ? market.solBalance.value : null;
  const walletEquity = balance === null ? null : balance + f.snapshot.openExposure;
  // Economic NAV, only when it can be valued consistently: marks fresh, no entry in flight, and a balance read at or
  // after the account's latest change (a close or flow the balance has not seen yet would read as a loss and latch).
  const lastChange = Math.max(account.openedAtMs, ...account.flows.map((x) => x.atMs), ...account.closedTrades.map((c) => c.closedAtMs),
    ...partialTimes(account), ...account.costs.map((c) => c.atMs), ...account.entries.map((e) => e.atMs), ...account.openPositions.map((p) => p.openedAtMs));
  const consistent = balance !== null && market.solBalance !== null && market.solBalance.atMs >= lastChange
    && account.unresolvedEntries.length === 0
    && account.openPositions.every((p) => p.markAtMs !== null && fresh(p.markAtMs, nowMs, policy.gates.maxQuoteAgeMs));
  const nav = consistent ? economicNav(balance, account.openPositions) : null;
  const navHwm = nav === null ? null : navHighWaterMark(account, latches.killRearmedAtMs, nowMs, nav);
  const capital = walletEquity === null ? f.snapshot.equity : minBig(f.snapshot.equity, walletEquity);
  // R7's trigger is a share of B; R9's line the tighter of a share of week-start equity and of the flow-scaled base.
  const dailyLimit = ofBps(f.snapshot.bankroll, policy.loss.dailyBps, 'floor');
  const weekLimit = ofBps(f.snapshot.weekStartEquity, policy.loss.weeklyBps, 'floor');
  const weekBaseLimit = ofBps(f.snapshot.weekBase, policy.loss.weeklyBps, 'floor');
  const s: RiskSnapshot = {
    ...f.snapshot,
    dailyLimit: lam(dailyLimit),
    weeklyLimit: lam(minBig(weekLimit, weekBaseLimit)),
    walletEquity: walletEquity === null ? null : lam(walletEquity),
    capital: lam(capital),
    nav,
    navHighWaterMark: navHwm === null ? null : lam(navHwm),
  };
  const reasons: RiskReason[] = [...f.problems];
  const trips: Trip[] = [];
  // SOL-BOOKS: with no SOL bankroll (no valid opening SOL price yet) every figure is zero and every line reads as
  // reached. That proves no breach: R1 refuses entries, and nothing is handed back to latch.
  const valued = f.snapshot.bankroll > 0n;
  const trip = (t: Trip): void => { if (valued) trips.push(t); };
  const live = mode === 'live';

  // R1: the bankroll in SOL (a figure above); no live SOL/USD price is read (SOL-BOOKS).

  // R3: one open position, counting an unresolved entry.
  const open = account.openPositions.length + account.unresolvedEntries.length;
  if (open >= policy.positions.maxOpen) reasons.push(reason('max_open_positions', `${open} open or unresolved, limit ${policy.positions.maxOpen}`));

  // R4: SOL balance known and fresh, and above the floor.
  if (market.solBalance === null) reasons.push(reason('balance_unknown', 'no SOL balance'));
  else if (!fresh(market.solBalance.atMs, nowMs, policy.gates.maxQuoteAgeMs)) reasons.push(reason('balance_stale', 'SOL balance is stale'));
  else if (market.solBalance.value < policy.reserve.opsFloor) reasons.push(reason('ops_reserve', 'SOL balance is below the operations floor'));

  // R7: today's realized and marked loss against the daily trigger (costs of a new trade are added per entry).
  if (s.dayLoss >= dailyLimit) reasons.push(reason('daily_loss', 'daily loss trigger reached; entries resume at midnight Melbourne time'));

  // R8: consecutive losses.
  const last = f.trades.at(-1);
  if (last && s.lossStreak >= policy.loss.cooldownAfterLosses && nowMs < last.closedAtMs + policy.loss.cooldownMs) {
    reasons.push(reason('loss_cooldown', `${s.lossStreak} losses in a row; cooling down`));
  }
  if (last && s.lossStreak >= policy.loss.pauseDayAfterLosses && last.closedAtMs >= s.dayStartMs) {
    reasons.push(reason('loss_day_pause', `${s.lossStreak} losses in a row; paused for the day`));
  }
  const reviewed = latches.lossReviewedAtMs;
  const sinceReview = f.trades.filter((t) => reviewed === null || t.closedAtMs > reviewed);
  const reviewWindow = policy.loss.reviewWindowTrades;
  for (let i = 0; i < Math.max(1, sinceReview.length - reviewWindow + 1); i++) {
    const losses = sinceReview.slice(i, i + reviewWindow).filter(isLoss).length;
    if (losses >= policy.loss.reviewLosses) {
      reasons.push(reason('loss_review', `${losses} losses in ${reviewWindow} trades; paused until reviewed`));
      break;
    }
  }

  // R9: weekly loss, latched until the week ends and the owner has reviewed it (a review strictly after the trip).
  // Counted two ways and the tighter applies: in lamports against week-start equity, and time-weighted against the
  // flow-scaled base (RISK-1b), so a flow can neither hide a weekly loss nor loosen the limit.
  const weeklyTripped = latches.weeklyTrippedAtMs;
  const weeklyLatched = weeklyTripped !== null && (
    latches.weeklyReviewedAtMs === null || latches.weeklyReviewedAtMs <= weeklyTripped || nowMs < melbourneWeek(weeklyTripped).end
  );
  if (s.weekLoss >= weekLimit || s.weekBaseLoss >= weekBaseLimit) {
    reasons.push(reason('weekly_loss', 'weekly loss trigger reached; paused for the week'));
    if (!weeklyLatched) trip('weekly_loss');
  }
  if (weeklyLatched) reasons.push(reason('weekly_review', 'weekly loss trigger tripped; paused until the week ends and the owner reviews'));

  // R10: kill switch at 70% of the high-water mark, latched until the owner re-arms (strictly after the trip). Measured
  // on economic NAV per unit (RISK-1b) and on the trading ledger, both in lamports.
  const killLine = ofBps(s.highWaterMark, policy.loss.killSwitchFloorBps, 'ceil');
  const navKillLine = s.navHighWaterMark === null ? null : ofBps(s.navHighWaterMark, policy.loss.killSwitchFloorBps, 'ceil');
  const killTripped = latches.killTrippedAtMs;
  const killLatched = killTripped !== null && (latches.killRearmedAtMs === null || latches.killRearmedAtMs <= killTripped);
  const navBelow = s.nav !== null && navKillLine !== null && s.nav <= navKillLine;
  if (s.equity <= killLine || navBelow || killLatched) {
    reasons.push(reason('kill_switch', 'equity at or below the kill line; only the owner re-arms'));
    if (!killLatched) trip('kill_switch');
  }
  // Not latched: it lifts when the wallet's SOL (with open positions at their marks) is back above the line.
  if (s.walletEquity !== null && s.walletEquity <= killLine) reasons.push(reason('wallet_below_kill_line', 'the wallet\'s SOL is at or below the kill line'));

  // R11: entries per day, in paper exactly as live (supervisor ruling, golden rule: paper money is real money); only the
  // backtest's research evaluation is uncapped.
  if (mode !== 'backtest') {
    const today = account.entries.filter((e) => e.atMs >= s.dayStartMs).length;
    if (today >= policy.positions.maxEntriesPerDay) reasons.push(reason('entries_per_day', `${today} entries today, limit ${policy.positions.maxEntriesPerDay}`));
  }

  // R15: the policy is locked to a running session.
  if (!session.running) reasons.push(reason('session_not_running', 'the policy session has ended'));

  // R16 (live only): the regime gate.
  if (live && market.regime === 'off') reasons.push(reason('regime_off', 'regime gate is off; paper only'));
  if (live && market.regime === 'unknown') reasons.push(reason('regime_unknown', 'regime gate state is unknown'));

  // What the week still allows (before what is open or reserved): the tighter of the two counts.
  // ... and never more than 20% of the capital that remains now (after a withdrawal or a fall in SOL).
  const weekRoom = minBig(minBig(weekLimit - s.weekLoss, weekBaseLimit - s.weekBaseLoss), ofBps(s.capital, policy.loss.weeklyBps, 'floor'));
  // What the kill switch still allows (before what is open or reserved): the tighter of the two measures.
  const killRoom = s.nav === null || navKillLine === null ? s.capital - killLine : minBig(s.capital - killLine, s.nav - navKillLine);
  return { figures: { ...f, snapshot: s }, reasons, trips, killRoom, weekRoom, dailyLimit };
};

/** The Melbourne rules refuse a non-integer or pre-2008 instant, so a bad clock throws before any figure is used. */
const clockNow = (input: RiskInput): number => input.clock.now().receivedAt;

/**
 * The figures an evaluation at this moment would use, for the caller's own records (WORKER-1c: the boundary marks and
 * the NAV peak). Read-only; null when they cannot be computed (a bad clock or input).
 */
export const riskSnapshot = (input: RiskInput): RiskSnapshot | null => {
  try {
    return accountCheck(input, clockNow(input)).figures.snapshot;
  } catch {
    return null;
  }
};

// ---------- Exits ----------

/**
 * Exits are never blocked by any risk control. This reports which entry controls are tripped, for the log, and returns
 * new trips (R9, R10) so that a marked dip seen while managing an exit is latched even if it recovers before the next
 * entry is evaluated. It never throws, whatever the inputs: an internal failure is returned as `fault` (and the
 * `risk_fault` code), so a caller can tell "nothing tripped" from "could not evaluate" (RISK-FAULT).
 */
export const evaluateExit = (input: RiskInput): ExitDecision => {
  try {
    const check = accountCheck(input, clockNow(input));
    return { allow: true, tripped: check.reasons, trips: check.trips, fault: null };
  } catch (e) {
    // RISK-FAULT: still allowed, but marked as not evaluated, so no caller reads it as a clean account.
    const fault = faultText(e);
    return { allow: true, tripped: [reason('risk_fault', `risk could not be evaluated: ${fault}`)], trips: [], fault };
  }
};

/** A thrown value as text, without calling anything on it that could throw again. */
const faultText = (e: unknown): string => {
  try {
    return e instanceof Error && typeof e.message === 'string' && e.message !== '' ? e.message : 'unknown error';
  } catch {
    return 'unknown error';
  }
};

// ---------- Entries ----------

/** Lamports of every cost one entry can incur: fees, rent, priority fees and the exit ladder at its worst. */
export const maxTradeCosts = (policy: Policy, request: Pick<EntryRequest, 'network' | 'rent'>): { readonly total: Lamports; readonly perExitAttempt: bigint; readonly ladderWorst: bigint } => {
  const { network, rent } = request;
  const fixed = fixedCosts(network, rent);
  const ladder = policy.exits.ladder;
  const fee = ladder.steps.reduce((m, s) => maxBig(m, s.priorityFeeLamports), ladder.maxFeePerAttempt as bigint);
  const perExitAttempt = network.signaturesPerTx * network.baseFeePerSignature + fee + network.tip;
  // EXIT-1: one ladder per position across all its exits, then up to blockedRetryAttempts single-attempt retries.
  const ladderWorst = BigInt(ladder.maxAttempts + policy.exits.blockedRetryAttempts) * perExitAttempt;
  const modelledExit = fixed.exit.landed + fixed.exit.expectedFailures;
  // Rent of the token account counts even when the exit closes it: a blocked exit keeps it locked.
  const total = fixed.total + fixed.recoverableRent + maxBig(0n, ladderWorst - modelledExit);
  return { total: lamports(total), perExitAttempt, ladderWorst };
};

/** R4: the SOL operations reserve, computed live, never below the policy floor. */
export const opsReserve = (policy: Policy, request: Pick<EntryRequest, 'rent'>, perExitAttempt: bigint): Lamports => {
  const { rent } = request;
  // The reserve's exit attempts plus EXIT-1's blocked-exit retries, each at the fee cap.
  const attempts = BigInt(policy.reserve.exitAttempts + policy.exits.blockedRetryAttempts);
  const live = rent.tokenAccount + rent.oneTime + rent.transient + attempts * perExitAttempt;
  return lamports(maxBig(policy.reserve.opsFloor, live));
};

const refuse = (reasons: readonly RiskReason[], trips: readonly Trip[], snapshot: RiskSnapshot | null): EntryDecision =>
  ({ allow: false, reasons, trips, snapshot });

/**
 * Decides one entry. Allowed only when every control R1 to R16 passes and a size of at least the policy minimum fits
 * every cap: maximum q = min(q_max, stop-stress size, full-loss allowance after costs, executable-depth cap, cash after
 * reserve, remaining risk budget). Refusals list every failing control, each with its reason. Throws only on a
 * malformed clock or an instant before the Melbourne rules (programming errors); callers treat a throw as no entry.
 */
export const evaluateEntry = (input: RiskInput, request: EntryRequest): EntryDecision => {
  const nowMs = clockNow(input);
  const policy = input.session.policy;
  const { account, latches, market, mode } = input;
  const check = accountCheck(input, nowMs);
  const s = check.figures.snapshot;
  const reasons: RiskReason[] = [...check.reasons];
  const live = mode === 'live';
  // q_min, q_max and the liquidity floors in lamports at the opening SOL price (SOL-BOOKS). q_min is rounded up and
  // q_max down, so the range never widens; the floors are rounded up.
  const qMinL = atOpening(account, policy.capital.minNotional, 'ceil');
  const qMaxL = atOpening(account, policy.capital.maxNotional, 'floor');
  const floorL = atOpening(account, policy.liquidity.floorUsd, 'ceil');
  const u1FloorL = atOpening(account, policy.liquidity.u1FloorUsd, 'ceil');
  if (qMinL === null || qMaxL === null || floorL === null || u1FloorL === null) return refuse(reasons, check.trips, s);
  const qMin = lam(qMinL);

  // R11: per mint, and no re-entry after a stop, in paper exactly as live (supervisor ruling); not in the backtest.
  if (mode !== 'backtest') {
    const day = account.entries.filter((e) => e.mint === request.mint && e.atMs >= s.dayStartMs).length;
    if (day >= policy.positions.maxEntriesPerMintPerDay) reasons.push(reason('entries_per_mint', `${day} entries in this mint today`));
    if (account.closedTrades.some((t) => t.mint === request.mint && t.stoppedOut && nowMs < t.closedAtMs + policy.positions.reentryBlockMs)) {
      reasons.push(reason('reentry_after_stop', 'this mint was stopped out inside the re-entry window'));
    }
  }
  // R15: never add to a position, open or still being entered.
  if (account.openPositions.some((p) => p.mint === request.mint) || account.unresolvedEntries.some((u) => u.mint === request.mint)) {
    reasons.push(reason('add_to_position', 'a position in this mint is open or being entered'));
  }
  // R5: stop distance.
  const stopOk = Number.isSafeInteger(request.stopBps) && request.stopBps > 0 && request.stopBps <= Number(BPS);
  if (!stopOk) reasons.push(reason('stop_invalid', `stop distance ${request.stopBps} bps is not valid`));
  else if (request.stopBps > policy.loss.stopMaxBps) reasons.push(reason('stop_too_wide', `stop ${request.stopBps} bps is wider than ${policy.loss.stopMaxBps}`));
  // R13: the quote must be fresh.
  if (!fresh(request.quoteAtMs, nowMs, policy.gates.maxQuoteAgeMs)) reasons.push(reason('quote_stale', 'the pool quote is stale'));
  // R14: a usable median target.
  const targetOk = Number.isSafeInteger(request.medianTargetBps) && request.medianTargetBps > 0;
  if (!targetOk) reasons.push(reason('median_target_invalid', 'the strategy median target is not valid'));
  // R12: liquidity floor.
  const u1 = request.universe === 'U1';
  const floor = u1 ? maxBig(floorL, u1FloorL) : floorL;
  if (request.poolLiquidity === null) reasons.push(reason('liquidity_unknown', 'pool liquidity is unknown'));
  else if (request.poolLiquidity < floor) reasons.push(reason('liquidity_floor', 'pool liquidity is below the floor'));

  const balance = market.solBalance?.value;
  if (balance === undefined) return refuse(reasons, check.trips, s);

  let costs: ReturnType<typeof maxTradeCosts>;
  try {
    costs = maxTradeCosts(policy, request);
  } catch (e) {
    reasons.push(reason('quote_failed', `trade costs could not be computed: ${String(e)}`));
    return refuse(reasons, check.trips, s);
  }
  const cMax = costs.total;
  const held = account.heldReservations;
  const openCount = BigInt(account.openPositions.length);
  // Remaining full loss of what is already open or reserved: positions at mark (plus their exit ladder) and held reservations.
  const committed = s.openExposure + openCount * costs.ladderWorst;

  // R7 per entry: L_day + C must stay below the daily trigger.
  if (s.dayLoss < check.dailyLimit && s.dayLoss + cMax >= check.dailyLimit) {
    reasons.push(reason('daily_loss', 'the costs of this trade would reach the daily loss trigger'));
  }

  // Size caps on the notional, each net of the costs C where the control counts them.
  const caps: SizeCapEntry[] = [];
  const cap = (control: SizeCapEntry['control'], name: string, notional: bigint) => caps.push({ control, name, notional: lam(notional) });
  const resetShare = BPS - BigInt(policy.capital.drawdownResetBps);
  const drawdownReset = s.capital * BPS <= s.highWaterMark * resetShare
    || (s.nav !== null && s.navHighWaterMark !== null && s.nav * BPS <= s.navHighWaterMark * resetShare);
  cap('R2', 'maximum notional', qMaxL);
  // Phase 1 and any 10% drawdown trade at the minimum. That is a choice of size inside the range, not a cap on it.
  const atMinimum = !latches.sizeStepUpApproved || drawdownReset;
  const stage: SizeCapEntry | undefined = atMinimum
    ? { control: 'R2', name: drawdownReset ? 'drawdown returns size to the minimum' : 'minimum until the owner steps sizes up', notional: qMin }
    : undefined;
  if (stage) caps.push(stage);
  const reserve = opsReserve(policy, request, costs.perExitAttempt);
  // Signed: a balance already short of the reserve gives a negative cap.
  cap('R4', 'cash after the operations reserve', balance - reserve - cMax - request.rent.transient);
  // R5 is planned risk (1R): q * s plus the costs the trade is expected to pay, F and proportional costs at the cost-gate
  // ceiling, so q * (s + gate) + F <= plannedRisk * B. The worst case C is reserved by R6 and R7.
  const fixed = fixedCosts(request.network, request.rent);
  const fixedL = fixed.total;
  if (stopOk) {
    cap('R5', 'planned risk per trade', mulDiv(ofBps(minBig(s.bankroll, s.capital), policy.loss.plannedRiskBps, 'floor') - fixedL, BPS,
      BigInt(request.stopBps + policy.costGate.maxRoundTripBps), 'floor'));
  }
  const killAllowance = check.killRoom - committed;
  const weekAllowance = check.weekRoom - committed;
  cap('R6', 'full loss above the kill line', killAllowance - held - cMax);
  cap('R6', 'full loss inside the weekly limit', weekAllowance - held - cMax);
  if (request.poolLiquidity !== null) cap('R12', 'liquidity floor multiple', request.poolLiquidity / BigInt(policy.liquidity.floorNotionalMultiple));
  const lastTrade = check.figures.trades.at(-1);
  if (lastTrade && isLoss(lastTrade)) cap('R15', 'no larger size after a loss', lastTrade.notional);

  const capCode: Partial<Record<SizeCapEntry['control'], RiskCode>> = {
    R2: 'size_below_minimum', R4: 'ops_reserve', R5: 'planned_risk', R12: 'liquidity_floor', R15: 'size_after_loss',
  };
  const capReason = (c: SizeCapEntry): RiskCode =>
    c.control === 'R6' ? (c.name.includes('weekly') ? 'full_loss_week' : 'full_loss_kill_line') : capCode[c.control] ?? 'size_below_minimum';
  for (const c of caps) {
    if (c.notional >= qMin) continue;
    const code = capReason(c);
    if (!reasons.some((r) => r.code === code)) reasons.push(reason(code, `${c.name}: largest size is below the minimum`));
  }
  if (reasons.length > 0) return refuse(reasons, check.trips, s);

  // Depth and expected net from the pool itself (CORE-2), inside the caps above.
  const tightest = caps.filter((c) => c !== stage).reduce((a, b) => (b.notional < a.notional ? b : a));
  // Every cap is in lamports, so q_min is the minimum spend itself. Loss caps (R4, R5, R6, R12) admit nothing extra; the
  // reservation check below is exact. The sizing search runs at LAMPORT_UNIT, where its micro-units are lamports.
  const minSpend: bigint = qMin;
  const sizeCaps = caps.filter((c) => c !== stage && (c.control === 'R2' || c.control === 'R15'));
  const lossCaps = caps.filter((c) => c !== stage && c.control !== 'R2' && c.control !== 'R15');
  const shapeCap = sizeCaps.reduce((m, c) => minBig(m, c.notional), qMaxL);
  const qCap = lossCaps.reduce((m, c) => minBig(m, c.notional), maxBig(shapeCap, minSpend));
  const cashNeeds = fixedL + fixed.recoverableRent + request.rent.transient;
  const units = (v: bigint): MicroUsd => v as MicroUsd;
  let sized: ReturnType<typeof feasibleSize>;
  try {
    sized = feasibleSize({
      quote: request.quote, solPrice: LAMPORT_UNIT, edgePpm: request.edgePpm, network: request.network, rent: request.rent,
      policy: { minNotional: units(qMin), maxNotional: units(qCap), maxImpactPpm: BigInt(policy.liquidity.maxImpactBps) * PPM_PER_BPS },
      caps: { lossAllowance: units(qCap + fixedL), riskBudget: units(qCap + fixedL), executableDepth: units(qCap), cash: units(qCap + cashNeeds) },
      extraPpm: request.extraPpm ?? 0n,
    });
  } catch (e) {
    return refuse([reason('quote_failed', `the pool could not be quoted: ${String(e)}`)], check.trips, s);
  }
  if (!sized.trade) {
    const code: RiskCode = sized.reason === 'unquotable' ? 'quote_failed'
      : sized.reason === 'impact-above-limit' ? 'depth_cap'
      : sized.reason === 'caps-below-minimum' ? capReason(tightest)
      : 'expected_net_not_positive';
    return refuse([reason(code, `sizing refused: ${sized.reason} (${tightest.name})`)], check.trips, s);
  }
  // feasibleSize's range starts at or above q_min in lamports, rounded up (minSpend), so only the low end needs a check.
  if (atMinimum && sized.range.minLamports > minSpend) {
    return refuse([reason('expected_net_not_positive', 'the minimum size does not clear its fixed costs')], check.trips, s);
  }
  // A size cap (R2, R15) admits exactly the minimum spend and nothing between it and the cap.
  const shapeSpend = maxBig(shapeCap, minSpend);
  const spend = atMinimum ? minSpend : minBig(sized.range.maxLamports, shapeSpend);
  const notional = lam(spend);

  // R14: the round trip at the chosen size, F included, within 5% and within a third of the median target.
  let roundTrip: RoundTrip;
  let roundTripPpm: bigint;
  try {
    const c = costAtSize(request.quote, spend, request.network, request.rent, request.extraPpm ?? 0n);
    if (!c.ok) return refuse([reason('quote_failed', `the chosen size could not be quoted: ${c.reason} (${c.detail})`)], check.trips, s);
    roundTrip = c.trade.roundTrip;
    roundTripPpm = mulDiv(c.trade.totalLoss, PPM, roundTrip.paid, 'ceil');
  } catch (e) {
    return refuse([reason('quote_failed', `the chosen size could not be quoted: ${String(e)}`)], check.trips, s);
  }
  const gate = policy.costGate;
  if (roundTripPpm > BigInt(gate.maxRoundTripBps) * PPM_PER_BPS) {
    return refuse([reason('cost_gate', `round trip ${roundTripPpm} ppm is above ${gate.maxRoundTripBps} bps`)], check.trips, s);
  }
  if (roundTripPpm * BPS > BigInt(gate.maxShareOfMedianTargetBps) * BigInt(request.medianTargetBps) * PPM_PER_BPS) {
    return refuse([reason('cost_gate', 'round trip is above the allowed share of the median target')], check.trips, s);
  }

  // R6 as an atomic reservation: the full possible loss, against the allowance that excludes what is already held.
  const amount = lamports(spend + cMax);
  const allowance = minBig(killAllowance, weekAllowance);
  // Positive here: every R6 cap passed, so the allowance holds at least q_min + C.
  const maxHeld = lam(allowance);
  if (account.heldReservations + amount > maxHeld) {
    const code: RiskCode = weekAllowance < killAllowance ? 'full_loss_week' : 'full_loss_kill_line';
    return refuse([reason(code, 'the full-loss reservation does not fit the remaining allowance')], check.trips, s);
  }
  const reservation: ReservationRequest = {
    reservationId: request.reservationId,
    intentId: request.intentId,
    amount,
    limits: { maxHeld, maxCount: policy.positions.maxOpen - account.openPositions.length },
    accountVersion: account.version,
  };
  const stop = BigInt(request.stopBps);
  const slip = BigInt(policy.exits.ladder.steps.reduce((m, st) => Math.max(m, st.minOutBelowTriggerBps), 0));
  const loss = {
    plannedRisk: lam(mulDiv(notional, stop + BigInt(policy.costGate.maxRoundTripBps), BPS, 'ceil') + fixedL),
    // 1 − (1 − s)(1 − e) = s + e − s·e, in bps of bps.
    stressed: lam(mulDiv(notional, stop * BPS + slip * BPS - stop * slip, BPS * BPS, 'ceil') + cMax),
    reserved: amount,
  };
  return {
    allow: true, reasons: [], trips: check.trips, snapshot: s, notional, spendLamports: spend, maxCostsLamports: cMax,
    caps, roundTripPpm, loss, reservation,
  };
};

// ---------- Withdrawals ----------

/**
 * A withdrawal (first release, RISK-1b): queued while any position, unresolved entry or reservation is open or the
 * account is not reconciled, and never into the operations reserve, so the SOL kept for exits, fees, pending
 * transactions and full-loss exposure cannot leave. With nothing open, that is the live R4 reserve.
 */
export const evaluateWithdrawal = (input: RiskInput, request: WithdrawalRequest): WithdrawalDecision => {
  const nowMs = clockNow(input);
  const policy = input.session.policy;
  const { account, market } = input;
  const reasons: RiskReason[] = [];
  if (request.amount <= 0n) reasons.push(reason('withdrawal_invalid', 'the amount must be positive'));
  const open = account.openPositions.length + account.unresolvedEntries.length;
  if (open > 0 || account.heldReservations > 0n) {
    reasons.push(reason('withdrawal_queued', 'queued until no position, unresolved entry or reservation is open'));
  }
  if (!request.reconciled) reasons.push(reason('withdrawal_unreconciled', 'queued until the wallet and the ledger are reconciled'));
  let free = 0n;
  if (market.solBalance === null) reasons.push(reason('balance_unknown', 'no SOL balance'));
  else if (!fresh(market.solBalance.atMs, nowMs, policy.gates.maxQuoteAgeMs)) reasons.push(reason('balance_stale', 'SOL balance is stale'));
  else {
    const perExitAttempt = maxTradeCosts(policy, request).perExitAttempt;
    free = maxBig(0n, market.solBalance.value - opsReserve(policy, request, perExitAttempt));
    if (request.amount > free) reasons.push(reason('withdrawal_over_free_cash', `at most ${free} lamports may leave; the rest is the operations reserve`));
  }
  const maxAmount = reasons.some((r) => r.code === 'withdrawal_queued' || r.code === 'withdrawal_unreconciled') ? 0n : free;
  return { allow: reasons.length === 0, reasons, maxAmount };
};
