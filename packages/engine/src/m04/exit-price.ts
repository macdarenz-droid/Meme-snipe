// Rulings Z07-31 and Z07-33 (SPEC-A C-88): during a slot-clock disagreement an exit read carries two unstored reads,
// the highest plausible one past the ceiling and an under-ceiling partner (the newest read under it, else the trusted
// stored latest; Z07-32: never a past-ceiling read alone). Neither can be trusted alone (a lagging peer, or a plausible
// liar with a faked vault: #325 red team MAJOR-R10), so the exit DECIDES on the worse proceeds of the two (for a sell
// the smaller quote out), and its minOut is the larger of the worse read's minOut and the partner's proceeds less the
// configured emergency slippage (MINOR-R12: a liar's low quote cannot drag minOut under the honest floor). The
// transaction may then revert and the exit retries. Every such exit logs both proceeds, so the dry run can measure it.
// Pure.

/** One read with the proceeds the caller's venue model gives for the exit on it (lamports out for a sell). */
export interface ExitCandidate<S> { snapshot: S; proceedsLamports: bigint }

/**
 * The candidate with the smaller proceeds; an absent one (null) is skipped, and a tie keeps `a`. Null only when both
 * are absent.
 */
export function worseProceeds<S>(a: ExitCandidate<S> | null, b: ExitCandidate<S> | null): ExitCandidate<S> | null {
  if (a === null) return b;
  if (b === null) return a;
  return b.proceedsLamports < a.proceedsLamports ? b : a;
}

/** ARCH exit ladder: the hard slippage ceiling; the bot never sells with more. */
export const HARD_SLIPPAGE_CEILING_BPS = 2_500;

export interface ClockExitLog { event(level: 'warn', code: 'm04.exit_clock_prices', fields: Readonly<Record<string, unknown>>): void }
export interface ClockExitDecision<S> { priced: ExitCandidate<S>; minOutLamports: bigint }

/**
 * Decides an `E_CLOCK` exit (Z07-33). `past` and `under` are the two reads with the caller's proceeds; `worseMinOut`
 * is the caller's minOut on the worse of them (`VenueModel.minOut` on that quote); `emergencySlippageBps` is the
 * configured emergency slippage, passed as read and never changed here. Throws `{ code: 'E_INVALID_SLIPPAGE' }`
 * outside 0..`HARD_SLIPPAGE_CEILING_BPS`. Logs both proceeds (`m04.exit_clock_prices`).
 */
export function decideClockExit<S>(pool: string, past: ExitCandidate<S>, under: ExitCandidate<S>, worseMinOut: bigint, emergencySlippageBps: number,
  log: ClockExitLog): ClockExitDecision<S> {
  if (!Number.isInteger(emergencySlippageBps) || emergencySlippageBps < 0 || emergencySlippageBps > HARD_SLIPPAGE_CEILING_BPS) throw { code: 'E_INVALID_SLIPPAGE' };
  const priced = worseProceeds(past, under) as ExitCandidate<S>;
  const floor = (under.proceedsLamports * BigInt(10_000 - emergencySlippageBps)) / 10_000n;
  const minOutLamports = worseMinOut > floor ? worseMinOut : floor;
  log.event('warn', 'm04.exit_clock_prices', {
    pool, past_ceiling_proceeds: past.proceedsLamports, under_ceiling_proceeds: under.proceedsLamports,
    decided_on: priced === under ? 'under_ceiling' : 'past_ceiling', min_out: minOutLamports, emergency_slippage_bps: emergencySlippageBps,
  });
  return { priced, minOutLamports };
}
