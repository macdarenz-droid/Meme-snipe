// GROWTH-SWEEP: files that grow for the whole run (journal.jsonl, deployers.jsonl, the runner's samples) are read in
// chunks, never whole, on the worker's boot path and in the runner's drills and report; the chunked reader keeps a
// multi-byte character cut by a chunk boundary whole; the streamed journal check equals the whole-text one.
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MarketEvent } from '../../core/src/engine/index.ts';
import { LOG_CREATE_PREFIX } from '../../core/src/gates/index.ts';
import { checkJournal, checkJournalLines } from '../../runner/src/journal.ts';
import { fileLines } from '../../runner/src/lines.ts';
import { journalLines } from '../src/run/booked.ts';
import { DeployerStore } from '../src/run/deployer-store.ts';
import { typedText } from '../src/run/json.ts';
import { T, makeWorker } from './worker-harness.ts';

const temp = (): string => mkdtempSync(join(tmpdir(), 'growth-'));

describe('the chunked line reader', () => {
  it('keeps every multi-byte character whole at any chunk size, with or without a final newline (journalLines used to cut them)', () => {
    const dir = temp();
    const lines = ['{"n":"é"}', '{"n":"日本語"}', '{"n":"🙂🙂"}', '', '{"n":"ok"}'];
    for (const final of ['\n', '']) {
      const p = join(dir, `f${final.length}`);
      writeFileSync(p, lines.join('\n') + final);
      for (let chunk = 1; chunk <= 12; chunk++) {
        expect([...fileLines(p, chunk)], `chunk ${chunk}`).toEqual(lines);
        expect([...journalLines(p, chunk)], `journalLines chunk ${chunk}`).toEqual(lines);
      }
    }
    // A file cut inside a character (a torn tail): the partial character reads as U+FFFD, as a whole-file read gives.
    const cut = Buffer.concat([Buffer.from('{"a":1}\n{"n":"'), Buffer.from('🙂').subarray(0, 2)]);
    writeFileSync(join(dir, 'cut'), cut);
    for (let chunk = 1; chunk <= 8; chunk++) expect([...fileLines(join(dir, 'cut'), chunk)], `cut chunk ${chunk}`).toEqual(cut.toString('utf8').split('\n'));
    writeFileSync(join(dir, 'empty'), '');
    expect([...fileLines(join(dir, 'empty'))]).toEqual([]);
  });
});

describe('the streamed journal check', () => {
  const line = (seq: number, kind: string, extra: Record<string, unknown> = {}) => JSON.stringify({ seq, ts: '2026-10-04T00:00:00.000Z', boot: 'b', kind, ...extra });
  const texts = [
    '',
    `${line(1, 'start')}\n${line(2, 'reconcile', { ok: true })}\n`,
    `${line(1, 'start')}\n${line(2, 'reconcile', { ok: true })}\n{"seq":3,"to`,
    `${line(1, 'start')}\n\n${line(2, 'reconcile', { ok: true })}\n`,
    `${line(1, 'start')}\n${line(3, 'reconcile', { ok: true })}\n\n`,
    `${line(1, 'decision')}\nnot json\n${line(2, 'entry', { trade: 't' })}`,
  ];
  it('gives the same report as the whole-text check, torn tail allowed or not, from a string split or a streamed file', () => {
    const dir = temp();
    texts.forEach((text, k) => {
      const p = join(dir, `j${k}`);
      writeFileSync(p, text);
      for (const allowTornTail of [false, true]) {
        const whole = checkJournal(text, { allowTornTail });
        expect(checkJournalLines(fileLines(p, 7), { allowTornTail }), `text ${k} torn ${allowTornTail}`).toEqual(whole);
      }
    });
  });

  it('a line that is not JSON is a problem, unless it is the last one and a torn tail is allowed (pinned, as before the change)', () => {
    const notJson = (text: string, allowTornTail: boolean) => checkJournal(text, { allowTornTail }).problems.filter((p) => p.endsWith('not JSON'));
    expect(notJson(texts[2]!, true)).toEqual([]);
    expect(notJson(texts[2]!, false)).toEqual(['line 3: not JSON']);
    expect(notJson(texts[3]!, true)).toEqual(['line 2: not JSON']);
    expect(notJson(texts[4]!, true)).toEqual([]);
    expect(notJson(texts[4]!, false)).toEqual(['line 3: not JSON']);
    expect(notJson(texts[5]!, true)).toEqual(['line 2: not JSON']);
    expect(checkJournal(texts[1]!).lines).toBe(2);
  });
});

describe('the deployer store at boot', () => {
  const event = (k: number, receivedAt: number, key = `${LOG_CREATE_PREFIX}Mint${k}`): MarketEvent => ({
    kind: 'market', id: `log:sig${k}:00001`, moment: { slot: BigInt(1_000 + k), txIndex: 2 ** 32, ixIndex: 2 ** 36, receivedAt }, key,
    value: { event: { name: 'CreateEvent', program: 'pump', data: { mint: `Mint${k}`, creator: `Dev${k % 7}`, timestamp: BigInt(Math.floor(receivedAt / 1000)), note: 'é日🙂' } } },
  });

  it('streams a file larger than one chunk: keeps the window and every coverage fact, drops a torn tail, rewrites it 0600', () => {
    const dir = temp();
    const path = join(dir, 'deployers.jsonl');
    const from = 5_000_000;
    const all: MarketEvent[] = [];
    for (let k = 0; k < 9_000; k++) all.push(event(k, k < 3_000 ? from - 1 - k : from + k));
    const cov = event(-1, 1, 'coverage:creates:start');
    all.splice(10, 0, cov);
    const text = `${all.map((e) => typedText(e)).join('\n')}\n{"kind":"market","id":"torn`;
    expect(Buffer.byteLength(text)).toBeGreaterThan(2 * (1 << 20));
    writeFileSync(path, text);
    const saved = new DeployerStore(dir).load(from);
    const want = all.filter((e) => e === cov || e.moment.receivedAt >= from);
    expect(saved.coverage.map((e) => e.id)).toEqual([cov.id]);
    expect(saved.creates.map((e) => e.id)).toEqual(want.filter((e) => e !== cov).map((e) => e.id));
    expect(saved.creates[0]).toEqual(want.find((e) => e !== cov));
    expect(saved.last).toEqual({ slot: BigInt(1_000 + 8_999), ms: from + 8_999 });
    expect(readFileSync(path, 'utf8')).toBe(want.map((e) => `${typedText(e)}\n`).join(''));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // A second start reads its own rewrite to the same result.
    expect(new DeployerStore(dir).load(from).creates.length).toBe(saved.creates.length);
  });
});

