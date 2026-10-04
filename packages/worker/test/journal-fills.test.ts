// WORKER-ORDER follow-up (review of #123): the journal's fill lines are read at every boot, so the journal is streamed
// in chunks, never read whole (a long shakedown journal under MemoryMax would kill the process that owns exits). The
// whole-file read is made to throw here, and fills on both sides of every chunk boundary are still found.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (load) => {
  const fs = await load<typeof import('node:fs')>();
  const readFileSync = ((p: unknown, ...rest: unknown[]) => {
    if (String(p).endsWith('journal.jsonl')) throw new Error('the journal must not be read whole');
    return (fs.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.readFileSync;
  return { ...fs, default: { ...fs, readFileSync }, readFileSync };
});

const { readJournalFills } = await import('../src/run/worker.ts');

describe('readJournalFills', () => {
  it('streams the journal in chunks: fill lines on both sides of each boundary are found, others and torn lines skipped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zeroed-fills-'));
    const path = join(dir, 'journal.jsonl');
    const lines = [
      { seq: 1, kind: 'start', boot: 'b1' },
      { seq: 2, kind: 'entry', intent: 'i1', tokens: '5', trade: 'p1', sol_usd: '150000000', reasons: ['entry filled (paper)', 'notional 2000000'] },
      { seq: 3, kind: 'decision', action: 'skip', reasons: ['quiet'] },
      { seq: 4, kind: 'exit', intent: 'i2', tokens: '5', trade: 'p1', position: 'closed', sol_usd: null, reasons: ['exit filled (paper)', 'stop'] },
      { seq: 5, kind: 'entry', intent: 'i3', tokens: '7', trade: 'p2', sol_usd: '151000000', reasons: ['entry filled (paper)'] },
    ];
    const text = `${lines.map((l) => JSON.stringify(l)).join('\n')}\n{"seq":6,"kind":"exit","intent":"i4"`;
    writeFileSync(path, text);
    const want = [lines[1], lines[3], lines[4]];
    // Chunk sizes that cut lines anywhere, including inside the fill lines and their kind field, and the default.
    for (const chunk of [1, 3, 17, 64, 1 << 20, undefined]) expect(readJournalFills(path, chunk), `chunk ${chunk}`).toEqual(want);
    expect(readJournalFills(join(dir, 'missing.jsonl'))).toEqual([]);
  });
});
