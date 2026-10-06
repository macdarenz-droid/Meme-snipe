// A valid daily summary (OPS-SUMMARY), shared by the watchdog tests.
import type { Summary } from '../src/watchdog/summary.ts';

export const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export const goodSummary = (over: Partial<Summary> = {}): Summary => ({
  v: 1, day: '2026-10-04', final: false, generated_at: '2026-10-04T02:00:00.000Z', mode: 'paper',
  worker: {
    git_sha: 'a'.repeat(40), entry_rule: 'S0', uptime_s: 3600, starts: 1, recorder: 'on',
    restarts: { planned: 1, deploy: 0, unplanned: 2 }, exits: [{ code: 'crash', count: 2 }, { code: 'planned', count: 1 }],
    crash_sites: [{ error: 'TypeError', file: 'packages/core/src/engine/engine.ts', line: 151, event: 'logs:pump:CreateEvent', count: 2 }],
  },
  alerts: [{ code: 'position_unpriced', count: 1 }], halts: [{ code: 'feed-stale', count: 2 }],
  candidates: { seen: 3, entered: 1, refused: 2, refused_by_reason: [{ gate: 'H7', code: 'top-holders', count: 2 }], refused_other: 0 },
  trades: [{ mint: MINT, opened_at: '2026-10-04T01:00:00.000Z', closed_at: '2026-10-04T01:01:00.000Z', size_usd: '3', exit_reason: 'stop', net_lamports: '-1500000', net_usd: '-0.3' }],
  trades_dropped: 0, pnl: { closed_trades: 1, net_lamports: '-1500000', net_usd: '-0.3' }, open_positions: 0,
  provider_credits: [{ provider: 'helius', used_since_boot: 1234, monthly: 1_000_000 }],
  ...over,
});
