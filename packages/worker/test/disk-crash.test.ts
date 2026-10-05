// DISK-CRASH: the same disk refuses the recorder, its alert, then the halt journal line.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXIT } from '../../runner/src/contract.ts';
import { checkJournal } from '../../runner/src/journal.ts';
import { Journal } from '../src/run/journal.ts';
import { Recorder } from '../src/run/recorder.ts';
import { Market, makeWorker, passingMarket } from './worker-harness.ts';

const disk = vi.hoisted(() => ({ dir: '', full: false, attempts: [] as string[], action: '', kind: '', reserveNoSpace: false, syncNoSpace: false }));
vi.mock('node:fs', async (load) => {
  const fs = await load<typeof import('node:fs')>();
  const paths = new Map<number, string>();
  return { ...fs, openSync: ((path: string, ...args: unknown[]) => {
    const fd = (fs.openSync as (...a: unknown[]) => number)(path, ...args);
    paths.set(fd, path); return fd;
  }) as typeof fs.openSync, writeSync: ((fd: number, ...args: unknown[]) => {
    if (disk.reserveNoSpace && paths.get(fd)?.endsWith('.reserve')) throw Object.assign(new Error('no reserve space'), { code: 'ENOSPC' });
    return (fs.writeSync as (...a: unknown[]) => number)(fd, ...args);
  }) as typeof fs.writeSync, fsyncSync: (fd: number) => {
    if (disk.syncNoSpace && paths.get(fd)?.endsWith('journal.jsonl')) throw Object.assign(new Error('no sync space'), { code: 'ENOSPC' });
    fs.fsyncSync(fd);
  }, appendFileSync: ((path: string, ...args: unknown[]) => {
    if (path === join(disk.dir, 'journal.jsonl')) {
      const row = JSON.parse(String(args[0]));
      if ((disk.action !== '' && (row.action === disk.action || row.code === disk.action)) || (disk.kind !== '' && row.kind === disk.kind)) disk.full = true;
    }
    if (disk.full && path === join(disk.dir, 'journal.jsonl')) {
      disk.attempts.push(String(args[0]));
      throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
    }
    return (fs.appendFileSync as (...a: unknown[]) => void)(path, ...args);
  }) as typeof fs.appendFileSync };
});
const noSpace = () => Object.assign(new Error('no space'), { code: 'ENOSPC' });
const read = (path: string) => readFileSync(path, 'utf8').trim().split('\n').map((x) => JSON.parse(x) as Record<string, unknown>);
afterEach(() => { vi.restoreAllMocks(); disk.full = false; disk.dir = ''; disk.attempts = []; disk.action = ''; disk.kind = ''; disk.reserveNoSpace = false; disk.syncNoSpace = false; });

