// RED TEAM C round 2, task 3: every file the worker reads at start, damaged each way a disk or a bad restore can damage
// it (truncated, zero length, valid JSON of the wrong shape, a field NaN/negative/huge, a field missing, the file gone).
// The baseline state holds an open position with its exit plan, the R10 kill switch latched (control.json), a NAV peak,
// day and week marks and today's entry (account.json). For each damage the worker either refuses to start, or starts
// fail-closed: the latch still holds (risk stops say kill_switch, or risk cannot be judged), the position is still in the
// book, and no account counter (NAV peak, day mark, entries today, wallet lamports) moved. Fail = a bug.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseTyped, typedText } from '../../src/run/json.ts';
import { blockNetwork } from '../helpers.ts';
import { Market, makeWorker, passingMarket, until, type Harness } from '../worker-harness.ts';

blockNetwork();

const OUT = '/tmp/claude-0/-home-user-Meme-snipe/78e27a53-4417-5a6e-ba2a-ee922953ab52/scratchpad/r2-corrupt-table.json';
const tick = (m: Market) => (): void => {
  m.slot();
  m.pool();
};
type J = Record<string, any>;
const readJ = (dir: string, f: string): J => parseTyped(readFileSync(join(dir, f), 'utf8')) as J;
const writeJ = (dir: string, f: string, v: unknown) => writeFileSync(join(dir, f), `${typedText(v)}\n`);
const edit = (f: string, fn: (v: J) => void) => (dir: string) => {
  const v = readJ(dir, f);
  fn(v);
  writeJ(dir, f, v);
};
const raw = (f: string, text: string) => (dir: string) => writeFileSync(join(dir, f), text);
const half = (f: string) => (dir: string) => {
  const b = readFileSync(join(dir, f));
  writeFileSync(join(dir, f), b.subarray(0, Math.floor(b.length / 2)));
};
const gone = (f: string) => (dir: string) => rmSync(join(dir, f), { force: true });
const firstKey = (v: J) => Object.keys(v)[0]!;

const FILES_JSON = ['control.json', 'account.json', 'exits.json', 'paper.json', 'entry-seeds.json', 'restarts.json', 'mem-recent.json'];
const generic = FILES_JSON.flatMap((f) => [
  [`${f} truncated`, half(f)],
  [`${f} zero length`, raw(f, '')],
  [`${f} wrong shape (array)`, raw(f, '[1,2,3]\n')],
  [`${f} wrong shape (object)`, raw(f, '{"x":1}\n')],
  [`${f} missing`, gone(f)],
] as const);

