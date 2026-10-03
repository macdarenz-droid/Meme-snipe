// Golden vectors for pump and PumpSwap events from mainnet transactions. Oracles: the IDL-driven decoder
// (helpers.ts), the log copy of each event (pump emits both), the block time, and the token balance changes.
import { describe, expect, it } from 'vitest';
import { decodeBase58 } from '../../src/chain/base58.ts';
import { DecodeError } from '../../src/chain/bytes.ts';
import { EVENT_IX_TAG, TradeEventLayout, BuyEventLayout, decodeEventBytes, decodeEventInstruction } from '../../src/chain/events.ts';
import { type TransactionRecord, logEvents, recordFromRpc, transactionEvents } from '../../src/chain/transaction.ts';
import { decodeTransaction } from '../../src/chain/message.ts';
import { IDL, TRANSACTIONS, type TxFixture, idlDecode, normalize } from './helpers.ts';

/** Inner instruction data in RPC JSON is base58. */
const fromBase58 = decodeBase58;
const record = (t: TxFixture, txIndex: number | null = null): TransactionRecord => recordFromRpc(t.signature, t.base64 as never, txIndex);
const withEvents = TRANSACTIONS.filter((t) => t.base64.meta.err === null);
const allEvents = withEvents.flatMap((t) => transactionEvents(record(t)).map((e) => ({ t, e })));
const UNDOCUMENTED_TAIL = new Set(['TradeEvent', 'BuyEvent', 'SellEvent']);
const named = (name: string) => allEvents.filter((x) => x.e.name === name);

