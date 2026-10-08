// Shared scalars of the view-model contract (UI.md "Conventions (normative)", items 2, 4 and 5; B-M28-01 logic 1).
// Big integers are decimal strings checked with the @bot/types codecs (canonical text: no leading zeros, no "-0",
// within range); times are RFC 3339 UTC with milliseconds; untrusted token strings have UTF-8 byte limits.
import { fromI128Str, fromI64Str, fromU64Str } from '@bot/types';
import { z } from 'zod';

const BASE58 = '[1-9A-HJ-NP-Za-km-z]';

export const U64Str = z.string().refine((s) => fromU64Str(s).ok, { message: 'U64Str: a decimal u64 without leading zeros' });
export const I64Str = z.string().refine((s) => fromI64Str(s).ok, { message: 'I64Str: a decimal i64 without leading zeros' });
export const I128Str = z.string().refine((s) => fromI128Str(s).ok, { message: 'I128Str: a decimal i128 without leading zeros' });
/** Lamports: `U64Str` for balances (UI convention 5); signed amounts use `I64Str` as each field says. */
export const LamportsStr = U64Str;
export const DecimalStr = z.string().regex(/^-?(0|[1-9][0-9]*)(\.[0-9]{1,30})?$/, 'DecimalStr: an exact decimal without exponent');
export const Pubkey = z.string().regex(new RegExp(`^${BASE58}{32,44}$`), 'Pubkey: base58, 32-44 characters');
export const Signature = z.string().regex(new RegExp(`^${BASE58}{64,88}$`), 'Signature: base58, 64-88 characters');
export const Id = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'Id: a ULID, 26 Crockford base32 characters');
export const Mode = z.enum(['backtest', 'replay', 'paper', 'live_small', 'live']);
export const Commitment = z.enum(['processed', 'confirmed', 'finalized']);
export const Severity = z.enum(['info', 'warning', 'critical']);
export const ActionClass = z.enum(['A0', 'A1', 'A2', 'A3']);

const encoder = new TextEncoder();
/** Attacker-controllable text with a UTF-8 byte limit (symbol 32, name 64; UI convention 5). */
export const UntrustedString = (maxBytes: number) =>
  z.string().refine((s) => encoder.encode(s).length <= maxBytes, { message: `at most ${maxBytes} UTF-8 bytes` });
export const UntrustedSymbol = UntrustedString(32);
export const UntrustedName = UntrustedString(64);

/** `_at`: RFC 3339 UTC with milliseconds, e.g. 2026-10-06T14:02:11.123Z, and a real calendar time. */
export const At = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, '_at: RFC 3339 UTC with milliseconds')
  .refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s, { message: '_at: not a calendar time' });
/** `_bps`: integer basis points (int32; ratios 0-10000, signed changes may exceed it). */
export const Bps = z.number().int().min(-2_147_483_648).max(2_147_483_647);
/** `_ms`: milliseconds, may be fractional, >= 0. */
export const Ms = z.number().nonnegative();
/** `_s`, `_count`, `_bytes`: integers >= 0. */
export const Seconds = z.number().int().nonnegative();
export const Count = z.number().int().nonnegative();
export const Bytes = z.number().int().nonnegative();
/** Mint decimals (u8). */
export const Decimals = z.number().int().min(0).max(255);
/** VM-10 display-only series values: JSON numbers with |v| < 2^53 (UI convention 3). */
export const SeriesNumber = z.number().refine((v) => Math.abs(v) < 2 ** 53, { message: '|v| must be below 2^53' });
/** sha256 in lowercase hex (audit chain). */
export const Hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'lowercase hex sha256');
/** An `_at` window. */
export const Window = z.strictObject({ from: At, to: At });
export const CodeMessage = z.strictObject({ code: z.string(), message: z.string() });
export const Flag = z.strictObject({ code: z.string(), severity: Severity, message: z.string() });
/** ARCH 5.0a `Actor`, with `sentinel` and `cli` (UC-06). */
export const Actor = z.strictObject({ type: z.enum(['operator', 'risk_engine', 'system', 'scheduler', 'sentinel', 'cli']), id: z.string(), display: z.string() });
/** A JSON object (VM-17 `before`/`after`, VM-19 `step_up_assertion`): string keys, JSON values. */
export const JsonObject = z.record(z.string(), z.json());
