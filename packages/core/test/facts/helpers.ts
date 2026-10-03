// Test helpers for the fact producers: the recorded mainnet inputs (fixtures/facts.json, fetch-facts.ts), market
// events in FEED-1's shapes (canonical.ts: `ev:` events of fetched transactions, wrapped off-chain facts, slot
// notices), and a small as-of world so produced facts can be read by GATE-1 exactly as the engine stores them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type RpcTransactionBase64, type TransactionRecord, recordFromRpc, transactionEvents } from '../../src/chain/index.ts';
import { AsOfStore, OFF_CHAIN, SimClock, type MarketEvent, type Moment } from '../../src/engine/index.ts';
import { FactFeed, FactProducer, type ProducerOptions } from '../../src/facts/index.ts';
import type { GateContext } from '../../src/gates/index.ts';

interface TxFixture { label: string; signature: string; slot: string; base64: RpcTransactionBase64 }
export interface FactsFixture {
  meta: { fetchedAt: string; mint: string; pool: string; migrationSlot: number; creationSlot: number; firstBuyers: string[] };
  transactions: TxFixture[];
  funders: { wallet: string; complete: boolean; funder: string | null; signature: string | null; slot: string | null }[];
  accountsRead: { mint: string; slot: string; commitment: string; accounts: { address: string; owner: string | null; data: string | null }[] };
  holdersRaw: {
    largest: { context: { slot: number }; value: { address: string; amount: string }[] };
    tokenAccountsSlot: number; ownersSlot: number;
    mint: { owner: string; data: string };
    owners: { owner: string; program: string | null }[];
  };
  thirdParty: {
    rugcheck: { mint: string; mintAuthority: string | null; freezeAuthority: string | null };
    goplus: { mintable: { status: string }; freezable: { status: string } } | null;
    jupiter: { mintAuthorityDisabled?: boolean; freezeAuthorityDisabled?: boolean } | null;
  };
  coinbase: string;
  llama: [number, number][];
}

export const FIX = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'facts.json'), 'utf8')) as FactsFixture;
export const MINT = FIX.meta.mint;
export const POOL = FIX.meta.pool;

/** Every recorded transaction as DEC-1's record, in chain order (slot, then fetch order within a slot). */
export const RECORDS: readonly { readonly label: string; readonly rec: TransactionRecord }[] = (() => {
  const seen = new Set<string>();
  return FIX.transactions
    .filter((t) => (seen.has(t.signature) ? false : (seen.add(t.signature), true)))
    .map((t) => ({ label: t.label, rec: recordFromRpc(t.signature, t.base64) }))
    .sort((a, b) => (a.rec.slot < b.rec.slot ? -1 : a.rec.slot > b.rec.slot ? 1 : 0));
})();

/** Each recorded transaction's position among its slot's recorded transactions (fetch order is block order). */
const RANK = (() => {
  const m = new Map<string, number>();
  const per = new Map<bigint, number>();
  for (const { rec } of RECORDS) {
    const n = per.get(rec.slot) ?? 0;
    m.set(rec.signature, n);
    per.set(rec.slot, n + 1);
  }
  return m;
})();
export const rankOf = (rec: TransactionRecord): number => RANK.get(rec.signature) ?? 0;

/** DEC-1's migration fixtures for the same coin (core/test/chain/fixtures/transactions.json). */
const CHAIN_TXS = (JSON.parse(readFileSync(join(import.meta.dirname, '..', 'chain', 'fixtures', 'transactions.json'), 'utf8')) as { transactions: TxFixture[] }).transactions;
export const chainTx = (label: string): TransactionRecord => {
  const t = CHAIN_TXS.find((x) => x.label.startsWith(label));
  if (!t) throw new Error(`no chain fixture ${label}`);
  return recordFromRpc(t.signature, t.base64);
};

const pad = (n: number): string => String(n).padStart(5, '0');
const LIVE_TX_BASE = 2 ** 32;
const IX_STRIDE = 2 ** 16;

/** A slot's milliseconds on the fixtures' timeline: the block time when known, else 400 ms per slot from a base. */
export const atOf = (rec: TransactionRecord, lagMs = 600): number => (rec.blockTime ?? 0) * 1000 + lagMs;

/** The events FEED-1 releases for a fetched transaction (canonical.ts, `tx` frame placed at its chain slot). */
export const txEvents = (rec: TransactionRecord, rank = rankOf(rec), receivedAt = atOf(rec), seq = rank): MarketEvent[] =>
  transactionEvents(rec).map((e) => {
    const subject = e.name === 'other' ? e.program : 'mint' in e.data ? e.data.mint : 'pool' in e.data ? e.data.pool : e.program;
    return {
      kind: 'market', id: `ev:${rec.signature}:${pad(e.outerIx)}:${pad(e.innerIx)}`,
      moment: { slot: rec.slot, txIndex: LIVE_TX_BASE + rank, ixIndex: 1 + e.outerIx * IX_STRIDE + e.innerIx, receivedAt },
      key: `${e.program}:${e.name}:${subject}`, value: { event: e, txSlot: rec.slot, blockTime: rec.blockTime, source: 'helius', backfilled: false, seq },
    };
  });