describe('events from mainnet', () => {
  it('include every event type DEC-1 decodes', () => {
    const names = new Set(allEvents.map((x) => x.e.name));
    for (const n of ['TradeEvent', 'CreateEvent', 'CompleteEvent', 'BuyEvent', 'SellEvent', 'CompletePumpAmmMigrationEvent', 'CreatePoolEvent', 'InitBoostEvent', 'BoostBuyAndBurnEvent']) {
      expect(names, n).toContain(n);
    }
  });

  it.each(allEvents.filter((x) => x.e.name !== 'other').map((x) => [`${x.e.name} ${x.t.signature.slice(0, 8)} #${x.e.outerIx}.${x.e.innerIx}`, x] as const))(
    '%s equals the IDL decode, has no unknown bytes and the block time',
    (_n, { t, e }) => {
      if (e.name === 'other') throw new Error('unreachable');
      const ix = t.base64.meta.innerInstructions!.find((g) => g.index === e.outerIx)!.instructions[e.innerIx]!;
      const bytes = decodeEventInstruction(e.program, fromBase58(ix.data));
      expect(bytes).not.toBeNull();
      const oracle = idlDecode(e.program, e.name, fromBase58(ix.data).subarray(16));
      expect(normalize(e.data)).toEqual(normalize(oracle.value));
      // Trade, Buy and Sell carry 8 bytes newer than every published IDL (see ProgramEvent); all others end exactly.
      expect(e.trailing).toBe(UNDOCUMENTED_TAIL.has(e.name) ? 8 : 0);
      expect(oracle.trailing).toBe(e.trailing);
      expect(e.extra).toHaveLength(2 * e.trailing);
      expect(e.data.timestamp).toBe(BigInt(t.blockTime!));
      expect(e.slot).toBe(BigInt(t.slot));
    },
  );

  it('match the log copy of each event, in the same order', () => {
    for (const t of withEvents) {
      const fromIx = transactionEvents(record(t)).filter((e) => e.name !== 'other');
      const logs = logEvents(t.base64.meta.logMessages ?? [], t.base64.meta.err);
      if (logs.truncated) continue;
      const fromLogs = logs.events.filter((e) => e.name !== 'other');
      expect(fromLogs.map((e) => [e.name, normalize('data' in e ? e.data : null)])).toEqual(fromIx.map((e) => [e.name, normalize('data' in e ? e.data : null)]));
    }
  });

  it('agree with the token balance changes: a TradeEvent moves exactly tokenAmount of its mint for the user', () => {
    for (const { t, e } of named('TradeEvent')) {
      if (e.name !== 'TradeEvent') continue;
      const pre = t.base64.meta.preTokenBalances ?? [];
      const post = t.base64.meta.postTokenBalances ?? [];
      const bal = (list: typeof pre) => BigInt(list.find((b) => b.mint === e.data.mint && b.owner === e.data.user)?.uiTokenAmount.amount ?? '0');
      const delta = bal(post) - bal(pre);
      // One transaction can hold several trades by the same user on the same mint; sum them.
      const sum = named('TradeEvent')
        .filter((x) => x.t === t && x.e.name === 'TradeEvent' && x.e.data.mint === e.data.mint && x.e.data.user === e.data.user)
        .reduce((s, x) => (x.e.name === 'TradeEvent' ? s + (x.e.data.isBuy ? x.e.data.tokenAmount : -x.e.data.tokenAmount) : s), 0n);
      expect(delta).toBe(sum);
    }
  });

  it('carry the mayhem flag: a mayhem create and its first trade both say so', () => {
    const mayhem = TRANSACTIONS.filter((t) => t.label.includes('(mayhem)'));
    expect(mayhem.length).toBeGreaterThan(0);
    for (const t of mayhem) {
      const evs = transactionEvents(record(t));
      const create = evs.find((e) => e.name === 'CreateEvent');
      expect(create?.name === 'CreateEvent' && create.data.isMayhemMode).toBe(true);
      for (const e of evs) if (e.name === 'TradeEvent') expect(e.data.mayhemMode).toBe(true);
    }
    const normal = named('CreateEvent').filter((x) => !x.t.label.includes('(mayhem)'));
    for (const { e } of normal) expect(e.name === 'CreateEvent' && e.data.isMayhemMode).toBe(false);
  });

  it('carry a negative virtual_quote_reserves exactly as signed', () => {
    const neg = allEvents.filter((x) => (x.e.name === 'BuyEvent' || x.e.name === 'SellEvent') && (x.e.data.virtualQuoteReserves ?? 0n) < 0n);
    expect(neg.length).toBeGreaterThan(0);
    for (const { e } of neg) {
      if (e.name !== 'BuyEvent' && e.name !== 'SellEvent') continue;
      // Effective reserves stay positive (pump's guarantee) and reproduce the event's own pre-trade reserves.
      expect(e.data.poolQuoteTokenReserves + e.data.virtualQuoteReserves!).toBeGreaterThan(0n);
    }
  });

  it('come back in (outerIx, innerIx) order with the record location', () => {
    for (const t of withEvents) {
      const evs = transactionEvents(record(t, 5));
      for (let i = 1; i < evs.length; i++) {
        const a = evs[i - 1]!;
        const b = evs[i]!;
        expect(a.outerIx < b.outerIx || (a.outerIx === b.outerIx && a.innerIx < b.innerIx)).toBe(true);
      }
      for (const e of evs) expect([e.signature, e.txIndex]).toEqual([t.signature, 5]);
    }
  });
});

describe('event safety', () => {
  const failed = TRANSACTIONS.find((t) => t.base64.meta.err !== null);

  it('returns no events for a failed transaction (they were rolled back)', () => {
    expect(failed).toBeDefined();
    expect(transactionEvents(record(failed!))).toEqual([]);
    expect(logEvents(failed!.base64.meta.logMessages ?? [], failed!.base64.meta.err).events).toEqual([]);
  });

  it('ignores event bytes emitted by any program other than pump and PumpSwap', () => {
    const t = named('TradeEvent')[0]!.t;
    const rec = record(t);
    const tx = decodeTransaction(rec.transaction);
    // Point every inner instruction at the system program (index of a non-pump key): no events remain.
    const sys = tx.staticAccountKeys.findIndex((k) => k === '11111111111111111111111111111111');
    expect(sys).toBeGreaterThanOrEqual(0);
    const forged: TransactionRecord = {
      ...rec,
      innerInstructions: rec.innerInstructions!.map((g) => ({ ...g, instructions: g.instructions.map((ix) => ({ ...ix, programIdIndex: sys })) })),
    };
    expect(transactionEvents(forged)).toEqual([]);
  });

  it('refuses a record whose signature does not match its transaction', () => {
    const t = named('TradeEvent')[0]!.t;
    expect(() => transactionEvents({ ...record(t), signature: 'x' })).toThrow(DecodeError);
  });

  it('reports truncated logs', () => {
    const t = named('TradeEvent')[0]!.t;
    const logs = [...(t.base64.meta.logMessages ?? []).slice(0, 3), 'Log truncated'];
    expect(logEvents(logs, null).truncated).toBe(true);
  });
});

