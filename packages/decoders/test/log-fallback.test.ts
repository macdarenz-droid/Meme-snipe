// A-M02-04 guarded `Program data:` log fallback (card Z07). The recorded PumpSwap transactions write each Buy/SellEvent
// both as a self-CPI and as a `Program data:` line in PumpSwap's own frame; "logs only" fixtures are synthetic: a real
// transaction with its inner instructions removed (ruling Z07-5, built here from the recorded file, never fetched).
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import type { RawTransaction } from '@bot/types';
import { createDecoders, readRpcTransaction } from '../src/index.ts';
import { decoders, DEFAULT_PUBKEY, fixture, idls, programOf, TOKEN_PROGRAMS, WSOL } from './fixtures.ts';

type TxRecord = { signature: string; json: unknown };
const SWAPS = ['2JncvkXg', '2Ta573eN', '2TipyhLt', '49MbpHBy', '54aFRgFw', '5KGXqZKp', '5Z6GNb2b', 'TvpwJWSt'].map((f) => fixture<TxRecord>(`mainnet/tx/pumpswap/tx_${f}.json`));
const raw = (rec: TxRecord): RawTransaction => {
  const r = readRpcTransaction(rec.signature, rec.json);
  assert.ok(r.ok);
  return r.value;
};
const PSWAP = programOf('pump_amm');
const d = decoders();
const logsOnly = (rec: TxRecord): RawTransaction => {
  const t = raw(rec);
  t.meta.innerInstructions = [];
  return t;
};
const logs = (t: RawTransaction): string[] => t.meta.logMessages as string[];
const dataLines = (t: RawTransaction): number[] => logs(t).flatMap((l, i) => (l.startsWith('Program data: ') ? [i] : []));
const withGaps = (gaps: string[], events: Array<[string, string]> = []) => createDecoders(idls(), {
  wsolMint: WSOL,
  metrics: { counter: (name, l) => ({ inc: () => { if (name === 'decode_gap_total') gaps.push(String(l.reason)); if (name === 'decode_events_total') events.push([String(l.kind), String(l.source)]); } }) },
});

describe('A-M02-04 acceptance', () => {
  it('AC1 (synthetic: recorded swaps with inner instructions removed): exactly one event per swap, source log, equal to the self-CPI event', () => {
    for (const rec of SWAPS) {
      const full = d.decodeTransactionEventsWithProvenance(raw(rec));
      assert.ok(full.sources.every((s) => s === 'self_cpi') && full.events.length >= 1, rec.signature);
      const stripped = d.decodeTransactionEventsWithProvenance(logsOnly(rec));
      assert.deepEqual(stripped.sources, full.events.map(() => 'log'), rec.signature);
      assert.deepEqual(stripped.events.map((e) => e.event), full.events.map((e) => e.event), rec.signature);
      for (const [i, e] of stripped.events.entries()) {
        assert.equal(e.outerIx, full.events[i]?.outerIx);
        assert.equal(e.innerIx, -1);                                  // the top-level swap itself
        assert.equal(e.multiHop, false);
      }
      assert.deepEqual(d.decodeTransactionEvents(logsOnly(rec)), d.decodeTransactionEvents(raw(rec)));
    }
  });

  it('AC2 (synthetic): the same with `Log truncated` in the logs gives no event and a truncated gap [DA-05]', () => {
    const gaps: string[] = [];
    const t = logsOnly(SWAPS[0] as TxRecord);
    t.meta.logMessages = [...logs(t), 'Log truncated'];
    assert.deepEqual(withGaps(gaps).decodeTransactionEventsWithProvenance(t).events, []);
    assert.deepEqual(gaps, ['no_inner', 'truncated']);
  });
});