const CASES: readonly (readonly [string, (dir: string) => void])[] = [
  ['baseline (no damage)', () => {}],
  ...generic,
  ['control.json killTrippedAtMs negative', edit('control.json', (v) => { v['latches']['killTrippedAtMs'] = -5; })],
  ['control.json killTrippedAtMs huge', edit('control.json', (v) => { v['latches']['killTrippedAtMs'] = 1e300; })],
  ['control.json killTrippedAtMs NaN (as string)', edit('control.json', (v) => { v['latches']['killTrippedAtMs'] = 'NaN'; })],
  ['control.json killTrippedAtMs field missing', edit('control.json', (v) => { delete v['latches']['killTrippedAtMs']; })],
  ['control.json latches empty object', edit('control.json', (v) => { v['latches'] = {}; })],
  ['control.json paused missing', edit('control.json', (v) => { delete v['paused']; })],
  ['account.json walletLamports negative', edit('account.json', (v) => { v['walletLamports'] = -1n; })],
  ['account.json walletLamports huge', edit('account.json', (v) => { v['walletLamports'] = 10n ** 30n; })],
  ['account.json walletLamports as number NaN-like', edit('account.json', (v) => { v['walletLamports'] = 'NaN'; })],
  ['account.json navPeak missing', edit('account.json', (v) => { delete v['navPeak']; })],
  ['account.json navPeak.nav negative', edit('account.json', (v) => { v['navPeak']['nav'] = -5n; })],
  ['account.json navPeak.nav as string', edit('account.json', (v) => { v['navPeak']['nav'] = 'x'; })],
  ['account.json dayMark missing', edit('account.json', (v) => { delete v['dayMark']; })],
  ['account.json weekMark missing', edit('account.json', (v) => { delete v['weekMark']; })],
  ['account.json entries emptied', edit('account.json', (v) => { v['entries'] = []; })],
  ['account.json entries missing', edit('account.json', (v) => { delete v['entries']; })],
  ['account.json openedAtMs negative', edit('account.json', (v) => { v['openedAtMs'] = -1; })],
  ['account.json openingEquity negative', edit('account.json', (v) => { v['openingEquity'] = -20_000_000n; })],
  ['account.json setup missing (one-time rent re-paid?)', edit('account.json', (v) => { delete v['setup']; delete v['oneTimePaid']; })],
  ['account.json trade booked as string', edit('account.json', (v) => { v['trades'][0]['booked'] = 'x'; })],
  ['account.json trades emptied', edit('account.json', (v) => { v['trades'] = []; })],
  ['exits.json stopPrice negative', edit('exits.json', (v) => { v[firstKey(v)]['plan']['stopPrice'] = -1n; })],
  ['exits.json stopPrice zero', edit('exits.json', (v) => { v[firstKey(v)]['plan']['stopPrice'] = 0n; })],
  ['exits.json stopPrice huge', edit('exits.json', (v) => { v[firstKey(v)]['plan']['stopPrice'] = 10n ** 40n; })],
  ['exits.json stopPrice as number', edit('exits.json', (v) => { v[firstKey(v)]['plan']['stopPrice'] = 3.1; })],
  ['exits.json stopPrice missing', edit('exits.json', (v) => { delete v[firstKey(v)]['plan']['stopPrice']; })],
  ['exits.json tracker.peak huge', edit('exits.json', (v) => { v[firstKey(v)]['tracker']['peak'] = 10n ** 40n; })],
  ['exits.json tracker.blockedRetries negative', edit('exits.json', (v) => { v[firstKey(v)]['tracker']['blockedRetries'] = -3; })],
  ['exits.json plan.openedAtMs huge (future)', edit('exits.json', (v) => { v[firstKey(v)]['plan']['openedAtMs'] = 1e15; })],
  ['exits.json entry removed', edit('exits.json', (v) => { delete v[firstKey(v)]; })],
  ['paper.json attempts emptied', edit('paper.json', (v) => { v['attempts'] = {}; })],
  ['paper.json attempt inAmount negative', edit('paper.json', (v) => { const a = v['attempts'][firstKey(v['attempts'])]; a['inAmount'] = -1n; })],
  ['paper.json attempt fate missing', edit('paper.json', (v) => { const a = v['attempts'][firstKey(v['attempts'])]; delete a['fate']; })],
  ['restarts.json at huge', raw('restarts.json', '[{"at":1e300,"kind":"unplanned","git_sha":"testsha"}]\n')],
  ['exposure.json wrong shape', raw('exposure.json', '{"trades":"x"}\n')],
  ['exposure.json fromMs negative', raw('exposure.json', '{"trades":[],"fromMs":-1}\n')],
  ['fetch-caps.json counts negative', raw('fetch-caps.json', '{"day":1,"cutCreate":-1,"cutTrade":-1}\n')],
  ['credits.json used negative', raw('credits.json', '{"month":"2026-10","used":{"helius":-5}}\n')],
  ['journal.jsonl truncated mid-line', half('journal.jsonl')],
  ['journal.jsonl zero length', raw('journal.jsonl', '')],
  ['journal.jsonl garbage', raw('journal.jsonl', 'not json\n')],
  ['journal.jsonl missing', gone('journal.jsonl')],
  ['ledger.sqlite truncated', half('ledger.sqlite')],
  ['ledger.sqlite zero length', raw('ledger.sqlite', '')],
  ['ledger.sqlite garbage', raw('ledger.sqlite', 'x'.repeat(8192))],
  ['ledger.sqlite missing', gone('ledger.sqlite')],
  ['deployers.jsonl truncated', half('deployers.jsonl')],
  ['deployers.jsonl garbage', raw('deployers.jsonl', '{{{\n')],
  ['open_intents garbage', raw('open_intents', 'x')],
];