describe('older and newer event layouts', () => {
  const trade = named('TradeEvent')[0]!;
  const ix = trade.t.base64.meta.innerInstructions!.find((g) => g.index === trade.e.outerIx)!.instructions[trade.e.innerIx]!;
  const full = fromBase58(ix.data).subarray(8);

  /** Byte length of the first `n` fields of a TradeEvent, measured with the IDL oracle on the real event. */
  const prefixLength = (fields: number) => {
    const names = IDL.programs.pump.types['TradeEvent']!.fields.slice(0, fields).map((f) => f.name);
    for (let len = 8; len <= full.length; len++) {
      try {
        const o = idlDecode('pump', 'TradeEvent', full.subarray(8, len));
        if (Object.keys(o.value).length === names.length && o.trailing === 0) return len;
      } catch {
        // Not a field boundary.
      }
    }
    throw new Error('no prefix found');
  };

  it('decodes a 2025-04 TradeEvent (first 10 fields) with every later field absent, not zero', () => {
    const len = prefixLength(TradeEventLayout.base.length);
    const e = decodeEventBytes('pump', full.subarray(0, len));
    expect(e.name).toBe('TradeEvent');
    if (e.name !== 'TradeEvent') return;
    expect(Object.keys(e.data)).toHaveLength(10);
    expect(e.data.virtualQuoteReserves).toBeUndefined();
    expect(e.data.feeBasisPoints).toBeUndefined();
    expect(e.trailing).toBe(0);
  });

  it('refuses an event cut inside a field, or before its first published layout ends', () => {
    const len = prefixLength(TradeEventLayout.base.length);
    expect(() => decodeEventBytes('pump', full.subarray(0, len - 1))).toThrow(DecodeError);
    expect(() => decodeEventBytes('pump', full.subarray(0, prefixLength(TradeEventLayout.base.length + 1) - 3))).toThrow(DecodeError);
  });

  it('reports bytes beyond the pinned layout as trailing (a newer program) and keeps them, without guessing them', () => {
    const e = decodeEventBytes('pump', Uint8Array.from([...full, 1, 2, 3]));
    if (e.name !== 'TradeEvent') throw new Error('expected a TradeEvent');
    expect(e.trailing).toBe(trade.e.name === 'TradeEvent' ? trade.e.trailing + 3 : -1);
    expect(e.extra.endsWith('010203')).toBe(true);
  });

  it('returns "other" for an unknown discriminator and requires the self-CPI tag', () => {
    expect(decodeEventBytes('pump', new Uint8Array(8))).toEqual({ program: 'pump', name: 'other', discriminator: '0000000000000000' });
    expect(decodeEventInstruction('pump', full)).toBeNull();
    expect(decodeEventInstruction('pump', Uint8Array.from([...EVENT_IX_TAG, ...full]))?.name).toBe('TradeEvent');
  });

  it('reads a pre-2026-09-30 BuyEvent without virtual_quote_reserves as absent', () => {
    const buy = named('BuyEvent')[0]!;
    const bix = buy.t.base64.meta.innerInstructions!.find((g) => g.index === buy.e.outerIx)!.instructions[buy.e.innerIx]!;
    const bytes = fromBase58(bix.data).subarray(8);
    const fields = IDL.programs.pump_amm.types['BuyEvent']!.fields;
    const vqrIndex = fields.findIndex((f) => f.name === 'virtual_quote_reserves');
    expect(vqrIndex).toBe(BuyEventLayout.base.length + BuyEventLayout.added.findIndex(([n]) => n === 'virtualQuoteReserves'));
    let cut = 0;
    for (let len = 8; len <= bytes.length; len++) {
      try {
        const o = idlDecode('pump_amm', 'BuyEvent', bytes.subarray(8, len));
        if (Object.keys(o.value).length === vqrIndex && o.trailing === 0) {
          cut = len;
          break;
        }
      } catch {
        // Not a boundary.
      }
    }
    const e = decodeEventBytes('pump_amm', bytes.subarray(0, cut));
    expect(e.name === 'BuyEvent' && e.data.virtualQuoteReserves).toBeUndefined();
  });
});