/** The same events as FEED-1 releases them from a log watch (`logs:` keys), with the watch's commitment. */
export const logEvents = (rec: TransactionRecord, commitment?: 'confirmed', rank = rankOf(rec), receivedAt = atOf(rec), via = `logs:${POOL}`): MarketEvent[] =>
  transactionEvents(rec).map((e, k) => {
    const subject = e.name === 'other' ? e.program : 'mint' in e.data ? e.data.mint : 'pool' in e.data ? e.data.pool : e.program;
    const { signature: _s, slot: _sl, txIndex: _t, outerIx: _o, innerIx: _i, ...ev } = e;
    return {
      kind: 'market', id: `log:${rec.signature}${commitment ? `:${commitment}` : ''}:${pad(k)}`,
      moment: { slot: rec.slot, txIndex: LIVE_TX_BASE + rank, ixIndex: 2 ** 36 + k, receivedAt },
      key: `logs:${e.program}:${e.name}:${subject}`,
      value: { event: { ...ev, logIndex: k }, signature: rec.signature, txSlot: rec.slot, truncated: false, via, ...(commitment ? { commitment } : {}), source: 'alchemy', backfilled: false, seq: rank },
    };
  });

let seq = 1_000_000;
/** An off-chain fact as FEED-1 wraps it, after every transaction of `slot`. */
export const offchain = (key: string, value: unknown, slot: bigint, receivedAt: number, source = 'worker'): MarketEvent => {
  const s = seq++;
  return { kind: 'market', id: `${key}#${s}`, moment: { slot, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt }, key, value: { value, source, backfilled: false, seq: s } };
};

export const slotNotice = (slot: bigint, receivedAt: number): MarketEvent => ({
  kind: 'market', id: `slot:${slot}`, moment: { slot, txIndex: OFF_CHAIN, ixIndex: 0, receivedAt }, key: 'chain:slot', value: { slot, parent: slot - 1n, root: slot - 32n, source: 'helius', backfilled: false, seq: seq++ },
});

export const coverage = (stream: string, part: 'start' | 'gap' | 'resume', v: Record<string, unknown>, slot: bigint, receivedAt: number): MarketEvent =>
  offchain(`coverage:${stream}:${part}`, v, slot, receivedAt);

export const OPTIONS: ProducerOptions = {
  candleFirstMs: 6 * 60_000, candleLastMs: 4 * 60_000, maxQuoteAgeMs: 2_000, survivalAfterMs: 30 * 60_000, survivalReadWindowMs: 60_000,
  graduatesKeepMs: 16 * 86_400_000 + 30 * 60_000, solUsdKeepMs: 30 * 3_600_000, insiderSlots: 2, firstBuyers: 20,
};

/**
 * Runs events in order through a FactFeed into an as-of store, as the engine does, and gives GATE-1 a context at any
 * moment reached. Events must come in the engine's total order.
 */
export class FactWorld {
  readonly clock = new SimClock({ slot: 0n, txIndex: 0, ixIndex: 0, receivedAt: 0 });
  readonly store = new AsOfStore(this.clock);
  readonly producer: FactProducer;
  readonly released: MarketEvent[] = [];
  readonly #queue: MarketEvent[] = [];

  constructor(options: ProducerOptions = OPTIONS) {
    this.producer = new FactProducer(options);
  }

  push(...events: readonly MarketEvent[]): this {
    this.#queue.push(...events);
    const inner = { next: () => this.#queue.shift() ?? null };
    const feed = new FactFeed(inner, this.producer);
    for (let e = feed.next(); e !== null; e = feed.next()) {
      if (e.kind !== 'market') continue;
      this.clock.advanceTo(e.moment);
      this.store.record(e.key, e.value, e.moment, e.id);
      this.released.push(e);
    }
    return this;
  }

  /** The fact events released for `key`, oldest first. */
  facts(key: string): MarketEvent[] {
    return this.released.filter((e) => e.key === key && e.id.includes('~'));
  }

  last(key: string): unknown {
    return this.facts(key).at(-1)?.value;
  }

  ctx(now?: Moment): GateContext {
    if (now !== undefined) this.clock.advanceTo(now);
    const store = this.store;
    return { now: this.clock.now(), lookup: (k, at) => store.lookup(k, at), history: (k, f, t) => store.history(k, f, t) };
  }
}
