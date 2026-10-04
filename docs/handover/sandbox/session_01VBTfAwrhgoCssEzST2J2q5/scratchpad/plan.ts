import { RESEARCH_CONFIG, TRIAL_POLICY } from '/home/user/Meme-snipe/packages/core/src/config/index.ts';
import { attemptAlpha, STUDY_CONFIG, studyHash } from '/home/user/Meme-snipe/packages/backtest/src/strategy/config.ts';
import { studyPlan } from '/home/user/Meme-snipe/packages/backtest/src/study/plan.ts';
import { newStudyRegistry, writeStudyRegistry } from '/home/user/Meme-snipe/packages/backtest/src/study/registry.ts';
const c = STUDY_CONFIG;
const p = studyPlan(c, TRIAL_POLICY.exits.tMaxMs + RESEARCH_CONFIG.s0.endMarginMs);
const b4 = c.regimes.find((r) => r.label === c.holdoutAfter)!;
const iso = (ms: number) => new Date(ms).toISOString();
const entryDays = Math.ceil((p.holdout.entriesTo - Date.parse(`${p.holdout.fromDay}T00:00:00Z`)) / 86_400_000);
const reg = { ...newStudyRegistry(2), plan: {
  study: `${c.version} sha256:${studyHash(c)}`,
  decisionWindow: { from: c.window.decisionFrom, to: c.window.decisionTo, leadInFrom: '2026-07-20' },
  holdout: { fromDay: p.holdout.fromDay, toDay: p.holdout.toDay, entriesFrom: iso(p.holdout.entriesFrom), entriesTo: iso(p.holdout.entriesTo), observationTailDays: c.holdout.tailDays },
  attempt: { index: c.holdoutAttempt, alpha: attemptAlpha(c.holdoutAttempt) },
  tieSalt: c.tieSalt,
  decoderBoundaries: c.regimes.filter((b) => !b.market && b.atMs >= Date.parse(`${p.holdout.fromDay}T00:00:00Z`)).map((b) => ({ label: b.label, at: iso(b.atMs) })),
  practice: { fromDay: p.walkForward.days[0]!, toDay: p.walkForward.days.at(-1)!, postB4From: iso(b4.atMs) },
  after: { label: b4.label, at: iso(b4.atMs) }, embargoMs: c.embargoMs, familySize: 2,
  holdoutIds: c.universes.map((u) => `${u.universe}-${p.holdout.fromDay}-${p.holdout.toDay}`),
  procedure: [
    'Configurations are chosen from practice days only, then frozen and registered before any U1/U2 configuration runs live; whoever selects them reads no live shakedown P&L before the freeze.',
    'Registering a configuration commits its attempt: at E the attempt is spent whatever happens. Halted, abandoned or short counts as a failed attempt, and the next configuration takes the next level.',
    'Entries stop at the cutoff E = 2026-10-20T00:00Z (UTC); the observation-only tail (the last entries\' full outcome window, plus the margin day 2026-10-20) matures before anything is scored.',
    'One sealed ledger with one endpoint for U1 and U2: run once, opened once after the tail, never for one universe while another is pending.',
    'A universe\'s seal opens only if its latest recorded G1 (practice days, all regimes pooled) passed; the registry refuses otherwise. Once G1 passed and the counts are met, opening is mandatory.',
    'Required: n >= max(300, n_power, closed form) at family alpha 0.04 (Holm across the 2 universes) on >= 10 Melbourne trade days; short means "not proven".',
    'B5 (2026-10-02T15:47Z) is a decoder boundary, not a market boundary: allowed inside the window, reported before and after as a non-gating line. B2-B4 stay hard.',
    'Attempt 2 (used only if attempt 1 is opened and fails, or is "not proven"): its configuration is registered after attempt 1 is scored; its window starts on the first whole UTC day after that registration and runs 28 days with a fixed entry cutoff and tail relative to that start, at family alpha 0.005 (attempt k: 0.01 / 2^(k-1)), same procedure, opened once.',
  ],
  sizing: {
    note: 'Pre-registered estimates (supervisor ruling 2026-10-04; end fixed at E by the consensus of the three reviews); no data was read. The holdout entries are registered when the configurations are frozen (RES-3 proposals).',
    graduatesPerDay: 1270, h9PassShare: 0.24, otherHardRejectPassShareAssumed: 0.3, setupAndRiskShareAssumed: 0.25,
    expectedEntriesPerDayPerUniverse: 23, holdoutEntryDays: entryDays, expectedHoldoutTradesPerUniverse: 23 * entryDays, plausibleRange: `${10 * entryDays}-${50 * entryDays}`,
    required: 'max(300, n_power, closed form) at family alpha 0.04 / 2 universes, on >= 10 Melbourne trade days; n_power simulated on the post-B4 walk-forward. Opened once, only after a G1 pass, and mandatory once the counts are met; if short, G2 = not proven',
  },
} };
writeStudyRegistry(process.argv[2]!, reg);
console.log(JSON.stringify(reg.plan, null, 1));
