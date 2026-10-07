// RC-FIXES-2b (S1 on #271): a gaps chunk is sealed crash-safe. A kill just before any step of a seal (the packed file,
// its rename, the manifest, the removal of the plain chunk), at a clean stop or at the next start's sealing, leaves a
// folder the next start turns into a settled boot whose manifest lists every packed chunk with its true hash, and
// every gap reads back once, in order.
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

type Op = 'writeFileSync' | 'renameSync' | 'rmSync';
const kill = vi.hoisted(() => ({ at: null as null | { op: string; match: RegExp; partial?: boolean } }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const hook = <F extends (...a: never[]) => unknown>(op: Op, f: F): F => ((...a: Parameters<F>) => {
    const k = kill.at;
    if (k !== null && k.op === op && k.match.test(String(a[0]))) {
      kill.at = null;
      if (k.partial) fs.writeFileSync(String(a[0]), (a[1] as unknown as Buffer).subarray(0, 7));
      throw new Error(`killed before ${op} ${String(a[0])}`);
    }
    return f(...a);
  }) as F;
  const out = { ...fs, writeFileSync: hook('writeFileSync', fs.writeFileSync), renameSync: hook('renameSync', fs.renameSync), rmSync: hook('rmSync', fs.rmSync) };
  return { ...out, default: out };
});
const { Recorder, gapsChunk, recordedGaps, sealLeftovers } = await import('../../src/run/recorder.ts');

const tmp = mkdtempSync(join(tmpdir(), 'rc-gaps-kill-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const gap = (i: number) => ({ key: 'coverage:rugs:gap', value: { fromSlot: String(i), toSlot: String(i), reason: `cut ${i}`, via: 'logs:P' }, receivedAt: i });
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const GAPS = Array.from({ length: 50 }, (_, i) => gap(i));

/** The folder is a settled, fully listed boot: no plain or temporary file, every packed chunk listed with its hash. */
const settledAndListed = (dir: string) => {
  const files = readdirSync(dir);
  expect(files.filter((f) => f.endsWith('.jsonl') || f.endsWith('.tmp'))).toEqual([]);
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { attachments: { file: string; sha256: string; bytes: number; rows?: number }[]; coverage_gaps_file?: { total: number } };
  const packed = files.filter((f) => /^gaps-\d{3}\.jsonl\.zst$/.test(f)).sort();
  expect(m.attachments.map((a) => a.file).filter((f) => f.startsWith('gaps-')).sort()).toEqual(packed);
  for (const a of m.attachments.filter((x) => x.file.startsWith('gaps-'))) expect(a.sha256, a.file).toBe(sha(readFileSync(join(dir, a.file))));
  expect(m.coverage_gaps_file?.total).toBe(GAPS.length);
  expect(recordedGaps(dir).filter((g) => (g as { key?: string }).key !== undefined)).toEqual(GAPS);
};

let n = 0;
const boot = () => {
  const root = join(tmp, `c${++n}`);
  const r = new Recorder({ root, boot: 'b1', gitSha: 'x', rotateBytes: 1 << 20 });
  for (const g of GAPS) r.gap(g);
  r.flush();
  return { root, r, dir: join(root, 'b1') };
};

const STEPS: [string, { op: Op; match: RegExp; partial?: boolean }][] = [
  ['the packed file is written (torn)', { op: 'writeFileSync', match: /gaps-000\.jsonl\.zst\.tmp$/, partial: true }],
  ['the packed file is renamed into place', { op: 'renameSync', match: /gaps-000\.jsonl\.zst\.tmp$/ }],
  ['the manifest listing it is written', { op: 'renameSync', match: /manifest\.json\.tmp$/ }],
  ['the plain chunk is removed', { op: 'rmSync', match: /gaps-000\.jsonl$/ }],
];

describe('RC-FIXES-2b: a kill at each step of a gaps seal', () => {
  for (const [what, at] of STEPS) {
    it(`at a clean stop, killed before ${what}: the next start settles and lists it`, () => {
      const b = boot();
      kill.at = at;
      expect(() => b.r.close()).toThrow(/killed before/);
      // Crash-safe order: the plain chunk is still there at every step before its own removal.
      expect(readdirSync(b.dir).includes(gapsChunk(0))).toBe(true);
      expect(sealLeftovers(b.root, 'b2')).toEqual(['b1']);
      settledAndListed(b.dir);
    });

    it(`at the next start, killed before ${what}: the start after it settles and lists it`, () => {
      const b = boot();
      // A kill of the running boot: its chunk stays plain. The next start's sealing is then killed at the step.
      kill.at = at;
      expect(() => sealLeftovers(b.root, 'b2')).toThrow(/killed before/);
      expect(readdirSync(b.dir).includes(gapsChunk(0))).toBe(true);
      sealLeftovers(b.root, 'b3');
      settledAndListed(b.dir);
    });
  }

  it('a packed chunk the manifest does not list (and no plain chunk beside it) is listed at the next start', () => {
    const b = boot();
    b.r.close();
    const m = JSON.parse(readFileSync(join(b.dir, 'manifest.json'), 'utf8'));
    m.attachments = [];
    writeFileSync(join(b.dir, 'manifest.json'), JSON.stringify(m));
    expect(sealLeftovers(b.root, 'b2')).toEqual(['b1']);
    settledAndListed(b.dir);
  });

  it('a stray packed temporary file is removed, so the boot can settle', () => {
    const b = boot();
    b.r.close();
    writeFileSync(join(b.dir, `${gapsChunk(1)}.zst.tmp`), 'torn');
    expect(sealLeftovers(b.root, 'b2')).toEqual(['b1']);
    settledAndListed(b.dir);
  });

  it('a plain chunk whose listed packed file is missing is packed again, never dropped', () => {
    const b = boot();
    b.r.close();
    const text = recordedGaps(b.dir).filter((g) => (g as { key?: string }).key !== undefined).map((g) => JSON.stringify(g)).join('\n');
    writeFileSync(join(b.dir, gapsChunk(0)), `${text}\n`);
    rmSync(join(b.dir, `${gapsChunk(0)}.zst`));
    expect(sealLeftovers(b.root, 'b2')).toEqual(['b1']);
    settledAndListed(b.dir);
  });

  it('a clean stop with no kill needs nothing at the next start', () => {
    const b = boot();
    b.r.close();
    const copy = join(tmp, 'clean-copy');
    cpSync(b.root, copy, { recursive: true });
    expect(sealLeftovers(copy, 'b2')).toEqual([]);
    settledAndListed(join(copy, 'b1'));
    expect(readdirSync(b.dir).sort()).toEqual([`${gapsChunk(0)}.zst`, 'manifest.json']);
  });
});
