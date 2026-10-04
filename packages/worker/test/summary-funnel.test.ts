// SUMMARY-FUNNEL step 1 (LIVE-VERIFY): each reject line says where the evaluation refused (`stage`), and each typed
// reason names the fact it is about (`input`) and, for an evidence reason, the gate that needed it (`needed_by`). The
// daily summary can then tell a structural refusal (H16 on create for H9, on trades for H11, ...) from a genuine one.
// Old journal lines (no `stage`, reasons without `input`) still read as before.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { usd } from '../../core/src/config/amounts.ts';
import { createKey, poolKey } from '../../core/src/gates/index.ts';
import type { LogRecord } from '../../core/src/engine/index.ts';
import { rejections } from '../../runner/src/quota.ts';
import { GATE_REASONS_PREFIX, REJECT_STAGES, SOL_PRICE_KEY, STAGE_PREFIX, WORKER_REJECT_STAGES, rejectStage } from '../src/engine/strategy.ts';
import { markedHistory } from '../src/engine/marks.ts';
import { accountFile } from '../src/run/account.ts';
import { journalFields } from '../src/run/desk.ts';
import { emptySummaryState, foldLine } from '../src/run/summary.ts';
import { blockNetwork } from './helpers.ts';
import { MINT, T, makeWorker, passingMarket, tempState } from './worker-harness.ts';

blockNetwork();

type Line = { kind: string; reasons?: string[]; stage?: string; gate_reasons?: Record<string, unknown>[] };
const rejectsOf = (stateDir: string): Line[] =>
  readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Line).filter((l) => l.kind === 'decision' && l.reasons?.[0] === 'reject');

/** A worker over `stateDir` and the passing market minus `omit`, run for a while; its reject lines. */
const run = async (omit: readonly string[], stateDir = tempState()): Promise<Line[]> => {
  const h = makeWorker({ stateDir });
  expect(await h.worker.reconcile()).toEqual({ ok: true });
  const m = await passingMarket(h, { heldPoolFacts: true, omit });
  await m.run(8_000, 400, () => {
    m.slot();
    m.pool();
  });
  await h.worker.stop();
  return rejectsOf(stateDir);
};

describe('the stage that refused, and the fact each reason is about', () => {
  it('the regime refuses first (before the market is set up): stage regime, each reason naming the fact it lacked', async () => {
    const rejects = await run([]);
    const regime = rejects.find((l) => l.stage === 'regime');
    expect(regime, JSON.stringify(rejects.map((l) => [l.stage, l.reasons?.[3]]))).toBeDefined();
    expect(regime!.gate_reasons).toEqual(expect.arrayContaining([expect.objectContaining({ gate: 'regime', input: 'graduates' })]));
    // A regime reason is not an evidence reason: no gate needed it.
    expect(regime!.gate_reasons!.every((g) => !('needed_by' in g))).toBe(true);
  });

  it('a create never seen: stage hard-1, H16 missing on input create, needed by H9', async () => {
    const rejects = await run([createKey(MINT)]);
    const hard = rejects.find((l) => l.stage === 'hard-1');
    expect(hard, JSON.stringify(rejects.map((l) => [l.stage, l.reasons?.[3]]))).toBeDefined();
    expect(hard!.gate_reasons).toEqual(expect.arrayContaining([{ gate: 'H16', code: 'missing', input: 'create', needed_by: 'H9', detail: expect.any(String) }]));
  });

  it('no market for the mint (no pool fact): stage inputs, before any hard gate', async () => {
    const rejects = await run([poolKey(MINT)]);
    const inputs = rejects.find((l) => l.stage === 'inputs');
    expect(inputs, JSON.stringify(rejects.map((l) => [l.stage, l.reasons?.[3]]))).toBeDefined();
    expect(inputs!.gate_reasons).toEqual([expect.objectContaining({ gate: 'worker', code: 'no-market' })]);
    expect(rejects.some((l) => l.stage?.startsWith('hard-'))).toBe(false);
  });

  it('too few price bars for the stop\'s ATR, after every hard gate passed: stage sizing', async () => {
    const stateDir = tempState();
    const h = makeWorker({ stateDir });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, { heldPoolFacts: true, bars: 1 });
    // Facts kept fresh, inside one minute: no new bar completes.
    await m.run(8_000, 400, () => {
      m.slot();
      m.pool();
    });
    await h.worker.stop();
    const rejects = rejectsOf(stateDir);
    const sizing = rejects.find((l) => l.stage === 'sizing');
    expect(sizing, JSON.stringify(rejects.map((l) => [l.stage, l.reasons?.[3]]))).toBeDefined();
    expect(sizing!.gate_reasons).toEqual([expect.objectContaining({ gate: 'stop', code: 'no-atr' })]);
  });

  it('risk refuses after every hard gate passed: stage risk', async () => {
    // A $5 loss booked this week: risk refuses at the weekly limit (ENTRY-TRIPS' weekly case).
    const stateDir = tempState();
    const closedAt = T - 2 * 3_600_000;
    accountFile(stateDir).write({ openedAtMs: T - 30 * 86_400_000, openingEquity: usd('20'), walletLamports: null, trades: [{ positionId: 'p:old:1', mint: 'OldMint1111111111111111111111111111111111111', openedAtMs: closedAt - 600_000, notional: usd('5'), closedAtMs: closedAt, netLamports: -33_000_000n, netPnl: -usd('5'), stoppedOut: true, booked: -33_000_000n }], entries: [] } as never);
    const rejects = await run([], stateDir);
    const risk = rejects.find((l) => l.stage === 'risk');
    expect(risk, JSON.stringify(rejects.map((l) => [l.stage, l.reasons?.[3]]))).toBeDefined();
    expect(risk!.gate_reasons!.some((g) => /^R\d+$/.test(String(g['gate'])))).toBe(true);
  });

  it('every reject line has a known stage and no `stage` reason left in its reasons; the runner\'s counts are unchanged', async () => {
    const rejects = await run([createKey(MINT)]);
    expect(rejects.length).toBeGreaterThan(0);
    for (const l of rejects) {
      expect(REJECT_STAGES).toContain(l.stage);
      expect(l.reasons!.some((x) => x.startsWith(STAGE_PREFIX))).toBe(false);
    }
    // The runner counts by gate and code, as before.
    expect(Object.keys(rejections(rejects as never).by_reason)).toEqual(expect.arrayContaining(['H16:missing']));
  });
});

