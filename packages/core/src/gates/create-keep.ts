// OOM-MINT (supervisor ruling on the BT review, B1): a coin that migrates more than CREATE_KEEP_MS after its create is
// refused `create-expired`, judged from the facts alone (the create's chain time and the migration's), so live and
// the backtest refuse the same coins whatever order the events arrive in. Live also lets such a create's facts go once
// it is that old with no migration seen, and keeps an expired mark for when the facts are gone.
import { HOUR_MS } from '../config/time.ts';
import type { GateContext } from './evidence.ts';
import { createKey, migrationKey, parseCreate, parseMigration } from './facts.ts';

/** Twelve hours: almost every coin that graduates does so within hours of its create (`docs/DECISIONS.md`, OOM-MINT). */
export const CREATE_KEEP_MS = 12 * HOUR_MS;

/**
 * How much longer than `CREATE_KEEP_MS` live keeps a create's facts before letting them go: a migration delivered up to
 * an hour late is still judged from its facts, as the backtest judges it. One delivered later than that, for a create
 * already let go, is refused on the expired mark alone (as a coin seen across a restart's downtime would be judged
 * without what was missed). An hour costs about 8% more create memory than the 12 hours alone.
 */
export const CREATE_LATE_MS = HOUR_MS;

const value = (r: ReturnType<GateContext['lookup']>): unknown => (r.ok ? r.value : null);

/**
 * The rule from facts: `expired` when both the create and the migration are known and the migration came more than
 * `keepMs` after the create; `null` when either is unknown (the gates that need them say so).
 */
export const createKeepVerdict = (ctx: Pick<GateContext, 'lookup'>, mint: string, keepMs: number): { readonly expired: boolean; readonly detail: string } | null => {
  const create = parseCreate(value(ctx.lookup(createKey(mint))));
  const migration = parseMigration(value(ctx.lookup(migrationKey(mint))));
  if (create === null || migration === null) return null;
  const gap = migration.migratedAtMs - create.createdAtMs;
  return { expired: gap > keepMs, detail: `migrated ${gap} ms after its create; the limit is ${keepMs} ms` };
};