interface Row { readonly damage: string; readonly outcome: string; readonly ok: boolean }

describe('red team C r2: a damaged saved state never starts with a latch or risk counter reset', () => {
  let h: Harness;
  let base = '';
  let pid = '';
  let acct0: J = {};
  const rows: Row[] = [];
  beforeAll(async () => {
    // Baseline: an open position, then the kill switch latched by a valuation (written as the worker writes it).
    h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    const m = await passingMarket(h, { heldPoolFacts: true });
    expect(await until(m, 30_000, () => Object.values(h.worker.book.positions).some((p) => p.status === 'open'), tick(m))).toBe(true);
    pid = Object.values(h.worker.book.positions).find((p) => p.status === 'open')!.id;
    await h.worker.stop();
    base = h.stateDir;
    rmSync(join(base, 'cold_start'), { force: true });
    const latchAt = h.timers.now() - 1_000;
    writeJ(base, 'control.json', { paused: false, pausedAtMs: null, latches: { killTrippedAtMs: latchAt, killRearmedAtMs: null, weeklyTrippedAtMs: null, weeklyReviewedAtMs: null, lossReviewedAtMs: null, sizeStepUpApproved: false } });
    acct0 = readJ(base, 'account.json');
  }, 120_000);
  afterAll(() => writeFileSync(OUT, JSON.stringify(rows, null, 1)));

  for (const [damage, apply] of CASES) it(`${damage}: refused, or started fail-closed with the latch, the position and the account counters kept`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'r2-corrupt-'));
      cpSync(base, dir, { recursive: true });
      let outcome = '';
      let ok = false;
      let h2: Harness | null = null;
      try {
        apply(dir);
        try {
          h2 = makeWorker({ stateDir: dir, timers: h.timers });
          const r = await h2.worker.start();
          if (!('ok' in r) || r.ok !== true) { outcome = `refused: ${JSON.stringify(r).slice(0, 120)}`; ok = true; }
        } catch (e) {
          outcome = `refused (throws): ${(e instanceof Error ? e.message : String(e)).replace(dir, '<dir>').slice(0, 120)}`;
          ok = true;
        }
        if (outcome === '' && h2 !== null) {
          const m2 = new Market(h2, { heldPoolFacts: true });
          await m2.run(6_000, 400, tick(m2));
          const problems: string[] = [];
          const stops = h2.worker.apiInputs().stops;
          const codes = stops?.codes ?? null;
          if (codes !== null && !codes.includes('kill_switch')) problems.push(`kill latch lost (risk stops: ${codes.join(',') || 'none'})`);
          const p = h2.worker.book.positions[pid];
          if (p === undefined) problems.push('position lost');
          else if (p.status === 'open' && h2.worker.apiInputs().open(p as never) === null) problems.push('open with no exit plan');
          const a = existsSync(join(dir, 'account.json')) ? readJ(dir, 'account.json') : {};
          const s = (x: unknown) => (x === undefined ? 'absent' : typedText(x));
          for (const k of ['navPeak', 'dayMark', 'weekMark', 'walletLamports', 'openingEquity', 'setup']) {
            if (s(a[k]) !== s(acct0[k])) problems.push(`account ${k} ${s(acct0[k]).slice(0, 60)} -> ${s(a[k]).slice(0, 60)}`);
          }
          if ((a['entries']?.length ?? 0) !== acct0['entries'].length) problems.push(`account entries today ${acct0['entries'].length} -> ${a['entries']?.length ?? 'absent'}`);
          if ((a['trades']?.length ?? 0) !== acct0['trades'].length) problems.push(`account trades ${acct0['trades'].length} -> ${a['trades']?.length ?? 'absent'}`);
          ok = problems.length === 0;
          outcome = ok ? `started fail-closed (risk ${codes === null ? 'unknown' : codes.join(',')}; position ${p?.status})` : `STARTED: ${problems.join('; ')}`;
        }
      } finally {
        try { await h2?.worker.stop(); } catch {}
        rmSync(dir, { recursive: true, force: true });
      }
      rows.push({ damage, outcome, ok });
      expect(ok, outcome).toBe(true);
  });
});
