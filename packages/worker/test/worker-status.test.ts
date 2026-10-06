import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// API-1: what /api/v1/paper/status adds for the app's worker card: why entries are off (haltReasons), exit readiness,
// the critical alerts since boot and the latest regime evaluation, all from state the worker already holds, read only.
import { describe, expect, it } from 'vitest';
import { checkEnvelope } from '../../../apps/web/src/api/modes.ts';
import { schemaFor } from '../../../apps/web/src/api/schemas.ts';
import { PATHS } from '../../../apps/web/src/api/contract.ts';
import type { LogRecord } from '../../core/src/engine/index.ts';
import { SEEDING } from '../src/engine/strategy.ts';
import { DISK_LOW } from '../src/run/disk.ts';
import { type AlertSeen, collectAlerts, haltOf, MAX_ALERTS, route, stopHalts, views } from '../src/run/api.ts';
import { makeWorker, passingMarket } from './worker-harness.ts';

type Status = { haltReasons: { mode: string; code: string; source: string | null }[]; exitCapable: boolean; alerts: { mode: string; code: string; subject: string; at: string }[]; regime: { state: string; at: string; reasons: { mode: string; code: string; input: string | null }[] } | null };
const strict = (body: unknown) => checkEnvelope(JSON.parse(JSON.stringify(body)), 'paper', schemaFor('status', 'paper')) as { data: Status };

describe('haltOf', () => {
  it.each([
    ['starting', 'starting', null],
    ['feed helius stale', 'feed-stale', 'helius'],
    ['feed pumpportal disconnected', 'feed-disconnected', 'pumpportal'],
    ['feed helius dropped by drill', 'feed-dropped', 'helius'],
    ['owner pause (watchdog)', 'paused', null],
    [SEEDING, 'seeding', null],
    [DISK_LOW, 'other', null],
    ['ledger and book diverged', 'divergence', null],
    ['something new', 'other', null],
    ['feed helius stale and more', 'other', null],
  ])('%s is %s', (text, code, source) => {
    expect(haltOf(text)).toEqual({ code, source });
  });
});

