// The decoder registry (ARCH M02 "exclusively owns"): built once at startup from the verified IDLs, immutable after.
// Ported from Snipe-solana card C03 (#6 @ 6ae4d62). The metric names are in the M27 catalog (packages/engine
// src/m27/catalog.ts) and the log code in the engine's M02_LOG_CODES; this package keeps structural ports so it
// stays free of every dependency but @bot/types (C-02).
import type { DecodedEvent, Pubkey, RawTransaction } from '@bot/types';
import { createAccountDecoder, type DecodedAccount, type DecodeFlags, type TokenPrograms } from './accounts.ts';
import { decodedOnly, decodeEventsLocated, decodeEventsWithGaps, type DecodedTransactionEvents, type EventHooks, type LocatedEvent } from './events.ts';
import type { PinnedIdl } from './idl.ts';

export class UnknownProgramError extends Error {
  readonly code = 'E_UNKNOWN_PROGRAM';
}

export interface DecodersOptions {
  /** SPL Token and Token-2022 program IDs from the constants registry (A-M01-01); without them token accounts are `unknown`. */
  tokenPrograms?: TokenPrograms;
  /** The wrapped SOL mint from the constants registry (A-M01-01 `MINTS.wsol`); without it no PumpSwap trade is SOL-quoted (Z03 ruling 3). */
  wsolMint?: Pubkey;
  /** M27 metrics: `decode_accounts_total{kind,result}`, `decode_events_total{kind}`, `decode_gap_total{reason}`, `decode_layout_extended_total{kind}`. */
  metrics?: { counter(name: 'decode_accounts_total' | 'decode_events_total' | 'decode_gap_total' | 'decode_layout_extended_total', labels: Readonly<Record<string, string>>): { inc(by?: number): void } };
  /** M27 log for `m02.unknown_event`, written once per discriminator per hour of `clock` time. */
  unknownEventLog?: { log: { event(level: 'warn', code: string, fields: Readonly<Record<string, unknown>>): void }; clock: { nowMs(): number } };
}

/** `m02.unknown_event` is logged at most once per discriminator in this period (A-M02-03 observability). */
export const UNKNOWN_EVENT_LOG_PERIOD_MS = 3_600_000;

export interface Decoders {
  idlVersion(program: Pubkey): { commit: string; sha256: string };
  decodeAccount(owner: Pubkey, data: Uint8Array): DecodedAccount;
  decodeAccountWithFlags(owner: Pubkey, data: Uint8Array): { account: DecodedAccount; flags: DecodeFlags };
  /** The `DecodedEvent`s; `pump_post_complete_buy` only comes from the located form (card IDL-REPIN). */
  decodeTransactionEvents(tx: RawTransaction): DecodedEvent[];
  /** The events with their place in the transaction and the layout flag (Z03 rulings m11 and 2). */
  decodeTransactionEventsLocated(tx: RawTransaction): LocatedEvent[];
  /** The located events and the gaps with their places, from one decode: the input of `pumpBuyTotals` (ruling 43). */
  decodeTransactionEventsWithGaps(tx: RawTransaction): DecodedTransactionEvents;
}

export function createDecoders(idls: readonly PinnedIdl[], opts: DecodersOptions = {}): Decoders {
  const byProgram = new Map(idls.map((i) => [i.program, i]));
  const accounts = createAccountDecoder(idls, opts.tokenPrograms,
    opts.metrics === undefined ? undefined : (kind, result) => opts.metrics?.counter('decode_accounts_total', { kind, result }).inc());
  const lastLogged = new Map<string, number>();
  const quote = opts.wsolMint === undefined ? {} : { wsolMint: opts.wsolMint };
  const hooks: EventHooks = {
    onEvent: (kind) => opts.metrics?.counter('decode_events_total', { kind }).inc(),
    onGap: (reason) => opts.metrics?.counter('decode_gap_total', { reason }).inc(),
    onLayoutExtended: (kind) => opts.metrics?.counter('decode_layout_extended_total', { kind }).inc(),
    onUnknown: (programId, discriminatorHex, signature) => {
      const u = opts.unknownEventLog;
      if (u === undefined) return;
      const key = `${programId}:${discriminatorHex}`;
      const now = u.clock.nowMs();
      const last = lastLogged.get(key);
      if (last !== undefined && now - last < UNKNOWN_EVENT_LOG_PERIOD_MS) return;
      lastLogged.set(key, now);
      u.log.event('warn', 'm02.unknown_event', { program: programId, discriminator: discriminatorHex, signature });
    },
  };
  return {
    idlVersion(program) {
      const idl = byProgram.get(program);
      if (idl === undefined) throw new UnknownProgramError('no pinned IDL for this program');
      return { commit: idl.commit, sha256: idl.sha256 };
    },
    decodeAccount: accounts.decodeAccount,
    decodeAccountWithFlags: accounts.decodeAccountWithFlags,
    decodeTransactionEvents: (tx) => decodedOnly(decodeEventsLocated(tx, idls, hooks, quote)),
    decodeTransactionEventsLocated: (tx) => decodeEventsLocated(tx, idls, hooks, quote),
    decodeTransactionEventsWithGaps: (tx) => decodeEventsWithGaps(tx, idls, hooks, quote),
  };
}
