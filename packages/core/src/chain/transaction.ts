// One stored or streamed transaction, and the pump events in it. This is the shape agreed with DATA-1 so the
// backtester and the live feed decode through the same code (docs/ARCHITECTURE.md 16.1).
import { decodeBase58 } from './base58.ts';
import { type Address, DecodeError, fromBase64 } from './bytes.ts';
import { type DecodedTransaction, type LoadedAddresses, accountKeys, decodeTransaction } from './message.ts';
import { type EventProgram, type ProgramEvent, decodeEventBytes, decodeEventInstruction, programName } from './events.ts';

export interface InnerInstruction {
  readonly programIdIndex: number;
  readonly accounts: readonly number[];
  readonly data: Uint8Array;
  readonly stackHeight: number | null;
}

export interface TransactionRecord {
  readonly slot: bigint;
  readonly blockTime: number | null;
  /** Position in the block, when the source gives it. */
  readonly txIndex: number | null;
  readonly signature: string;
  /** Wire bytes (legacy, v0 or v1). */
  readonly transaction: Uint8Array;
  /** Null when the transaction succeeded; the RPC error value otherwise. */
  readonly err: unknown;
  readonly loadedAddresses: LoadedAddresses;
  /** Null when the source did not record inner instructions (then no events can be read from them). */
  readonly innerInstructions: readonly { readonly index: number; readonly instructions: readonly InnerInstruction[] }[] | null;
  readonly logMessages: readonly string[] | null;
}

export type LocatedEvent = ProgramEvent & {
  readonly signature: string;
  readonly slot: bigint;
  readonly txIndex: number | null;
  /** Top-level instruction that produced the event. */
  readonly outerIx: number;
  /** Position inside that instruction's inner-instruction list. */
  readonly innerIx: number;
};

/**
 * Every pump and PumpSwap event in a transaction, from its self-CPI inner instructions, in execution order.
 * A failed transaction returns none: its events were rolled back. Only inner instructions whose program is pump
 * or PumpSwap are read, so another program cannot forge an event by copying the bytes; the program itself
 * accepts the event instruction only from its own event-authority PDA.
 */
export const transactionEvents = (rec: TransactionRecord, decoded?: DecodedTransaction): LocatedEvent[] => {
  if (rec.err !== null && rec.err !== undefined) return [];
  if (rec.innerInstructions === null) throw new DecodeError(`transaction ${rec.signature} has no inner instructions recorded`);
  const tx = decoded ?? decodeTransaction(rec.transaction);
  if (tx.signatures[0] !== rec.signature) throw new DecodeError(`record signature ${rec.signature} does not match the transaction`);
  const keys = accountKeys(tx, rec.loadedAddresses);
  const out: LocatedEvent[] = [];
  for (const group of rec.innerInstructions) {
    group.instructions.forEach((ix, innerIx) => {
      const key = keys[ix.programIdIndex];
      if (key === undefined) throw new DecodeError(`inner program index ${ix.programIdIndex} is out of range`);
      const program = programName(key);
      if (!program) return;
      const ev = decodeEventInstruction(program, ix.data);
      if (ev) out.push({ ...ev, signature: rec.signature, slot: rec.slot, txIndex: rec.txIndex, outerIx: group.index, innerIx });
    });
  }
  return out;
};

export interface LogEvents {
  readonly events: readonly (ProgramEvent & { readonly logIndex: number })[];
  /** True when the node cut the log ("Log truncated"): events after the cut are missing. */
  readonly truncated: boolean;
}

const INVOKE = /^Program (\w+) invoke \[(\d+)\]$/;
const RESULT = /^Program (\w+) (success|failed: .*)$/;
const DATA = /^Program data: (.*)$/;

/**
 * Events from log lines (what `logsSubscribe` delivers). Each `Program data:` line belongs to the program on top
 * of the invoke stack; only pump and PumpSwap lines are decoded. Use inner instructions when you have them.
 * `err` is the transaction's error: a failed transaction's events were rolled back, so none are returned.
 */
export const logEvents = (logs: readonly string[], err: unknown): LogEvents => {
  if (err !== null && err !== undefined) return { events: [], truncated: false };
  const stack: string[] = [];
  const events: (ProgramEvent & { logIndex: number })[] = [];
  let truncated = false;
  logs.forEach((line, logIndex) => {
    if (line === 'Log truncated') {
      truncated = true;
      return;
    }
    const inv = INVOKE.exec(line);
    if (inv) {
      if (Number(inv[2]) !== stack.length + 1) throw new DecodeError(`invoke depth ${inv[2]} at log line ${logIndex}, expected ${stack.length + 1}`);
      stack.push(inv[1]!);
      return;
    }
    const res = RESULT.exec(line);
    if (res) {
      if (stack.at(-1) !== res[1]) throw new DecodeError(`log line ${logIndex} closes ${res[1]} but ${stack.at(-1)} is running`);
      stack.pop();
      return;
    }
    const data = DATA.exec(line);
    if (!data) return;
    const program: EventProgram | null = programName(stack.at(-1) ?? '');
    if (!program) return;
    // One `Program data:` line can hold several base64 chunks separated by spaces; Anchor emits one.
    const chunks = data[1]!.split(' ');
    if (chunks.length !== 1) throw new DecodeError(`expected one base64 chunk in an Anchor event log, got ${chunks.length}`);
    events.push({ ...decodeEventBytes(program, fromBase64(chunks[0]!)), logIndex });
  });
  return { events, truncated };
};

/** Builds a record from a `getTransaction` result fetched with `encoding: "base64"` and `maxSupportedTransactionVersion: 1`. */
export const recordFromRpc = (signature: string, res: RpcTransactionBase64, txIndex: number | null = null): TransactionRecord => {
  const [b64, encoding] = res.transaction;
  if (encoding !== 'base64') throw new DecodeError(`expected base64 transaction encoding, got ${encoding}`);
  const meta = res.meta;
  if (!meta) throw new DecodeError(`transaction ${signature} has no meta`);
  return {
    slot: BigInt(res.slot),
    blockTime: res.blockTime ?? null,
    txIndex,
    signature,
    transaction: fromBase64(b64),
    err: meta.err ?? null,
    loadedAddresses: {
      writable: (meta.loadedAddresses?.writable ?? []) as Address[],
      readonly: (meta.loadedAddresses?.readonly ?? []) as Address[],
    },
    innerInstructions:
      meta.innerInstructions === undefined || meta.innerInstructions === null
        ? null
        : meta.innerInstructions.map((g) => ({
            index: g.index,
            instructions: g.instructions.map((ix) => ({
              programIdIndex: ix.programIdIndex,
              accounts: ix.accounts,
              data: decodeBase58(ix.data),
              stackHeight: ix.stackHeight ?? null,
            })),
          })),
    logMessages: meta.logMessages ?? null,
  };
};

/** The subset of a JSON-RPC `getTransaction` (base64) result this module reads. */
export interface RpcTransactionBase64 {
  readonly slot: number;
  readonly blockTime?: number | null;
  readonly transaction: readonly [string, string];
  readonly meta: {
    readonly err?: unknown;
    readonly loadedAddresses?: { readonly writable: readonly string[]; readonly readonly: readonly string[] } | null;
    readonly innerInstructions?:
      | readonly {
          readonly index: number;
          readonly instructions: readonly { readonly programIdIndex: number; readonly accounts: readonly number[]; readonly data: string; readonly stackHeight?: number | null }[];
        }[]
      | null;
    readonly logMessages?: readonly string[] | null;
  } | null;
}
