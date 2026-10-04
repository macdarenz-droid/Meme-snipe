// EXIT-1f N2: where a position's entry fill booking sits against the boots, from the journal's start and reconcile lines.
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { journalLines, placeBookings, placeBookingsAt } from '../src/run/booked.ts';

const line = (boot: string, kind: string, ms: number, extra: Record<string, unknown> = {}) => JSON.stringify({ seq: 1, ts: new Date(ms).toISOString(), boot, kind, ...extra });
const journal = (...lines: string[]) => `${lines.join('\n')}\n`;

describe('booking placement (EXIT-1f N2)', () => {
  const j = journal(
    line('boot-1', 'start', 1_000), line('boot-1', 'reconcile', 2_000, { ok: true }),
    line('boot-2', 'start', 10_000), line('boot-2', 'reconcile', 12_000, { ok: false }),
    line('boot-3', 'start', 20_000),
  );
  it('a booking after its boot\'s reconcile line is live; one between the start and reconcile lines is at the reconcile', () => {
    expect(placeBookings(j, { a: 5_000, b: 1_500, c: 2_000, d: 1_000 })).toEqual({ a: 'live', b: 'reconcile', c: 'reconcile', d: 'reconcile' });
  });
  it('a failed reconcile still closes its boot\'s reconcile window', () => {
    expect(placeBookings(j, { a: 11_000, b: 13_000 })).toEqual({ a: 'reconcile', b: 'live' });
  });
  it('what the journal cannot place stays unplaced, with why', () => {
    expect(placeBookings(j, { a: 500, b: 25_000 })).toEqual({ a: 'unplaced: no boot started before the booking', b: 'unplaced: that boot has no reconcile line' });
    expect(placeBookings(null, { a: 5_000 })).toEqual({ a: 'unplaced: no journal' });
    expect(placeBookings(`${j}{not json\n`, { a: 5_000 })).toEqual({ a: 'unplaced: a journal line could not be read' });
  });
});

describe('the journal is streamed (EXIT-1g N7)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'booked-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const text = journal(
    line('boot-1', 'start', 1_000), line('boot-1', 'decision', 1_500, { reasons: ['"kind":"start" inside a string'] }), line('boot-1', 'reconcile', 2_000, { ok: true }),
    line('boot-2', 'start', 10_000), line('boot-2', 'reconcile', 12_000, { ok: true }),
  );
  it('read in chunks that split lines anywhere, the file places bookings as the text does', () => {
    const path = join(dir, 'j.jsonl');
    writeFileSync(path, text);
    const booked = { a: 1_500, b: 5_000, c: 11_000, d: 13_000 };
    expect(placeBookingsAt(path, booked)).toEqual(placeBookings(text, booked));
    for (const chunk of [1, 7, 64]) expect([...journalLines(path, chunk)]).toEqual(text.split('\n').filter((l, i, all) => i < all.length - 1 || l !== ''));
  });
  it('a line that is not a whole record (a torn write) leaves every booking unplaced; no journal and nothing to place are handled', () => {
    const path = join(dir, 'torn.jsonl');
    writeFileSync(path, `${text}{"seq":9,"ts":"2026`);
    expect(placeBookingsAt(path, { a: 5_000 })).toEqual({ a: 'unplaced: a journal line could not be read' });
    expect(placeBookingsAt(join(dir, 'none.jsonl'), { a: 5_000 })).toEqual({ a: 'unplaced: no journal' });
    expect(placeBookingsAt(join(dir, 'none.jsonl'), {})).toEqual({});
  });
  it('a journal of about 200 MB places bookings within 10 s and 160 MB of resident memory (a separate process)', () => {
    const path = join(dir, 'big.jsonl');
    const fd = openSync(path, 'w');
    const filler = line('boot-1', 'decision', 1_500, { action: 'none', reasons: ['entry plan', 'x'.repeat(200)] });
    const block = `${Array.from({ length: 10_000 }, () => filler).join('\n')}\n`;
    writeSync(fd, `${line('boot-1', 'start', 1_000)}\n`);
    for (let k = 0; k < 75; k++) writeSync(fd, block);
    writeSync(fd, `${line('boot-1', 'reconcile', 2_000, { ok: true })}\n`);
    closeSync(fd);
    expect(statSync(path).size).toBeGreaterThan(200_000_000);
    const script = `import { placeBookingsAt } from ${JSON.stringify(join(import.meta.dirname, '../src/run/booked.ts'))};
const t = performance.now(); const r = placeBookingsAt(${JSON.stringify(path)}, { a: 1_500, b: 5_000 });
console.log(JSON.stringify({ r, ms: performance.now() - t, maxRssKb: process.resourceUsage().maxRSS }));`;
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(out.status, out.stderr).toBe(0);
    const res = JSON.parse(out.stdout.trim().split('\n').at(-1)!) as { r: unknown; ms: number; maxRssKb: number };
    expect(res.r).toEqual({ a: 'reconcile', b: 'live' });
    expect(res.ms).toBeLessThan(10_000);
    expect(res.maxRssKb).toBeLessThan(160 * 1024);
  }, 120_000);
});