describe('every refusal site\'s stage comes from its own reason (review of af16fed)', () => {
  it('the table: each worker code, the regime, the stop and the risk controls name their stage; a hard gate names none', () => {
    expect(Object.fromEntries(Object.keys(WORKER_REJECT_STAGES).map((code) => [code, rejectStage({ gate: 'worker', code })]))).toEqual({
      'no-sol-price': 'inputs', 'no-market': 'inputs', 'hard-incomplete': 'hard-incomplete',
      'no-account': 'sizing', 'no-round-trip': 'sizing', 'risk-mark-failed': 'risk', 'size-mismatch': 'risk',
    });
    expect(rejectStage({ gate: 'regime', code: 'unknown' })).toBe('regime');
    expect(rejectStage({ gate: 'stop', code: 'no-atr' })).toBe('sizing');
    expect(rejectStage({ gate: 'stop', code: 'too-tight' })).toBe('sizing');
    expect(rejectStage({ gate: 'R1', code: 'risk_fault' })).toBe('risk');
    expect(rejectStage({ gate: 'R14', code: 'x' })).toBe('risk');
    // The hard gates give their stage group themselves; an unknown worker code names none (journaled as `inputs`).
    expect(rejectStage({ gate: 'H9', code: 'too-young' })).toBeNull();
    expect(rejectStage({ gate: 'H16', code: 'missing' })).toBeNull();
    expect(rejectStage({ gate: 'worker', code: 'not-a-code' })).toBeNull();
  });

  const runWith = async (o: { omit?: readonly string[]; markedHistory?: typeof markedHistory }) => {
    const stateDir = tempState();
    const h = makeWorker({ stateDir, ...(o.markedHistory === undefined ? {} : { markedHistory: o.markedHistory }) });
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, { heldPoolFacts: true, omit: o.omit ?? [] });
    await m.run(8_000, 400, () => {
      m.slot();
      m.pool();
    });
    await h.worker.stop();
    return rejectsOf(stateDir);
  };
  const only = (rejects: Line[], code: string) => rejects.find((l) => l.gate_reasons?.[0]?.['code'] === code);

  it('no live SOL price: stage inputs', async () => {
    const r = only(await runWith({ omit: [SOL_PRICE_KEY] }), 'no-sol-price');
    expect(r?.stage).toBe('inputs');
  });

  it('marking the account fails: stage risk', async () => {
    const r = only(await runWith({ markedHistory: () => { throw new Error('mark broke'); } }), 'risk-mark-failed');
    expect(r?.stage).toBe('risk');
  });

  it('risk cannot evaluate the account (a fault): stage risk', async () => {
    const r = only(await runWith({ markedHistory: (h0, held, sol, now, st) => ({ ...markedHistory(h0, held, sol, now, st), openingEquity: 'broken' as never }) }), 'risk_fault');
    expect(r?.stage).toBe('risk');
  });
});

describe('old lines read as before', () => {
  const record = (reasons: string[], action: null | { type: 'propose_entry'; intent: { id: string } } = null): LogRecord =>
    ({ type: 'decision', seq: 1, eventId: 'e1', at: { slot: 1n, txIndex: 0, ixIndex: 0, receivedAt: 0 }, action, reasons, result: 'applied' } as unknown as LogRecord);
  const typed = `${GATE_REASONS_PREFIX}${JSON.stringify([{ gate: 'H9', code: 'too-young', detail: 'x' }])}`;

  it('a reject without a stage reason (an older engine) gets no stage field; with one, the field and no reason', () => {
    const old = journalFields(record(['reject', 'U2', MINT, 'hard reject H9', typed]))!;
    expect('stage' in old).toBe(false);
    expect(old['reasons']).toEqual(['reject', 'U2', MINT, 'hard reject H9']);
    const now = journalFields(record(['reject', 'U2', MINT, 'hard reject H9', typed, `${STAGE_PREFIX}hard-1`]))!;
    expect(now['stage']).toBe('hard-1');
    expect(now['reasons']).toEqual(['reject', 'U2', MINT, 'hard reject H9']);
    // Only a reject carries a stage.
    expect('stage' in journalFields(record(['shortlist', 'U2', MINT, 'migrated at 1']))!).toBe(false);
  });

  it('the v1 daily summary folds a new reason (with input and needed_by) to the same gate and code as an old one', () => {
    const fold = (gate_reasons: unknown[]) => {
      const s = emptySummaryState();
      foldLine(s, { ts: '2026-10-05T01:00:00.000Z', kind: 'decision', reasons: ['reject', 'U2', MINT, 'x'], gate_reasons, stage: 'hard-1' });
      return Object.values(s.days)[0]!.cands[MINT];
    };
    const old = fold([{ gate: 'H16', code: 'missing', detail: 'no create' }]);
    const next = fold([{ gate: 'H16', code: 'missing', detail: 'no create', input: 'create', needed_by: 'H9' }]);
    expect(next).toEqual(old);
    expect(next).toEqual({ gate: 'H16', code: 'missing', entered: false });
  });
});
