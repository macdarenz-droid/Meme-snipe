import { coverageGaps, lookupLatency, quotaReport, rejections } from '../src/quota.ts';
import type { Ops } from '../src/report.ts';

/** Quota and coverage of a clean run: one provider well inside its plan, nothing shed. */
export const OPS_OK: Ops = {
  quota: quotaReport(
    [
      {
        quota: [
          { provider: 'helius', credits_used: 10, credits_by_class: [1, 4, 3, 2], monthly_credits: 1_000_000, granted: [1, 1, 1, 1], shed: [0, 0, 0, 0], halted: false },
          { provider: 'alchemy', credits_used: 0, credits_by_class: [0, 0, 0, 0], monthly_credits: 30_000_000, granted: [0, 0, 0, 0], shed: [0, 0, 0, 0], halted: false },
          { provider: 'jupiter', credits_used: 0, credits_by_class: [0, 0, 0, 0], monthly_credits: null, granted: [0, 0, 0, 0], shed: [0, 0, 0, 0], halted: false },
        ],
        lookups: { counts: [] },
      },
    ],
    100_000,
  ),
  lookups: lookupLatency([]),
  coverage: coverageGaps([], 0),
  rejections: rejections([]),
};
