// RC-H3 follow-up (S1 on #271): the recorder's gaps file must never keep an ended boot "open" for the recording upload.
// A plain gaps.jsonl made record-upload.mjs settled() report "an open file" forever: the manifest and saved state never
// went up, uploaded frames and releases were never deleted, and the gaps past the first 500 never left the server. Real
// Recorder folders here, uploaded by the real uploader through the real watchdog route to an in-memory GitHub.
import { readdirSync, readFileSync, rmSync, mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../../ops/src/watchdog/worker.ts';
import { KEY, rig } from '../../../ops/test/record-fakes.ts';
import { GAPS_FILES, Recorder, gapsChunk, recordedGaps, sealLeftovers } from '../../src/run/recorder.ts';

const GAPS_PACKED = `${gapsChunk(0)}.zst`;
const GAPS_FILE = gapsChunk(0);

const MJS = join(fileURLToPath(new URL('../../../../', import.meta.url)), 'ops/host/files/usr/local/lib/zeroed/record-upload.mjs');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const up: any = await import(MJS);

const DAY = 86_400_000;
const NOW = Date.now();
const AT = NOW - 2 * DAY;
const tmp = mkdtempSync(join(tmpdir(), 'rc-gaps-upload-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

const gap = (i: number) => ({ key: 'coverage:rugs:gap', value: { fromSlot: String(300_000_000 + i), toSlot: String(300_000_000 + i), reason: `cut trade log ${i}`, via: 'logs:P' }, receivedAt: AT + i });
let n = 0;

/** One boot of the real Recorder, 600 stream gaps (past the manifest's 500), ended by a clean stop or a kill. */
const recordBoot = (end: 'stop' | 'kill') => {
  const base = join(tmp, `case-${++n}`);
  const root = join(base, 'recorder');
  const boot = `${AT.toString(36)}-${100 + n}`;
  const r = new Recorder({ root, boot, gitSha: 'a'.repeat(40), rotateBytes: 1 << 20 });
  for (let i = 0; i < 3; i++) {
    r.frame({ seq: i, receivedAt: AT + i, source: 's', place: 'p', duplicate: false, body: { type: 'slot', slot: BigInt(300_000_000 + i) } } as never);
    r.release({ seq: i, kind: 'probe' } as never, AT + i);
  }
  for (let i = 0; i < 600; i++) r.gap(gap(i));
  r.flush();
  if (end === 'stop') r.close();
  else expect(sealLeftovers(root, 'next-boot')).toEqual([boot]);
  // Quiet for longer than the uploader's 15 minutes.
  const t = (NOW - 3_600_000) / 1000;
  const age = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) age(join(d, e.name));
      utimesSync(join(d, e.name), t, t);
    }
  };
  age(root);
  return { base, root, boot, dir: join(root, boot) };
};

const upload = async (b: ReturnType<typeof recordBoot>) => {
  const x = rig();
  const call = async (h: { text: string; signature: string }, body: Buffer | null) => {
    const headers: Record<string, string> = { 'x-zeroed-record': h.text, 'x-zeroed-signature': h.signature };
    if (body) headers['content-length'] = String(body.length);
    const res = await worker.fetch(new Request('https://w.test/record', { method: 'POST', headers, ...(body ? { body, duplex: 'half' } : {}) } as RequestInit), x.env);
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const transport = { put: (h: { text: string; signature: string }, path: string) => call(h, readFileSync(path)), check: (h: { text: string; signature: string }) => call(h, null) };
  const u = new up.Uploader(
    { root: b.root, journal: join(b.base, 'journal.jsonl'), stateDir: join(b.base, 'state'), key: KEY, values: [], deleteLocal: true, scope: 'all' },
    { transport, workerActive: async () => false, now: () => NOW, log: () => {} },
  );
  const code = await u.run();
  return { code, names: [...x.gh.assets.values()].map((a) => a.name).sort() };
};

describe('RC-H3: an ended boot with stream gaps settles and uploads them', () => {
  for (const end of ['stop', 'kill'] as const) {
    it(`after a ${end === 'stop' ? 'clean stop' : 'kill (sealed at the next start)'}: settled, manifest and packed gaps are upload items, frames and releases go up and are deleted, every gap reads back`, async () => {
      const b = recordBoot(end);
      expect(readdirSync(b.dir).sort()).toEqual(['days', GAPS_PACKED, 'manifest.json']);
      const m = JSON.parse(readFileSync(join(b.dir, 'manifest.json'), 'utf8'));
      expect(m.coverage_gaps_file).toMatchObject({ path: GAPS_FILES, total: 600 });
      expect(m.attachments).toEqual([expect.objectContaining({ file: GAPS_PACKED, sha256: expect.stringMatching(/^[0-9a-f]{64}$/), content: expect.objectContaining({ encoding: 'zstd' }) })]);
      // (c) every gap, in order, from the packed file.
      expect(recordedGaps(b.dir).filter((g) => (g as { key?: string }).key === 'coverage:rugs:gap')).toEqual(Array.from({ length: 600 }, (_, i) => gap(i)));
      // (a)/(b) the uploader sees the boot settled; its manifest and the packed gaps are items.
      expect(up.settled(b.dir, NOW)).toBeNull();
      const [boot] = await up.readBoots({ root: b.root, journal: join(b.base, 'journal.jsonl') }, NOW, async () => false);
      expect(boot.open).toBe(false);
      expect(up.itemsOf(boot).map((i: { kind: string; file: string }) => `${i.kind} ${i.file}`).sort()).toEqual(['attachment gaps-000.jsonl.zst', 'data frames-000.jsonl.zst', 'data releases-000.jsonl.zst', 'manifest manifest.json']);
      // (d) one run: everything goes up, then the uploaded frames and releases are deleted.
      const r = await upload(b);
      expect(r.code).toBe(0);
      expect(r.names).toEqual(expect.arrayContaining([`${b.boot}.${GAPS_PACKED}`, `${b.boot}.manifest.json`, `${b.boot}.frames-000.jsonl.zst`, `${b.boot}.releases-000.jsonl.zst`]));
      const left = readdirSync(join(b.dir, 'days'), { recursive: true }).map(String).filter((f) => /(frames|releases)-\d{3}/.test(f));
      expect(left).toEqual([]);
      expect(readdirSync(b.dir)).toContain(GAPS_PACKED);
    });
  }

  it('a kill that left only the gaps file open: the next start packs it and the boot settles', () => {
    const root = join(tmp, 'only-gaps');
    const r = new Recorder({ root, boot: 'b-gaps', gitSha: 'x', rotateBytes: 1 << 20 });
    for (let i = 0; i < 3; i++) r.gap(gap(i));
    r.flush();
    expect(sealLeftovers(root, 'next-boot')).toEqual(['b-gaps']);
    expect(readdirSync(join(root, 'b-gaps')).sort()).toEqual([GAPS_PACKED, 'manifest.json']);
    expect(recordedGaps(join(root, 'b-gaps')).filter((g) => (g as { key?: string }).key !== undefined)).toEqual([gap(0), gap(1), gap(2)]);
  });

  it('while the boot runs the gaps stay plain and are read from there', () => {
    const root = join(tmp, 'running');
    const r = new Recorder({ root, boot: 'b-run', gitSha: 'x', rotateBytes: 1 << 20 });
    for (let i = 0; i < 3; i++) r.gap(gap(i));
    r.flush();
    expect(readdirSync(join(root, 'b-run'))).toContain(GAPS_FILE);
    expect(recordedGaps(join(root, 'b-run'))).toEqual([gap(0), gap(1), gap(2)]);
  });
});
