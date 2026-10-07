// ARCH 5.0 shared types (B-M19-01). Copied from ARCH 5.0 with one deliberate change: the unit types carry a
// phantom unit tag (`Unit`), so a value of one unit is a compile error where another unit is expected
// (Slot where Lamports is expected, Cu where Bps is expected). Plain bigint and number values are still
// accepted, so every ARCH-shaped signature compiles unchanged. Runtime guards are in units.ts.

declare const unitTag: unique symbol;

/** A `T` tagged with the unit `U`. The tag is optional and type-only: it exists at compile time, never at run time. */
export type Unit<T extends bigint | number | string, U extends string> = T & { readonly [unitTag]?: U };

// Units are in the type name. All on-chain quantities are bigint; never JS number.
export type Lamports = Unit<bigint, 'Lamports'>;                     // 1 SOL = 1_000_000_000 lamports
export type SignedLamports = Unit<bigint, 'SignedLamports'>;         // PnL, deltas
export type BaseUnits = Unit<bigint, 'BaseUnits'>;                   // raw u64 token amount (decimals applied only for display)
export type MicroLamportsPerCu = Unit<bigint, 'MicroLamportsPerCu'>; // compute-unit price
export type Cu = Unit<number, 'Cu'>;                                 // compute units (≤ 1_400_000 per tx [LD-02])
export type Bps = Unit<number, 'Bps'>;                               // integer basis points
export type Slot = Unit<bigint, 'Slot'>;
export type BlockHeight = Unit<bigint, 'BlockHeight'>;
export type Pubkey = string;              // base58, 32-44 chars
export type Signature = string;           // base58, 64-88 chars
export type UnixMs = Unit<number, 'UnixMs'>;                         // epoch milliseconds UTC (wall or sim clock)
export type Id = string;                  // ULID
export type Mode = 'backtest' | 'replay' | 'paper' | 'live_small' | 'live';
export type Commitment = 'processed' | 'confirmed' | 'finalized';
export type DecimalStr = string;          // exact decimal, no exponent (UI.md convention)
export type Result<T, E extends { code: string }> = { ok: true; value: T } | { ok: false; error: E };

export interface Clock { nowMs(): UnixMs; kind: 'wall' | 'sim' }   // injected everywhere; no Date.now() in modules
export interface EventBus { publish<T>(topic: string, e: T): void; subscribe<T>(topic: string, h: (e: T) => void): () => void }