describe('verified baseline app compatibility', () => {
  it('accepts actual low-disk and journal-ENOSPC status with the unchanged baseline strict checker', () => {
    const temp=mkdtempSync(join(tmpdir(),'ops149-app-baseline-'));
    try {
      for(const folder of ['api','lib']) mkdirSync(join(temp,folder));
      for(const file of ['api/contract','api/modes','api/schema','api/schemas','lib/money']) {
        writeFileSync(join(temp,file+'.ts'),readFileSync(new URL(`./fixtures/app-8c375/${file}.ts.txt`,import.meta.url)));
      }
      const script=`import { appendFileSync } from 'node:fs'; import { checkAnswer } from ${JSON.stringify(join(temp,'api/modes.ts'))}; import { schemaFor } from ${JSON.stringify(join(temp,'api/schemas.ts'))};
        import { makeWorker } from './packages/worker/test/worker-harness.ts'; import { route } from './packages/worker/src/run/api.ts';
        const results=[];
        for(const kind of ['low','enospc']) {
          let fail=false;
          const h=makeWorker(kind==='low'?{disk:atMs=>({atMs,freeBytes:100,totalBytes:1000,recorderBytes:25})}:{append:(p,t)=>{if(fail)throw Object.assign(new Error('disk full'),{code:'ENOSPC'});appendFileSync(p,t);}});
          try {await h.worker.reconcile();fail=true;await h.worker.step();await h.worker.step();
            const dto=JSON.parse(JSON.stringify(route('/api/v1/paper/status',()=>h.worker.apiInputs()).body));
            checkAnswer(dto,'paper',schemaFor('status','paper'));
            results.push({kind,code:dto.data.haltReasons[0].code,localDiskReason:h.worker.health().halt_reasons.some(r=>r.includes('disk'))});
          } finally {await h.worker.stop();}
        }
        console.log(JSON.stringify(results));`;
      const result=spawnSync(process.execPath,['--no-warnings','--input-type=module','-e',script],{cwd:fileURLToPath(new URL('../../../',import.meta.url)),encoding:'utf8'});
      expect(result.status,result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([{kind:'low',code:'other',localDiskReason:true},{kind:'enospc',code:'other',localDiskReason:true}]);
    } finally {rmSync(temp,{recursive:true,force:true});}
  });
});

describe('collectAlerts', () => {
  const at = (ms: number) => ({ slot: 1n, txIndex: 0, eventIndex: 0, receivedAt: ms }) as never;
  const rec = (type: 'decision' | 'world' | 'fault', ms: number, effects: { type: string; level?: string; code?: string; subject?: string }[]): LogRecord =>
    ({ type, seq: 1, at: at(ms), eventId: 'e', inputs: [], action: null, reasons: [], result: 'applied', effects: effects.map((effect) => ({ effect, dispatch: 'runner' })) }) as unknown as LogRecord;

  it('keeps critical alerts once per code and subject, from decisions and world records, and drops warnings', () => {
    const a: AlertSeen[] = [];
    collectAlerts(a, rec('decision', 1, [{ type: 'alert', level: 'critical', code: 'exit_blocked', subject: 'p1' }, { type: 'persist' }]));
    collectAlerts(a, rec('world', 2, [{ type: 'alert', level: 'warn', code: 'restart_recovery', subject: 'book' }, { type: 'alert', level: 'critical', code: 'exit_blocked', subject: 'p1' }]));
    collectAlerts(a, rec('world', 3, [{ type: 'alert', level: 'critical', code: 'double_fill', subject: 'i1' }, { type: 'alert', level: 'critical', code: 'exit_blocked', subject: 'p2' }]));
    collectAlerts(a, { type: 'fault', seq: 2, at: at(4), eventId: 'f', fault: 'out_of_order' } as unknown as LogRecord);
    expect(a).toEqual([{ code: 'exit_blocked', subject: 'p1', atMs: 1 }, { code: 'double_fill', subject: 'i1', atMs: 3 }, { code: 'exit_blocked', subject: 'p2', atMs: 3 }]);
  });

  it(`keeps the newest ${MAX_ALERTS}`, () => {
    const a: AlertSeen[] = [];
    for (let k = 0; k < MAX_ALERTS + 7; k++) collectAlerts(a, rec('world', k, [{ type: 'alert', level: 'critical', code: 'oversold', subject: `p${k}` }]));
    expect(a).toHaveLength(MAX_ALERTS);
    expect(a[0]!.subject).toBe('p7');
    expect(a.at(-1)!.subject).toBe(`p${MAX_ALERTS + 6}`);
  });
});

describe('/api/v1/paper/status (API-1)', () => {
  it('serves the halt reasons, exit readiness and no regime before any candidate; the app\'s strict schema accepts it', async () => {
    const h = makeWorker();
    const get = () => strict(route(PATHS.status('paper'), () => h.worker.apiInputs()).body).data;
    const before = get();
    // Before any event the account stops are not known: never none.
    expect(before.haltReasons).toEqual([{ mode: 'paper', code: 'starting', source: null }, { mode: 'paper', code: 'risk-unknown', source: null }]);
    expect(before.exitCapable).toBe(false);
    expect(before.regime).toBeNull();
    expect(before.alerts).toEqual([]);
    await h.worker.reconcile();
    expect(get().exitCapable).toBe(h.worker.health().exit_capable);
    await h.worker.stop();
  });

  it('shows the regime the latest candidate was judged under, and only the account stops once entries run', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h);
    await m.run(4_000, 100, () => m.pool());
    const s = strict(route(PATHS.status('paper'), () => h.worker.apiInputs()).body).data;
    expect(s.regime).toMatchObject({ state: 'on', reasons: [] });
    expect(Date.parse(s.regime!.at)).toBeLessThanOrEqual(h.timers.now());
    const i = h.worker.apiInputs();
    expect(s.haltReasons).toEqual([...h.worker.health().halt_reasons.map(haltOf), ...stopHalts(i.stops, i.nowMs)].map((r) => ({ mode: 'paper', ...r })));
    expect(i.stops?.codes).not.toBeNull();
    expect(s.exitCapable).toBe(h.worker.health().exit_capable);
    await h.worker.stop();
  });

  it('names a provider whose request budget is spent', async () => {
    const quota = (provider: string, halted: boolean) => ({ provider, credits_used: 0, credits_by_class: [0, 0, 0, 0] as const, monthly_credits: null, granted: [0, 0, 0, 0] as const, shed: [0, 0, 0, 0] as const, halted });
    const h = makeWorker({ ops: () => ({ quota: [quota('helius', true), quota('alchemy', false)], lookups: { counts: [] } }) });
    await h.worker.reconcile();
    const s = strict(route(PATHS.status('paper'), () => h.worker.apiInputs()).body).data;
    expect(s.haltReasons).toContainEqual({ mode: 'paper', code: 'budget', source: 'helius' });
    expect(s.haltReasons.filter((r) => r.code === 'budget')).toHaveLength(1);
    await h.worker.stop();
  });

  it('maps a regime off with its reasons, and the alerts, as the app reads them', async () => {
    const h = makeWorker();
    const i = h.worker.apiInputs();
    const s = strict({ mode: 'paper', asOf: new Date(0).toISOString(), data: views.status({
      ...i,
      alerts: [{ code: 'exit_blocked', subject: 'p1', atMs: 5_000 }],
      regime: { atMs: 6_000, on: false, reasons: [{ code: 'unknown', input: 'curve-volume' }, { code: 'regime-off', input: null }], waived: [] },
    }) }).data;
    expect(s.alerts).toEqual([{ mode: 'paper', code: 'exit_blocked', subject: 'p1', at: new Date(5_000).toISOString() }]);
    expect(s.regime).toEqual({ state: 'off', at: new Date(6_000).toISOString(), current: i.nowMs - 6_000 <= i.regimeMaxAgeMs, reasons: [{ mode: 'paper', code: 'unknown', input: 'curve-volume' }, { mode: 'paper', code: 'regime-off', input: null }], waived: [] });
    await h.worker.stop();
  });
});