describe('A-M02-04 rules', () => {
  it('edge 3: with both self-CPI and log events present only the self-CPI ones are used (no duplicates)', () => {
    for (const rec of SWAPS) {
      const t = raw(rec);
      assert.ok(dataLines(t).length >= 1);
      const on = d.decodeTransactionEventsWithProvenance(t);
      const off = decoders({ logFallback: false }).decodeTransactionEventsWithProvenance(t);
      assert.deepEqual(on, off, rec.signature);
    }
  });

  it('edge 1: logs null is a no_logs gap; edge 2: a line that is not base64 is skipped as bad_log', () => {
    const gaps: string[] = [];
    const t = logsOnly(SWAPS[0] as TxRecord);
    t.meta.logMessages = null;
    assert.deepEqual(withGaps(gaps).decodeTransactionEvents(t), []);
    assert.deepEqual(gaps, ['no_inner', 'no_logs']);
    const bad: string[] = [];
    const b = logsOnly(SWAPS[0] as TxRecord);
    const at = dataLines(b)[0] as number;
    b.meta.logMessages = [...logs(b).slice(0, at), 'Program data: not*base64', ...logs(b).slice(at)];
    assert.equal(withGaps(bad).decodeTransactionEvents(b).length, 1);
    assert.deepEqual(bad, ['no_inner', 'bad_log']);
  });

  it('an inconsistent stack (a skipped level, a wrong program leaving, data outside any frame, an open frame) is bad_log', () => {
    const variants: Array<(l: string[]) => string[]> = [
      (l) => l.map((x) => x.replace(`Program ${PSWAP} invoke [1]`, `Program ${PSWAP} invoke [2]`)),
      (l) => l.map((x) => (x === `Program ${PSWAP} success` ? `Program ${DEFAULT_PUBKEY} success` : x)),
      (l) => ['Program data: AAAAAAAAAAA=', ...l],
      (l) => l.slice(0, -1),
    ];
    for (const v of variants) {
      const gaps: string[] = [];
      const t = logsOnly(SWAPS[0] as TxRecord);
      t.meta.logMessages = v(logs(t));
      assert.deepEqual(withGaps(gaps).decodeTransactionEvents(t), []);
      assert.ok(gaps.includes('bad_log'), gaps.join());
    }
  });

  it('attribution by the invocation stack: PumpSwap event data written inside another program\'s frame is never read', () => {
    const gaps: string[] = [];
    const t = logsOnly(SWAPS[0] as TxRecord);
    const l = logs(t);
    const at = dataLines(t)[0] as number;
    const line = l[at] as string;
    // Move the data line into a Token program frame nested in PumpSwap's.
    const token = TOKEN_PROGRAMS.splToken;
    t.meta.logMessages = [...l.slice(0, at), `Program ${token} invoke [2]`, line, `Program ${token} success`, ...l.slice(at + 1)];
    assert.deepEqual(withGaps(gaps).decodeTransactionEvents(t), []);
    assert.deepEqual(gaps, ['no_inner', 'log_ambiguous']);
  });

  it('two PumpSwap frames with event data for one swap is log_ambiguous; an unknown discriminator in a log is unknown_event', () => {
    const gaps: string[] = [];
    const t = logsOnly(SWAPS[0] as TxRecord);
    const l = logs(t);
    t.meta.logMessages = [...l, `Program ${PSWAP} invoke [1]`, l[dataLines(t)[0] as number] as string, `Program ${PSWAP} success`];
    assert.deepEqual(withGaps(gaps).decodeTransactionEvents(t), []);
    assert.deepEqual(gaps, ['no_inner', 'log_ambiguous']);
    const u: string[] = [];
    const k = logsOnly(SWAPS[0] as TxRecord);
    const at = dataLines(k)[0] as number;
    const bytes = Buffer.from((logs(k)[at] as string).slice('Program data: '.length), 'base64');
    bytes.fill(0xab, 0, 8);
    k.meta.logMessages = logs(k).map((x, i) => (i === at ? `Program data: ${bytes.toString('base64')}` : x));
    const r = withGaps(u).decodeTransactionEventsWithProvenance(k);
    assert.deepEqual(r.events.map((e) => [e.event.kind, (e.event as { discriminatorHex?: string }).discriminatorHex]), [['unknown_event', 'abababababababab']]);
    assert.deepEqual(r.sources, ['log']);
    assert.deepEqual(u, ['no_inner', 'unknown_disc']);
  });

  it('a log event too short for its layout is a truncated gap; a line longer than any event is oversized', () => {
    const gaps: string[] = [];
    const t = logsOnly(SWAPS[0] as TxRecord);
    const at = dataLines(t)[0] as number;
    const bytes = Buffer.from((logs(t)[at] as string).slice('Program data: '.length), 'base64');
    t.meta.logMessages = logs(t).map((x, i) => (i === at ? `Program data: ${bytes.subarray(0, 40).toString('base64')}` : x));
    assert.deepEqual(withGaps(gaps).decodeTransactionEvents(t), []);
    assert.deepEqual(gaps, ['no_inner', 'truncated']);
    const big: string[] = [];
    const o = logsOnly(SWAPS[0] as TxRecord);
    o.meta.logMessages = logs(o).map((x, i) => (i === at ? `Program data: ${Buffer.alloc(4_096, 1).toString('base64')}` : x));
    assert.deepEqual(withGaps(big).decodeTransactionEvents(o), []);
    assert.deepEqual(big, ['no_inner', 'oversized']);
  });

  it('decoders.log_fallback_enabled = false: no log events; failed transactions and swaps below a route never use logs', () => {
    assert.deepEqual(decoders({ logFallback: false }).decodeTransactionEvents(logsOnly(SWAPS[0] as TxRecord)), []);
    const failed = logsOnly(SWAPS[0] as TxRecord);
    failed.meta.err = { InstructionError: [0, 'x'] };
    assert.deepEqual(d.decodeTransactionEvents(failed), []);
    // A route (multi_hop_swap) at the top with the recorded swap moved below it: hops are not trades of their own.
    const t = raw(SWAPS[0] as TxRecord);
    const at = t.message.instructions.findIndex((ix) => t.message.accountKeys[ix.programIdIndex] === PSWAP);
    const swap = t.message.instructions[at] as RawTransaction['message']['instructions'][number];
    const routeDisc = [...(idls().find((i) => i.name === 'pump_amm')?.routeInstructions ?? [])][0] as string;
    t.message.instructions[at] = { ...swap, dataB64: Buffer.from(routeDisc, 'hex').toString('base64') };
    t.meta.innerInstructions = [{ index: at, instructions: [{ ...swap }] }];
    assert.deepEqual(d.decodeTransactionEvents(t), []);
  });

  it('a swap invoked by a router (synthetic: the recorded swap moved one level down) gets its log event at its inner place', () => {
    const t = raw(SWAPS[0] as TxRecord);
    const keys = t.message.accountKeys;
    const at = t.message.instructions.findIndex((ix) => keys[ix.programIdIndex] === PSWAP);
    const swap = t.message.instructions[at] as RawTransaction['message']['instructions'][number];
    const router = keys.indexOf(DEFAULT_PUBKEY);
    assert.ok(router >= 0);
    t.message.instructions[at] = { programIdIndex: router, accounts: [], dataB64: '' };
    t.meta.innerInstructions = [{ index: at, instructions: [{ ...swap }] }];
    const l = logs(t);
    const open = l.indexOf(`Program ${PSWAP} invoke [1]`);
    let close = open;
    for (let depth = 0; ; close++) {
      if (/ invoke \[\d+\]$/.test(l[close] as string)) depth++;
      else if (/^Program \S+ (success|failed)/.test(l[close] as string) && --depth === 0) break;
    }
    const deeper = l.slice(open, close + 1).map((x) => x.replace(/invoke \[(\d+)\]$/, (_m, h: string) => `invoke [${Number(h) + 1}]`));
    t.meta.logMessages = [...l.slice(0, open), `Program ${DEFAULT_PUBKEY} invoke [1]`, ...deeper, `Program ${DEFAULT_PUBKEY} success`, ...l.slice(close + 1)];
    const r = d.decodeTransactionEventsWithProvenance(t);
    assert.deepEqual(r.sources, ['log']);
    assert.deepEqual([r.events[0]?.outerIx, r.events[0]?.innerIx], [at, 0]);
    assert.deepEqual(r.events.map((e) => e.event), d.decodeTransactionEvents(raw(SWAPS[0] as TxRecord)));
  });

  it('instructions the fallback skips: a program index out of range, PumpSwap data under 8 bytes; a data line under 8 bytes is unknown_event', () => {
    const t = logsOnly(SWAPS[0] as TxRecord);
    t.message.instructions.push({ programIdIndex: 9_999, accounts: [], dataB64: '' });
    t.message.instructions.push({ programIdIndex: t.message.accountKeys.indexOf(PSWAP), accounts: [], dataB64: 'AQID' });
    assert.equal(d.decodeTransactionEvents(t).length, 1);
    const u: string[] = [];
    const k = logsOnly(SWAPS[0] as TxRecord);
    const at = dataLines(k)[0] as number;
    k.meta.logMessages = logs(k).map((x, i) => (i === at ? 'Program data: AQID' : x));
    assert.deepEqual(withGaps(u).decodeTransactionEvents(k).map((e) => [e.kind, (e as { discriminatorHex?: string }).discriminatorHex]), [['unknown_event', '']]);
  });

  it('a pinned event the decoder has no variant for (DepositEvent) gives nothing; trailing bytes mark the event layoutExtended', () => {
    const amm = idls().find((i) => i.name === 'pump_amm');
    const deposit = [...(amm?.events.entries() ?? [])].find(([, def]) => def.name === 'DepositEvent')?.[0] as string;
    const t = logsOnly(SWAPS[0] as TxRecord);
    const at = dataLines(t)[0] as number;
    const line = (b: Buffer) => logs(t).map((x, i) => (i === at ? `Program data: ${b.toString('base64')}` : x));
    t.meta.logMessages = line(Buffer.concat([Buffer.from(deposit, 'hex'), Buffer.alloc(600)]));
    assert.deepEqual(d.decodeTransactionEvents(t), []);
    const e = logsOnly(SWAPS[0] as TxRecord);
    const orig = Buffer.from((logs(e)[at] as string).slice('Program data: '.length), 'base64');
    e.meta.logMessages = logs(e).map((x, i) => (i === at ? `Program data: ${Buffer.concat([orig, Buffer.alloc(8, 7)]).toString('base64')}` : x));
    const r = d.decodeTransactionEventsLocated(e);
    assert.deepEqual(r.map((x) => x.layoutExtended), [true]);
  });

  it('metrics: decode_events_total{kind,source} counts each source', () => {
    const events: Array<[string, string]> = [];
    const dd = withGaps([], events);
    dd.decodeTransactionEvents(raw(SWAPS[0] as TxRecord));
    dd.decodeTransactionEvents(logsOnly(SWAPS[0] as TxRecord));
    const kinds = new Set(events.map(([, s]) => s));
    assert.deepEqual([...kinds].sort(), ['log', 'self_cpi']);
    assert.ok(events.every(([k]) => k === 'pumpswap_buy' || k === 'pumpswap_sell'));
  });
});