describe('no whole-file read of a growing file on the boot, timer or request paths (guard)', () => {
  const src = (p: string): string => readFileSync(join(import.meta.dirname, '..', '..', p), 'utf8');
  it('the deployer store, the bookings reader and the runner\'s journal and samples readers stream', () => {
    expect(src('worker/src/run/deployer-store.ts')).not.toMatch(/readFileSync/);
    expect(src('worker/src/run/booked.ts')).not.toMatch(/readFileSync/);
    const runner = src('runner/src/runner.ts');
    expect(runner).not.toMatch(/readFileSync\(journalPath/);
    expect(runner).not.toMatch(/readFileSync\(p, 'utf8'\)\s*\.split/);
  });
});

describe('the deployer store with a restored index, and the seed cap (WORKER-GROW G4b)', () => {
  const event = (k: number, receivedAt: number, key = `${LOG_CREATE_PREFIX}Mint${k}`): MarketEvent => ({
    kind: 'market', id: `log:sig${k}:00001`, moment: { slot: BigInt(1_000 + k), txIndex: 2 ** 32, ixIndex: 2 ** 36, receivedAt }, key,
    value: { event: { name: 'CreateEvent', program: 'pump', data: { mint: `Mint${k}`, creator: `Dev${k % 7}`, timestamp: BigInt(Math.floor(receivedAt / 1000)) } } },
  });
  const write = (dir: string, events: readonly MarketEvent[]) => writeFileSync(join(dir, 'deployers.jsonl'), events.map((e) => `${typedText(e)}\n`).join(''));

  it('keepCreates false: no create is held, the file keeps them all, and `last` still counts them', () => {
    const dir = temp();
    const cov = event(-1, 1, 'coverage:creates:start');
    const all = [cov, ...Array.from({ length: 50 }, (_, k) => event(k, 10_000 + k))];
    write(dir, all);
    const saved = new DeployerStore(dir).load(0, { keepCreates: false });
    expect(saved.creates).toEqual([]);
    expect(saved.coverage.map((e) => e.id)).toEqual([cov.id]);
    expect(saved.last).toEqual({ slot: 1_049n, ms: 10_049 });
    expect(readFileSync(join(dir, 'deployers.jsonl'), 'utf8')).toBe(all.map((e) => `${typedText(e)}\n`).join(''));
    // The next start with no saved index seeds from all of them.
    expect(new DeployerStore(dir).load(0).creates).toHaveLength(50);
  });

  it('over maxCreates the seed is refused whole (no creates, rugs, coverage or last: H14 not covered); at the cap it is kept', () => {
    const dir = temp();
    const cov = event(-1, 1, 'coverage:creates:start');
    write(dir, [cov, ...Array.from({ length: 10 }, (_, k) => event(k, 10_000 + k))]);
    expect(new DeployerStore(dir).load(0, { maxCreates: 9 })).toEqual({ creates: [], rugs: [], coverage: [], last: null, refused: '10 saved creates, over the seed cap of 9' });
    // The file is trimmed and kept either way: a later start with a saved index still has it.
    expect(readFileSync(join(dir, 'deployers.jsonl'), 'utf8').trim().split('\n')).toHaveLength(11);
    const at = new DeployerStore(dir).load(0, { maxCreates: 10 });
    expect(at.creates).toHaveLength(10);
    expect(at.refused).toBeUndefined();
  });
});

describe('the seed cap at a worker start with no saved index (WORKER-GROW G4b)', () => {
  it('over the cap the start seeds nothing and says so (a fresh start: H14 not covered, as the PERSIST-1 tests show); at the cap it seeds', async () => {
    const dir = temp();
    const lines = Array.from({ length: 3 }, (_, k) => typedText({
      kind: 'market', id: `log:sig${k}:00001`, moment: { slot: BigInt(1_000 + k), txIndex: 2 ** 32, ixIndex: 2 ** 36, receivedAt: T - 16 * 86_400_000 - 60_000 + k },
      key: `${LOG_CREATE_PREFIX}Mint${k}`, value: { event: { name: 'CreateEvent', program: 'pump', data: { mint: `Mint${k}`, creator: 'Dev', timestamp: 1n } } },
    } as MarketEvent));
    writeFileSync(join(dir, 'deployers.jsonl'), `${lines.join('\n')}\n`);
    const h = makeWorker({ stateDir: dir, maxSeedCreates: 2 });
    expect(h.logs).toContain('Deployer store not seeded (3 saved creates, over the seed cap of 2): H14 is not covered until the look-back passes.');
    await h.worker.stop();
    const ok = makeWorker({ stateDir: dir, maxSeedCreates: 3 });
    expect(ok.logs.some((l) => l.startsWith('Deployer store not seeded'))).toBe(false);
    await ok.worker.stop();
  });
});