describe('DISK-CRASH', () => {
  it('recorder ENOSPC, lost alert, next halt: stays up, stops entries, lands and settles an exit', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, { heldPoolFacts: true });
    await m.run(4_000, 100, () => m.pool());
    await m.run(10_000, 400, () => { m.slot(); m.pool(); });
    const open = Object.values(h.worker.book.positions).find((p) => p.status === 'open')!;
    expect(open).toBeDefined();
    const entries = Object.values(h.worker.book.positions).length;
    const recorder = vi.spyOn(Recorder.prototype, 'flush').mockImplementation(() => { throw noSpace(); });
    const writes = vi.spyOn(h.worker.journal, 'write');
    disk.dir = h.stateDir;
    disk.full = true;
    await m.run(800, 400, () => m.slot());
    expect(disk.attempts.map((l) => JSON.parse(l).kind)[0]).toBe('alert');
    expect(writes.mock.calls.some(([kind]) => kind === 'halt')).toBe(true);
    expect(recorder).toHaveBeenCalledTimes(1);
    expect(h.logs.some((l) => l.includes('Recording stopped; entries halt, exits go on'))).toBe(true);
    expect(h.worker.health()).toMatchObject({ recorder: 'off', entries_halted: true });
    await m.run(6_000, 400, () => { m.slot(); m.pool(700_000n); });
    expect(h.worker.book.positions[open.id]!.status).toBe('closed');
    expect(Object.values(h.worker.book.positions)).toHaveLength(entries);
    expect(h.worker.book.reserved).toBe(0n);
    expect(h.worker.health().reconciled).toBe(true);
    disk.full = false;
    await m.run(800, 400, () => m.slot());
    expect(h.worker.health().entries_halted).toBe(true);
    expect(await h.worker.stop()).toBe(EXIT.clean);
    const rows = read(join(h.stateDir, 'journal.jsonl'));
    expect(rows.some((r) => r['kind'] === 'coverage_gap' && r['stream'] === 'journal')).toBe(true);
    expect(checkJournal(readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8')).complete).toBe(false);
    recorder.mockRestore();
    const h2 = makeWorker({ stateDir: h.stateDir, timers: h.timers });
    expect(await h2.worker.reconcile()).toEqual({ ok: true });
    expect(h2.worker.book.positions[open.id]!.status).toBe('closed');
    expect(h2.worker.health().recorder).toBe('on');
    await h2.worker.stop();
  });

  it.each(['approve_risk', 'prepare', 'sign'])('ENOSPC first discovered at %s never dispatches a new buy and releases reservations', async (action) => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, { heldPoolFacts: true });
    disk.dir = h.stateDir;
    disk.action = action;
    await m.run(4_000, 100, () => m.pool());
    await m.run(16_000, 400, () => { m.slot(); m.pool(); });
    expect(disk.full).toBe(true);
    expect(h.worker.health().halt_reasons).toContain('journal failed (ENOSPC): evidence lost, entries off until a restart');
    expect(h.legs).toEqual([]);
    expect(Object.values(h.worker.book.positions).filter((p) => p.status !== 'closed')).toEqual([]);
    expect(h.worker.book.reserved).toBe(0n);
    expect(Object.values(h.worker.book.intents).every((i) => ['rejected', 'cancelled', 'abandoned', 'settled'].includes(i.status))).toBe(true);
    disk.full = false; disk.action = '';
    await h.worker.stop();
  });

  it.each(['simulation'])('ENOSPC discovered after dispatch (%s) still settles the already sent entry, then exits', async (point) => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, { heldPoolFacts: true });
    disk.dir = h.stateDir;
    if (point === 'simulation') disk.kind = point; else disk.action = point;
    await m.run(4_000, 100, () => m.pool());
    await m.run(10_000, 400, () => { m.slot(); m.pool(); });
    expect(disk.full).toBe(true);
    const open = Object.values(h.worker.book.positions).find((p) => p.status === 'open')!;
    expect(open).toBeDefined();
    expect(h.legs.filter((l) => l.leg === 'entry')).toHaveLength(1);
    await m.run(6_000, 400, () => { m.slot(); m.pool(700_000n); });
    expect(h.worker.book.positions[open.id]!.status).toBe('closed');
    expect(h.worker.book.reserved).toBe(0n);
    expect(h.worker.health().entries_halted).toBe(true);
    disk.full = false; disk.action = ''; disk.kind = '';
    await h.worker.stop();
  });

  it('entry decision fsync ENOSPC refuses dispatch and releases the unsent reservation', async () => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h, { heldPoolFacts: true });
    disk.syncNoSpace = true;
    await m.run(4_000, 100, () => m.pool());
    await m.run(16_000, 400, () => { m.slot(); m.pool(); });
    expect(h.legs).toEqual([]);
    expect(h.worker.book.reserved).toBe(0n);
    expect(h.worker.health()).toMatchObject({ recorder: 'off', entries_halted: true });
    disk.syncNoSpace = false;
    await h.worker.stop();
    expect(checkJournal(readFileSync(join(h.stateDir, 'journal.jsonl'), 'utf8')).complete).toBe(false);
  });

  it('a real SIGKILL preserves the released reserve and unknown gap across the next process', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'disk-journal-')), 'journal.jsonl');
    const script = `import { Journal } from ${JSON.stringify(join(import.meta.dirname, '../src/run/journal.ts'))};
const path = ${JSON.stringify(path)};
const j = new Journal(path, 'a', () => 1000, { append: (p, t) => { if (t.includes('"kind":"halt"')) throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); fs.appendFileSync(p, t); } });
import * as fs from 'node:fs';
j.write('start'); j.write('halt', { reasons: ['full disk'] }); process.kill(process.pid, 'SIGKILL');`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.signal, child.stderr).toBe('SIGKILL');
    expect(statSync(`${path}.reserve`).size).toBe(0);
    new Journal(path, 'b', () => 2_000).write('start');
    expect(read(path).filter((r) => r['boot'] === 'b').map((r) => r['kind'])).toEqual(['start', 'coverage_gap']);
    expect(checkJournal(readFileSync(path, 'utf8')).complete).toBe(false);
  });

  it('partial ENOSPC appends roll back, gaps are bounded counters and attempted seqs are never reused', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'disk-journal-')), 'journal.jsonl');
    let full = false;
    let calls = 0;
    let faults = 0;
    const journal = new Journal(path, 'a', () => 1_000, { onNoSpace: () => faults++, append: (p, text) => {
      calls++;
      if (full) { appendFileSync(p, text.slice(0, 21)); throw noSpace(); }
      appendFileSync(p, text);
    } });
    journal.write('start');
    const bytes = statSync(path).size;
    full = true;
    for (let i = 0; i < 10_000; i++) journal.write('halt', { reasons: ['no disk'], payload: 'x'.repeat(1_000) });
    expect(statSync(path).size).toBe(bytes);
    expect(journal.seq).toBe(10_001);
    expect(faults).toBe(1);
    full = false;
    journal.write('resume', { reasons: ['disk recovered'] });
    const rows = read(path);
    expect(rows.map((r) => r['seq'])).toEqual([1, 10_002, 10_003]);
    expect(rows[1]).toMatchObject({ kind: 'coverage_gap', stream: 'journal', lost: 10_000, from_seq: 2, to_seq: 10_001 });
    expect(journal.failing).toBe(false);
    expect(calls).toBeLessThan(10_005);
    expect(checkJournal(readFileSync(path, 'utf8')).complete).toBe(false);
  });

  it('a restart after unrecoverable loss marks unknown tail evidence instead of inventing a loss count', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'disk-journal-')), 'journal.jsonl');
    const first = new Journal(path, 'a', () => 1_000);
    first.write('start');
    const lost = new Journal(path, 'a', () => 2_000, { append: () => { throw noSpace(); } });
    lost.write('halt', { reasons: ['no disk'] });
    expect(statSync(`${path}.reserve`).size).toBe(0);
    const second = new Journal(path, 'b', () => 3_000);
    second.write('start');
    const rows = read(path);
    expect(rows.filter((r) => r['boot'] === 'b')[0]?.['kind']).toBe('start');
    expect(statSync(`${path}.reserve`).size).toBe(64 * 1024);
    expect(rows.find((r) => r['stream'] === 'journal')).toMatchObject({ kind: 'coverage_gap', lost: null, from_ts: new Date(1_000).toISOString() });
    expect(checkJournal(readFileSync(path, 'utf8')).complete).toBe(false);
  });

  it('other journal errors still throw; complete JSON without a newline is a torn append', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'disk-journal-')), 'journal.jsonl');
    const e = Object.assign(new Error('I/O failure'), { code: 'EIO' });
    const bad = new Journal(path, 'a', () => 1_000, { append: () => { throw e; } });
    expect(() => bad.write('start')).toThrow(e);
    writeFileSync(path, '{"seq":1,"ts":"2026-10-05T00:00:00.000Z","boot":"a","kind":"stop"}');
    const repaired = new Journal(path, 'b', () => 2_000);
    expect(repaired.repaired).toBe(true);
    repaired.write('start');
    expect(read(path)[0]).toMatchObject({ seq: 1, kind: 'start' });
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
  });

  it('a lost start recovers with start first, and gap fsync failure keeps the released marker until durable recovery', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'disk-journal-')), 'journal.jsonl');
    let full = true;
    const journal = new Journal(path, 'a', () => 1_000, { append: (p, text) => { if (full) throw noSpace(); appendFileSync(p, text); } });
    journal.write('start');
    journal.write('halt', { reasons: ['no disk'] });
    full = false;
    disk.syncNoSpace = true;
    expect(journal.retry()).toBe(false);
    expect(read(path)[0]).toMatchObject({ seq: 3, kind: 'start' });
    expect(statSync(`${path}.reserve`).size).toBe(0);
    expect(journal.failing).toBe(true);
    disk.syncNoSpace = false;
    expect(journal.retry()).toBe(true);
    expect(read(path)[1]).toMatchObject({ seq: 4, kind: 'coverage_gap', lost: 2, from_seq: 1, to_seq: 2 });
    expect(statSync(`${path}.reserve`).size).toBe(64 * 1024);
    expect(checkJournal(readFileSync(path, 'utf8')).complete).toBe(false);
  });

  it('reserve allocation ENOSPC latches the worker without throwing or retaining a partial allocation', async () => {
    disk.reserveNoSpace = true;
    const h = makeWorker();
    expect(await h.worker.reconcile()).toEqual({ ok: true });
    expect(h.worker.health()).toMatchObject({ recorder: 'off', entries_halted: true });
    expect(statSync(join(h.stateDir, 'journal.jsonl.reserve')).size).toBe(0);
    expect(read(join(h.stateDir, 'journal.jsonl'))[0]?.['kind']).toBe('start');
    disk.reserveNoSpace = false;
    await h.worker.stop();
  });

  it.each(['missing', 'short', 'corrupt'])('a %s reserve reports uncertainty, with start before the gap', (mode) => {
    const path = join(mkdtempSync(join(tmpdir(), 'disk-journal-')), 'journal.jsonl');
    writeFileSync(path, '{"seq":1,"ts":"2026-10-05T00:00:00.000Z","boot":"a","kind":"start"}\n');
    if (mode !== 'missing') writeFileSync(`${path}.reserve`, mode === 'short' ? Buffer.alloc(12) : Buffer.alloc(64 * 1024, 1));
    const restarted = new Journal(path, 'b', () => Date.parse('2026-10-05T00:00:01.000Z'));
    // No marker may be cleared or created as armed before its uncertainty gap is durable.
    if (mode === 'missing') expect(existsSync(`${path}.reserve`)).toBe(false);
    else expect(statSync(`${path}.reserve`).size).toBe(mode === 'short' ? 12 : 64 * 1024);
    restarted.write('start');
    const rows = read(path).filter((r) => r['boot'] === 'b');
    expect(rows.map((r) => r['kind'])).toEqual(['start', 'coverage_gap']);
    expect(rows[1]).toMatchObject({ stream: 'journal', lost: null });
    expect(checkJournal(readFileSync(path, 'utf8')).complete).toBe(false);
  });

  it('a startup recovery gap that cannot be appended notifies immediately and preserves its marker', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'disk-journal-')), 'journal.jsonl');
    const first = new Journal(path, 'a', () => 1_000);
    first.write('start');
    writeFileSync(`${path}.reserve`, '');
    let faults = 0;
    const next = new Journal(path, 'b', () => 2_000, { onNoSpace: () => faults++, append: (p, text) => {
      if (JSON.parse(text).kind === 'coverage_gap') throw noSpace();
      appendFileSync(p, text);
    } });
    next.write('start');
    expect(faults).toBe(1);
    expect(next.failing).toBe(true);
    expect(statSync(`${path}.reserve`).size).toBe(0);
    expect(read(path).filter((r) => r['boot'] === 'b').map((r) => r['kind'])).toEqual(['start']);
    new Journal(path, 'c', () => 3_000).write('start');
    expect(read(path).some((r) => r['boot'] === 'c' && r['stream'] === 'journal' && r['lost'] === null)).toBe(true);
    expect(checkJournal(readFileSync(path, 'utf8')).complete).toBe(false);
  });

  it.each([false, true])('ordinary restart (clean stop=%s) keeps completeness when no ENOSPC was observed', (clean) => {
    const path = join(mkdtempSync(join(tmpdir(), 'disk-journal-')), 'journal.jsonl');
    const first = new Journal(path, 'a', () => 1_000);
    first.write('start');
    if (clean) first.write('stop', { reasons: ['signal'] });
    new Journal(path, 'b', () => 2_000).write('start');
    expect(read(path).some((r) => r['stream'] === 'journal')).toBe(false);
    expect(checkJournal(readFileSync(path, 'utf8')).complete).toBe(true);
  });
});
