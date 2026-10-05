// FUNNEL-PERSIST: the app's funnel (Seen and the stages), entries per day and the latest decision rows survive a
// restart. They are made from the journal's own lines, live and at a start alike, so a restarted worker shows what one
// that never stopped would.
import { appendFileSync, closeSync, mkdtempSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { melbourneDay } from '../../core/src/risk/melbourne.ts';
import { holdersKey } from '../../core/src/gates/index.ts';
import { melbourneDate, route } from '../src/run/api.ts';
import { DECISION_ROWS_MAX, FunnelView, rebuildFunnel } from '../src/run/funnel.ts';
import { STATE_FILES } from '../../runner/src/contract.ts';
import { blockNetwork } from './helpers.ts';
import { MINT, makeWorker, passingMarket, until } from './worker-harness.ts';

blockNetwork();

type H = ReturnType<typeof makeWorker>;
/** The views the app reads, without the moment they are read at. */
const views = (h: H) => {
  const i = h.worker.apiInputs();
  const funnel = route('/api/v1/paper/funnel', () => i).body as { data: Record<string, unknown> };
  const { to: _to, ...rest } = funnel.data;
  return { funnel: rest, decisions: route('/api/v1/paper/decisions', () => i).body, stage: [...i.funnel.stage], entered: [...i.funnel.enteredByDay] };
};
const viewOf = (v: FunnelView) => ({ stage: [...v.funnel.stage], entered: [...v.funnel.enteredByDay], rows: v.rows });

describe('a restart keeps the app\'s funnel and decisions (FUNNEL-PERSIST)', () => {
  it('rejects, an entry and the rows: a restarted worker shows what the one before it showed, and live equals the journal rebuilt', async () => {
    const a = makeWorker();
    await a.worker.reconcile();
    const m = await passingMarket(a, { heldPoolFacts: true });
    // A stretch of holder rejects (a reject row and a stage), then the good facts again: the coin is entered.
    await m.run(3_000, 400, () => {
      m.slot();
      m.pool();
      m.fact(holdersKey(MINT), { unreadable: true });
    });
    expect(await until(m, 30_000, () => Object.values(a.worker.book.positions).some((p) => p.status === 'open'), () => { m.slot(); m.pool(); })).toBe(true);
    const before = views(a);
    expect(before.entered.length).toBe(1);
    expect(before.stage.length).toBeGreaterThan(0);
    expect((before.decisions as { data: { outcome: string }[] }).data.map((d) => d.outcome)).toEqual(expect.arrayContaining(['rejected', 'entered']));
    // Live is the journal's lines applied as written: rebuilding from the file gives the same view.
    const live = a.worker.apiInputs();
    const rebuilt = rebuildFunnel(join(a.stateDir, STATE_FILES.journal), a.timers.now());
    expect(viewOf(rebuilt)).toEqual({ stage: [...live.funnel.stage], entered: [...live.funnel.enteredByDay], rows: live.decisions });
    await a.worker.stop();

    // The restart, same state folder, later the same day: Seen, the stages, the entries and the rows all stay.
    const b = makeWorker({ stateDir: a.stateDir, timers: a.timers });
    expect(views(b)).toEqual(before);
    // It counts from the start of the Melbourne day, which its funnel says.
    expect(b.worker.apiInputs().funnel.fromMs).toBe(melbourneDay(a.timers.now()).start);
    await b.worker.stop();
  }, 120_000);
});

// ---------- rebuildFunnel on a journal file ----------

const NOW = Date.UTC(2026, 9, 4, 3, 0); // 2026-10-04 14:00 in Melbourne (AEDT)
const TODAY = melbourneDay(NOW);
const line = (seq: number, atMs: number, kind: string, fields: Record<string, unknown>) => JSON.stringify({ seq, ts: new Date(atMs).toISOString(), boot: 'b', kind, ...fields });
const shortlist = (seq: number, atMs: number, mint: string) => line(seq, atMs, 'decision', { action: 'none', event: `m:${mint}`, reasons: ['shortlist', 'U2', mint, 'migrated at 1'] });
const reject = (seq: number, atMs: number, mint: string, why = 'hard reject H12: H16 missing holders') =>
  line(seq, atMs, 'decision', { action: 'reject', event: `e${seq}`, reasons: ['reject', 'U2', mint, why], gate_reasons: [{ gate: 'H16', code: 'missing' }] });
const entry = (seq: number, atMs: number, mint: string, trade: string, tokens: string) => line(seq, atMs, 'entry', { trade, intent: `en:${mint}:1`, mint, tokens, sol: '1', fees: '1', reasons: ['enter'] });
const journalOf = (lines: readonly string[]): string => {
  const p = join(mkdtempSync(join(tmpdir(), 'zeroed-funnel-')), 'journal.jsonl');
  writeFileSync(p, lines.map((l) => `${l}\n`).join(''));
  return p;
};

describe('rebuildFunnel', () => {
  it('reads today only (Melbourne): yesterday\'s lines do not leak in, and the view counts from the start of the day', () => {
    // 23:30 UTC the day before is 10:30 today in Melbourne: today. 12:00 UTC two days back is yesterday in Melbourne.
    const v = rebuildFunnel(journalOf([
      shortlist(1, TODAY.start - 3_600_000, 'OLD'), reject(2, TODAY.start - 60_000, 'OLD'), entry(3, TODAY.start - 1, 'OLD', 'p:OLD:1', '5'),
      shortlist(4, TODAY.start + 1, 'NEW'), reject(5, Date.UTC(2026, 9, 3, 23, 30), 'NEW'),
    ]), NOW);
    expect([...v.funnel.stage.keys()]).toEqual(['NEW']);
    expect([...v.funnel.enteredByDay]).toEqual([]);
    expect(v.rows.map((r) => r.mint)).toEqual(['NEW']);
    expect(v.funnel.fromMs).toBe(TODAY.start);
  });

  it('nothing today: the view counts from the start, as a fresh worker', () => {
    const v = rebuildFunnel(journalOf([shortlist(1, TODAY.start - 10, 'OLD')]), NOW);
    expect(v.funnel.stage.size).toBe(0);
    expect(v.funnel.fromMs).toBe(NOW);
    expect(rebuildFunnel(join(tmpdir(), 'no-such-journal.jsonl'), NOW).funnel.fromMs).toBe(NOW);
  });

  it('a torn last line and an unreadable one are skipped; the lines around them still count', () => {
    const p = journalOf([shortlist(1, TODAY.start + 10, 'A'), '{"seq":2,"ts":"bad', reject(3, TODAY.start + 20, 'A')]);
    appendFileSync(p, '{"seq":4,"ts":"2026-10-04T02:00:00.000Z","boot":"b","kind":"decision","reasons":["reject","U2","B"');
    const v = rebuildFunnel(p, NOW);
    expect([...v.funnel.stage.keys()]).toEqual(['A']);
    expect(v.rows.map((r) => [r.mint, r.outcome, r.check])).toEqual([['A', 'rejected', 'H12']]);
  });

  it('a trade with partial fills is entered once; lines after the start moment are not read', () => {
    const v = rebuildFunnel(journalOf([
      shortlist(1, TODAY.start + 10, 'A'), entry(2, TODAY.start + 20, 'A', 'p:A:1', '5'), entry(3, TODAY.start + 30, 'A', 'p:A:1', '9'),
      entry(4, NOW + 1, 'A', 'p:A:2', '3'),
    ]), NOW);
    expect([...v.funnel.enteredByDay]).toEqual([['2026-10-04', 1]]);
    expect(v.funnel.stage.get('A')?.stage).toBe(4);
    expect(v.rows.filter((r) => r.outcome === 'entered').map((r) => r.tradeId)).toEqual(['p:A:1']);
  });

  it('rebuilds a journal larger than the child heap by reading slices', () => {
    const path = journalOf([]);
    const fd = openSync(path, 'a');
    // 128 MiB of old decisions cannot fit in the 64 MiB child heap. Keep fixture generation bounded too.
    const old = `${line(1, TODAY.start - 1, 'decision', { reasons: ['reject', 'U2', 'OLD', 'x'.repeat(128 * 1024)] })}\n`;
    try {
      for (let k = 0; k < 1024; k++) writeSync(fd, old);
      writeSync(fd, `${reject(2, TODAY.start + 10, 'NEW')}\n`);
    } finally {
      closeSync(fd);
    }
    const module = pathToFileURL(join(import.meta.dirname, '../src/run/funnel.ts')).href;
    const script = `const { rebuildFunnel } = await import(${JSON.stringify(module)});
      const view = rebuildFunnel(process.argv[1], Number(process.argv[2]));
      console.log(JSON.stringify({ mints: [...view.funnel.stage.keys()], rows: view.rows.length }));`;
    const child = spawnSync(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', script, path, String(NOW)], { encoding: 'utf8' });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ mints: ['NEW'], rows: 1 });
  });

  it('uses the same day window and from time live and after a midnight restart', () => {
    const next = TODAY.end + 1_000;
    const lines = [reject(1, TODAY.end - 1_000, 'OLD'), reject(2, next, 'NEW')];
    const live = new FunnelView(TODAY.end - 2_000);
    for (const raw of lines) live.apply(JSON.parse(raw));
    const rebuilt = rebuildFunnel(journalOf(lines), next);
    expect(viewOf(live)).toEqual(viewOf(rebuilt));
    expect(live.funnel.fromMs).toBe(rebuilt.funnel.fromMs);
    expect([...live.funnel.stage.keys()]).toEqual(['NEW']);
  });

  it('a trade first filled yesterday is not a new entry when partially filled today', () => {
    const next = TODAY.end + 1_000;
    const lines = [entry(1, TODAY.end - 1_000, 'OLD', 'p:OLD:1', '5'), entry(2, next, 'OLD', 'p:OLD:1', '9'), entry(3, next + 1, 'NEW', 'p:NEW:1', '5')];
    const live = new FunnelView(TODAY.end - 2_000);
    for (const raw of lines) live.apply(JSON.parse(raw));
    const rebuilt = rebuildFunnel(journalOf(lines), next + 1);
    expect(viewOf(live)).toEqual(viewOf(rebuilt));
    expect([...rebuilt.funnel.enteredByDay]).toEqual([[melbourneDate(next), 1]]);
    expect(rebuilt.rows.map((row) => row.tradeId)).toEqual(['p:NEW:1']);
  });

  it('refuses incomplete views at a fixed capacity without unbounded retained state', () => {
    const view = new FunnelView(NOW);
    for (let k = 0; k <= 200_000; k++) view.apply(JSON.parse(shortlist(k + 1, NOW, `M${k}`)));
    expect(view.available).toBe(false);
    expect(view.funnel.stage.size).toBe(200_000);
    const h = makeWorker();
    const i = { ...h.worker.apiInputs(), funnel: view.funnel, decisions: view.rows, funnelAvailable: view.available };
    for (const endpoint of ['funnel', 'decisions']) expect(route(`/api/v1/paper/${endpoint}`, () => i)).toEqual({ status: 503, body: { error: 'candidate view unavailable' } });
    expect(route('/api/v1/paper/status', () => i).status).toBe(200);
    view.advance(TODAY.end + 1);
    expect(view.available).toBe(true);
    expect(view.funnel.stage.size).toBe(0);

  });

  it('first-entry dedupe has a lifetime bound and refuses uncertain views when full', () => {
    const view = new FunnelView(NOW);
    for (let k = 0; k <= 200_000; k++) view.apply(JSON.parse(entry(k + 1, TODAY.start - 1, `M${k}`, `p:M${k}:1`, '5')));
    expect(view.available).toBe(false);
    view.advance(TODAY.end + 1);
    expect(view.available).toBe(false);
    expect(view.funnel.stage.size).toBe(0);
    expect(view.rows).toEqual([]);
  });

  it('semantic malformed records cannot create shifted reasons or undefined row identities', () => {
    const view = new FunnelView(NOW);
    const good = JSON.parse(reject(1, NOW, 'A'));
    view.apply({ ...good, seq: -1 });
    view.apply({ ...good, event: undefined });
    view.apply({ ...good, reasons: ['reject', 1, 'U2', 'A', 'hard reject H1'] });
    expect(view.rows).toEqual([]);
    expect(view.funnel.stage.size).toBe(0);
  });

  it('keeps the latest rows only', () => {
    const lines = Array.from({ length: DECISION_ROWS_MAX + 20 }, (_, k) => reject(k + 1, TODAY.start + k, `M${k}`));
    const v = rebuildFunnel(journalOf(lines), NOW);
    expect(v.rows.length).toBe(DECISION_ROWS_MAX);
    expect(v.rows[0]!.mint).toBe('M20');
    expect(v.funnel.stage.size).toBe(DECISION_ROWS_MAX + 20);
  });
});
