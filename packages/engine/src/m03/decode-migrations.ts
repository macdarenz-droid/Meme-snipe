// The A-M03-02 decode port over @bot/decoders (A-M02-03), passed in structurally by the composition root: the engine
// does not depend on @bot/decoders. `getTransaction` (json, version 1) → `readRpcTransaction` → `decodeEventsWithGaps`
// with the pinned IDLs; the `pump_migration` events and the count of `non_sol_quote` gaps come back.
import type { Pubkey, Result, Signature, Slot } from '@bot/types';
import type { DecodeMigrations } from './backfill.ts';

interface TxLike { slot: bigint; blockTimeS: number | null; meta: { err: unknown } }
interface EventLike { event: { kind: string; mint?: unknown; pool?: unknown; slot?: unknown; signature?: unknown } }
export interface DecoderFns<T extends TxLike, I> {
  readRpcTransaction(signature: Signature, result: unknown): Result<T, { code: string }>;
  decodeEventsWithGaps(tx: T, idls: readonly I[], hooks: Record<string, never>, quote: { wsolMint: Pubkey }): { events: EventLike[]; gaps: Array<{ reason: string }> };
}

export function migrationDecoder<T extends TxLike, I>(fns: DecoderFns<T, I>, idls: readonly I[], wsolMint: Pubkey): DecodeMigrations {
  return (signature, result) => {
    const tx = fns.readRpcTransaction(signature, result);
    if (!tx.ok) return { ok: false, error: { code: tx.error.code } };
    if (tx.value.meta.err !== null) return { ok: true, value: { blockTimeS: tx.value.blockTimeS, failed: true, migrations: [], nonSolQuote: 0 } };
    const d = fns.decodeEventsWithGaps(tx.value, idls, {}, { wsolMint });
    const migrations = d.events.filter((e) => e.event.kind === 'pump_migration').map((e) => ({
      mint: e.event.mint as Pubkey, pool: e.event.pool as Pubkey, slot: e.event.slot as Slot, signature: e.event.signature as Signature,
    }));
    return { ok: true, value: { blockTimeS: tx.value.blockTimeS, failed: false, migrations, nonSolQuote: d.gaps.filter((g) => g.reason === 'non_sol_quote').length } };
  };
}
