// The insider funding supplement for the backtest (H13): first-funder lookups made once, by the same reader and the same
// link rule as live (core facts/funding.ts), written as JSON lines with a manifest of sha256 hashes. BT-2 reads it
// instead of calling RPC, so reruns are deterministic and cost no credits. Each row is as of its decision slot.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type FunderRead, insiderLinks, parseFunderRead } from '../../../core/src/facts/index.ts';

/** BT-2's shape (backtest/src/sim/facts.ts `FactOptions.insiders`), plus the reads it was built from. */
export interface SupplementRow {
  readonly mint: string;
  readonly creator: string;
  readonly asOfSlot: bigint;
  /** Null when a read was incomplete: the mint's insiders stay not covered. */
  readonly knownAtMs: number | null;
  readonly funded: readonly string[] | null;
  readonly devCluster: readonly string[] | null;
  readonly reads: readonly FunderRead[];
}

export interface SupplementInput {
  readonly mint: string;
  readonly creator: string;
  /** The create's slot: the dev's funding must come before it. */
  readonly createSlot: bigint;
  /** First buyers by the slot rule, each with the slot of its first buy. */
  readonly firstBuyers: readonly { readonly wallet: string; readonly slot: bigint }[];
  readonly asOfSlot: bigint;
}

/** Looks up a wallet's first funder as of `asOfSlot`, funded before `beforeSlot`. */
export type FunderLookup = (wallet: string, asOfSlot: bigint, beforeSlot: bigint) => Promise<FunderRead>;

/** Looks up the dev and every first buyer as of the decision slot and applies the shared link rule. */
export const supplementRow = async (input: SupplementInput, lookup: FunderLookup): Promise<SupplementRow> => {
  const reads: FunderRead[] = [await lookup(input.creator, input.asOfSlot, input.createSlot)];
  for (const b of input.firstBuyers) if (b.wallet !== input.creator) reads.push(await lookup(b.wallet, input.asOfSlot, b.slot));
  const byWallet = new Map(reads.map((r) => [r.wallet, r]));
  const wallets = input.firstBuyers.map((b) => b.wallet);
  const links = insiderLinks(input.creator, wallets, (w) => byWallet.get(w));
  return {
    mint: input.mint, creator: input.creator, asOfSlot: input.asOfSlot, reads,
    knownAtMs: links === null ? null : links.knownAtMs, funded: links?.funded ?? null, devCluster: links?.devCluster ?? null,
  };
};

const toJson = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));
const fromJson = (s: string): unknown => JSON.parse(s, (_k, x) => (typeof x === 'string' && /^\d+n$/.test(x) ? BigInt(x.slice(0, -1)) : x));
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export const SUPPLEMENT_FILE = 'insider-funding.jsonl';
export const SUPPLEMENT_MANIFEST = 'insider-funding.manifest.json';

/** Writes rows sorted by mint, byte for byte the same for the same rows, and the manifest with their hash. */
export const writeSupplement = (dir: string, rows: readonly SupplementRow[]): { readonly sha256: string; readonly rows: number } => {
  mkdirSync(dir, { recursive: true });
  const body = [...rows].sort((a, b) => (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0)).map((r) => toJson(r)).join('\n') + (rows.length > 0 ? '\n' : '');
  const out = { file: SUPPLEMENT_FILE, sha256: sha256(body), rows: rows.length };
  writeFileSync(join(dir, SUPPLEMENT_FILE), body);
  writeFileSync(join(dir, SUPPLEMENT_MANIFEST), JSON.stringify(out, null, 1) + '\n');
  return { sha256: out.sha256, rows: out.rows };
};

/** Reads the supplement, refusing it when its hash, row count or any row's reads do not check out. */
export const readSupplement = (dir: string): ReadonlyMap<string, SupplementRow> => {
  const manifest = JSON.parse(readFileSync(join(dir, SUPPLEMENT_MANIFEST), 'utf8')) as { file: string; sha256: string; rows: number };
  const body = readFileSync(join(dir, manifest.file), 'utf8');
  if (sha256(body) !== manifest.sha256) throw new Error('insider supplement: sha256 does not match the manifest');
  const rows = body.split('\n').filter((l) => l !== '').map((l) => fromJson(l) as SupplementRow);
  if (rows.length !== manifest.rows) throw new Error('insider supplement: row count does not match the manifest');
  const out = new Map<string, SupplementRow>();
  for (const r of rows) {
    if (out.has(r.mint) || !r.reads.every((x) => parseFunderRead(x) !== null && x.asOfSlot === r.asOfSlot)) throw new Error(`insider supplement: row ${r.mint} is malformed`);
    out.set(r.mint, r);
  }
  return out;
};
