// RECORD-UPLOAD, host side (ops/host/files/usr/local/lib/zeroed/record-upload.mjs) against the real watchdog route and an
// in-memory GitHub: what is uploaded, what is kept on the server and why, the delete gate's every condition, the
// redaction scan, the journal days and the signed per-day index.
import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// node:fs passes through, with hooks a test arms to delete a file at an exact moment of the uploader's run (RECORD-BUDGET
// deletes recordings on its own schedule, so any file may vanish between two steps).
const fsHooks = vi.hoisted(() => ({
  beforeStream: null as ((path: string) => void) | null,
  afterReaddir: null as ((dir: string) => void) | null,
  afterExists: null as ((path: string, found: boolean) => void) | null,
}));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const wrapped = {
    ...fs,
    createReadStream: ((path: string, ...rest: unknown[]) => {
      fsHooks.beforeStream?.(String(path));
      return (fs.createReadStream as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.createReadStream,
    readdirSync: ((dir: string, ...rest: unknown[]) => {
      const out = (fs.readdirSync as (...a: unknown[]) => unknown)(dir, ...rest);
      fsHooks.afterReaddir?.(String(dir));
      return out;
    }) as typeof fs.readdirSync,
    existsSync: ((path: string) => {
      const found = fs.existsSync(path);
      fsHooks.afterExists?.(String(path), found);
      return found;
    }) as typeof fs.existsSync,
  };
  return { ...wrapped, default: wrapped };
});
import worker from '../src/watchdog/worker.ts';
import { KEY, rig, sha } from './record-fakes.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MJS = join(ROOT, 'ops/host/files/usr/local/lib/zeroed/record-upload.mjs');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const up: any = await import(MJS);

const H = 3_600_000;
const NOW = Date.now();
const day = (back: number) => new Date(NOW - back * 86_400_000).toISOString().slice(0, 10);
const D2 = day(2);
const D1 = day(1);
const TODAY = day(0);
const SECRET = 'TESTHELIUSKEY0123456789abcdef';
const tmp = mkdtempSync(join(tmpdir(), 'zeroed-record-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => {
  vi.unstubAllGlobals();
  fsHooks.beforeStream = null;
  fsHooks.afterReaddir = null;
  fsHooks.afterExists = null;
});

interface Fx {
  root: string;
  journal: string;
  stateDir: string;
  outside: string;
}
let n = 0;
const fx = (): Fx => {
  const base = join(tmp, `case-${++n}`);
  const f = { root: join(base, 'recorder'), journal: join(base, 'journal.jsonl'), stateDir: join(base, 'state'), outside: join(base, 'outside') };
  mkdirSync(f.root, { recursive: true });
  mkdirSync(f.outside, { recursive: true });
  return f;
};

/** Everything under dir, its folders too, last changed `ago` ms before now. */
const age = (dir: string, ago = H) => {
  const t = (NOW - ago) / 1000;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p);
      utimesSync(p, t, t);
    }
    utimesSync(d, t, t);
  };
  walk(dir);
};

const lines = (tag: string, k = 3) => Array.from({ length: k }, (_, i) => JSON.stringify({ seq: i, tag, url: 'https://x.test/?api-key=[redacted]' })).join('\n') + '\n';
const bootId = (hoursBack: number, pid: number) => `${(NOW - hoursBack * H).toString(36)}-${pid}`;

/** A boot folder as the recorder leaves it: listed files with sha256 and size, raw and delays too, and a saved state. */
const makeBoot = (f: Fx, boot: string, o: { days?: string[]; state?: string; open?: boolean; ago?: number; text?: (day: string, t: string) => string } = {}) => {
  const dir = join(f.root, boot);
  const days = (o.days ?? [D2]).map((d) => {
    const files = ['delays-000', 'frames-000', 'frames-001', 'raw-000', 'releases-000'].map((t) => {
      const b = zstdCompressSync(Buffer.from(o.text?.(d, t) ?? lines(`${boot}/${d}/${t}`)));
      const path = `days/${d}/${t}.jsonl.zst`;
      mkdirSync(join(dir, 'days', d), { recursive: true });
      writeFileSync(join(dir, path), b);
      return { path, bytes: b.length, sha256: sha(b) };
    });
    return { day: d, blocks_expected: 0, blocks_scanned: 0, complete: false, warm_up: false, rows: {}, files };
  });
  const attachments = [];
  if (o.state !== undefined) {
    const b = zstdCompressSync(Buffer.from(o.state));
    writeFileSync(join(dir, 'deployer-state.json.zst'), b);
    attachments.push({ file: 'deployer-state.json.zst', sha256: sha(b), bytes: b.length, content: { encoding: 'zstd', sha256: sha(o.state), bytes: o.state.length } });
  }
  if (o.open) writeFileSync(join(dir, 'days', days[0]!.day, 'frames-002.jsonl'), '{"open":1}\n');
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify({ schema: 2, source: 'live-recorder', boot, git_sha: 'a'.repeat(40), window: { from: days[0]?.day ?? null }, attachments, days }, null, 2)}\n`);
  age(dir, o.ago ?? H);
  return dir;
};

const startLine = (boot: string, ts: string) => `${JSON.stringify({ seq: 1, ts, boot, kind: 'start' })}\n`;

type Signed = { text: string; signature: string };
type Reply = { status: number; json: unknown };
interface Transport {
  put: (h: Signed, path: string, size: number) => Promise<Reply>;
  check: (h: Signed) => Promise<Reply>;
}

/** The real watchdog route, in process, with the fake GitHub behind it. */
const inproc = (r: ReturnType<typeof rig>): Transport => {
  const call = async (h: Signed, body: Buffer | null) => {
    const headers: Record<string, string> = { 'x-zeroed-record': h.text, 'x-zeroed-signature': h.signature };
    if (body) headers['content-length'] = String(body.length);
    const res = await worker.fetch(new Request('https://w.test/record', { method: 'POST', headers, ...(body ? { body, duplex: 'half' } : {}) } as RequestInit), r.env);
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { put: (h, path) => call(h, readFileSync(path)), check: (h) => call(h, null) };
};

const uploader = (f: Fx, o: { deleteLocal?: boolean; active?: boolean; scope?: string; values?: string[]; transport?: Transport; r?: ReturnType<typeof rig>; now?: number } = {}) => {
  const r = o.r ?? rig();
  const transport = o.transport ?? inproc(r);
  const log: string[] = [];
  const u = new up.Uploader(
    { root: f.root, journal: f.journal, stateDir: f.stateDir, key: KEY, values: o.values ?? [SECRET], deleteLocal: o.deleteLocal ?? true, scope: o.scope ?? 'all' },
    { transport, workerActive: async () => o.active ?? false, now: () => o.now ?? NOW, log: (s: string) => log.push(s) },
  );
  return { u, r, log, status: () => JSON.parse(readFileSync(join(f.stateDir, 'status.json'), 'utf8')), state: () => JSON.parse(readFileSync(join(f.stateDir, 'state.json'), 'utf8')) };
};

const assetNames = (r: ReturnType<typeof rig>) => [...r.gh.assets.values()].map((a) => a.name).sort();
const exists = (dir: string, p: string) => existsSync(join(dir, p));

describe('upload and delete', () => {
  it('uploads frames, releases, the manifest and the saved state of an ended boot, never raw or delays, and deletes only frames and releases', async () => {
    const f = fx();
    const boot = bootId(30, 101);
    const dir = makeBoot(f, boot, { days: [D2, D1], state: '{"saved":1}' });
    const x = uploader(f);
    expect(await x.u.run()).toBe(0);
    const names = assetNames(x.r);
    expect(names).toEqual([
      `${boot}.deployer-state.json.zst`, `${boot}.frames-000.jsonl.zst`, `${boot}.frames-000.jsonl.zst`, `${boot}.frames-001.jsonl.zst`, `${boot}.frames-001.jsonl.zst`,
      `${boot}.manifest.json`, `${boot}.releases-000.jsonl.zst`, `${boot}.releases-000.jsonl.zst`, 'index-1.json', 'index-1.json',
    ].sort());
    expect([...x.r.gh.releases.keys()].sort()).toEqual([`rec-${D1}`, `rec-${D2}`].sort());
    // Each day's files went to that day's release; the manifest and saved state to the boot's first day's.
    for (const [key, rec] of Object.entries(x.state().files) as [string, { day: string; release: string; asset_id: number }][]) {
      expect(rec.release, key).toBe(`rec-${rec.day}`);
      expect(x.r.gh.assets.get(rec.asset_id)!.browser_download_url, key).toContain(`/releases/download/rec-${rec.day}/`);
    }
    expect(x.state().files[`${boot}/manifest.json`].day).toBe(D2);
    for (const d of [D2, D1]) {
      for (const t of ['frames-000', 'frames-001', 'releases-000']) expect(exists(dir, `days/${d}/${t}.jsonl.zst`), `${d} ${t}`).toBe(false);
      for (const t of ['raw-000', 'delays-000']) expect(exists(dir, `days/${d}/${t}.jsonl.zst`), `${d} ${t}`).toBe(true);
    }
    expect(exists(dir, 'manifest.json')).toBe(true);
    expect(exists(dir, 'deployer-state.json.zst')).toBe(true);
    const st = x.status();
    expect(st).toMatchObject({ ok: true, failed_runs: 0, deleted: 6, kept: [], pending: 0 });
    expect(x.state().files[`${boot}/days/${D2}/frames-000.jsonl.zst`]).toMatchObject({ verified: true, deleted_at: NOW });
    // A second run finds nothing to do.
    const y = uploader(f, { r: x.r });
    const before = x.r.gh.calls.length;
    expect(await y.u.run()).toBe(0);
    expect(x.r.gh.calls.slice(before).filter((c) => c.startsWith('POST UP'))).toEqual([]);
  });

  it('with the delete switch off, uploads and deletes nothing', async () => {
    const f = fx();
    const dir = makeBoot(f, bootId(30, 102));
    const x = uploader(f, { deleteLocal: false });
    expect(await x.u.run()).toBe(0);
    expect(assetNames(x.r).length).toBeGreaterThan(0);
    expect(exists(dir, `days/${D2}/frames-000.jsonl.zst`)).toBe(true);
    expect(x.status().deleted).toBe(0);
  });

  it('keeps every file when GitHub stores other bytes (digest mismatch) or another size', async () => {
    for (const knob of ['corrupt', 'wrongSize'] as const) {
      const f = fx();
      const dir = makeBoot(f, bootId(30, 103));
      const r = rig();
      r.gh.knobs[knob] = true;
      const x = uploader(f, { r });
      expect(await x.u.run(), knob).toBe(1);
      expect(exists(dir, `days/${D2}/frames-000.jsonl.zst`), knob).toBe(true);
      expect(r.gh.assets.size, knob).toBe(0);
      expect(x.status().last_error, knob).toMatch(/HTTP 422/);
    }
  });

  it('keeps every file when GitHub gives no digest, and does not count it as uploaded', async () => {
    const f = fx();
    const dir = makeBoot(f, bootId(30, 104));
    const r = rig();
    r.gh.knobs.noDigest = true;
    const x = uploader(f, { r });
    expect(await x.u.run()).toBe(1);
    expect(exists(dir, `days/${D2}/frames-000.jsonl.zst`)).toBe(true);
    expect(Object.values(x.state().files).every((v) => (v as { verified: boolean }).verified === false)).toBe(true);
    expect(x.status().deleted).toBe(0);
  });

  it('keeps every file on an upload error, and three failed runs in a row are counted for the alert', async () => {
    const f = fx();
    const dir = makeBoot(f, bootId(30, 105));
    const down = { put: async () => ({ status: 0, json: null, error: 'curl exit 7: refused' }), check: async () => ({ status: 0, json: null }) };
    for (let i = 1; i <= 3; i++) {
      const x = uploader(f, { transport: down });
      expect(await x.u.run()).toBe(1);
      expect(x.status()).toMatchObject({ ok: false, failed_runs: i, running: false });
    }
    expect(exists(dir, `days/${D2}/frames-000.jsonl.zst`)).toBe(true);
    // It stopped after three failures in a row rather than trying every file.
    const x = uploader(f, { transport: down });
    await x.u.run();
    expect(x.log.filter((l: string) => l.startsWith('Not uploaded')).length).toBe(3);
    // A good run clears the count.
    const ok = uploader(f);
    expect(await ok.u.run()).toBe(0);
    expect(ok.status().failed_runs).toBe(0);
  });

  it('the running boot (journal start) uploads its sealed files but deletes nothing, and its manifest and saved state wait', async () => {
    const f = fx();
    const boot = bootId(30, 106);
    const dir = makeBoot(f, boot, { state: '{"s":1}' });
    writeFileSync(f.journal, startLine(boot, new Date(NOW - 30 * H).toISOString()));
    const x = uploader(f);
    expect(await x.u.run()).toBe(0);
    expect(assetNames(x.r).filter((a) => a.startsWith(boot))).toEqual([`${boot}.frames-000.jsonl.zst`, `${boot}.frames-001.jsonl.zst`, `${boot}.releases-000.jsonl.zst`]);
    expect(exists(dir, `days/${D2}/frames-000.jsonl.zst`)).toBe(true);
    expect(x.status().deleted).toBe(0);
  });

  it('the newest boot while the worker runs, and a boot with an open plain .jsonl file, delete nothing', async () => {
    const f = fx();
    const older = makeBoot(f, bootId(40, 107));
    const newest = makeBoot(f, bootId(30, 108));
    const x = uploader(f, { active: true });
    expect(await x.u.run()).toBe(0);
    expect(exists(older, `days/${D2}/frames-000.jsonl.zst`)).toBe(false);
    expect(exists(newest, `days/${D2}/frames-000.jsonl.zst`)).toBe(true);
    const g = fx();
    const open = makeBoot(g, bootId(30, 109), { open: true });
    const y = uploader(g);
    expect(await y.u.run()).toBe(0);
    expect(exists(open, `days/${D2}/frames-000.jsonl.zst`)).toBe(true);
    expect(exists(open, `days/${D2}/frames-002.jsonl`)).toBe(true);
    expect(assetNames(y.r).some((a) => a.includes('frames-002'))).toBe(false);
  });

  it('a boot that changed in the last 15 minutes deletes nothing, and an open boot file younger than 15 minutes waits', async () => {
    const f = fx();
    const dir = makeBoot(f, bootId(30, 110), { ago: 5 * 60_000 });
    const x = uploader(f);
    expect(await x.u.run()).toBe(0);
    expect(assetNames(x.r)).toEqual([]);
    expect(exists(dir, `days/${D2}/frames-000.jsonl.zst`)).toBe(true);
  });

  it('a symlink in place of a listed file, pointing outside, is never uploaded or deleted, and keeps the boot open', async () => {
    const f = fx();
    const boot = bootId(30, 111);
    const dir = makeBoot(f, boot);
    const rel = `days/${D2}/frames-000.jsonl.zst`;
    const target = join(f.outside, 'frames-000.jsonl.zst');
    writeFileSync(target, readFileSync(join(dir, rel)));
    unlinkSync(join(dir, rel));
    symlinkSync(target, join(dir, rel));
    age(dir);
    const x = uploader(f);
    await x.u.run();
    expect(lstatSync(join(dir, rel)).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(assetNames(x.r)).not.toContain(`${boot}.frames-000.jsonl.zst`);
    expect(x.status().kept).toEqual([{ key: `${boot}/${rel}`, why: 'not a plain file' }]);
    // The link keeps the whole boot from counting as ended: its other files stay too.
    expect(exists(dir, `days/${D2}/frames-001.jsonl.zst`)).toBe(true);
  });

  it('a symlinked day folder pointing outside keeps everything', async () => {
    const f = fx();
    const boot = bootId(30, 112);
    const dir = makeBoot(f, boot);
    const real = join(f.outside, 'day');
    rmSync(real, { recursive: true, force: true });
    spawnSync('cp', ['-r', join(dir, 'days', D2), real]);
    rmSync(join(dir, 'days', D2), { recursive: true });
    symlinkSync(real, join(dir, 'days', D2));
    age(dir);
    const x = uploader(f);
    await x.u.run();
    expect(readdirSync(real).sort()).toEqual(['delays-000.jsonl.zst', 'frames-000.jsonl.zst', 'frames-001.jsonl.zst', 'raw-000.jsonl.zst', 'releases-000.jsonl.zst']);
    expect(x.status().deleted).toBe(0);
  });

  it('a recorder folder that is itself a link deletes nothing', async () => {
    const f = fx();
    const real = join(f.outside, 'recorder');
    makeBoot({ ...f, root: real }, bootId(30, 125));
    rmSync(f.root, { recursive: true });
    symlinkSync(real, f.root);
    const x = uploader(f);
    expect(await x.u.run()).toBe(0);
    expect(assetNames(x.r).length).toBeGreaterThan(0);
    expect(x.status().deleted).toBe(0);
  });

  it('keeps every file when the day index is not uploaded', async () => {
    const f = fx();
    const dir = makeBoot(f, bootId(30, 113));
    const r = rig();
    const real = inproc(r);
    const noIndex: Transport = { put: (h, p, s) => (JSON.parse(h.text).file.startsWith('index-') ? Promise.resolve({ status: 502, json: { error: 'down' } }) : real.put(h, p, s)), check: real.check };
    const x = uploader(f, { r, transport: noIndex });
    expect(await x.u.run()).toBe(1);
    expect(assetNames(r).filter((a) => a.startsWith('index'))).toEqual([]);
    expect(exists(dir, `days/${D2}/frames-000.jsonl.zst`)).toBe(true);
    expect(x.status().deleted).toBe(0);
  });

  it('reads the asset back at delete time: one gone from GitHub since the upload keeps the file', async () => {
    const f = fx();
    const boot = bootId(30, 114);
    const dir = makeBoot(f, boot);
    const x = uploader(f, { deleteLocal: false });
    expect(await x.u.run()).toBe(0);
    const gone = [...x.r.gh.assets.values()].find((a) => a.name === `${boot}.frames-000.jsonl.zst`)!;
    x.r.gh.assets.delete(gone.id);
    const y = uploader(f, { r: x.r });
    await y.u.run();
    expect(exists(dir, `days/${D2}/frames-000.jsonl.zst`)).toBe(true);
    expect(exists(dir, `days/${D2}/frames-001.jsonl.zst`)).toBe(false);
  });

  it('a file whose bytes no longer match its manifest is kept, never uploaded or deleted', async () => {
    const f = fx();
    const boot = bootId(30, 115);
    const dir = makeBoot(f, boot);
    const rel = `days/${D2}/frames-001.jsonl.zst`;
    const b = readFileSync(join(dir, rel));
    b[b.length - 1] = b[b.length - 1]! ^ 1;
    writeFileSync(join(dir, rel), b);
    age(dir);
    const x = uploader(f);
    await x.u.run();
    expect(x.status().kept).toEqual([{ key: `${boot}/${rel}`, why: 'bytes differ from its manifest' }]);
    expect(assetNames(x.r)).not.toContain(`${boot}.frames-001.jsonl.zst`);
    expect(exists(dir, rel)).toBe(true);
  });

  it('a file changed after its upload (checked again at delete time) is kept', async () => {
    const f = fx();
    const boot = bootId(30, 116);
    const dir = makeBoot(f, boot);
    const x = uploader(f, { deleteLocal: false });
    expect(await x.u.run()).toBe(0);
    const rel = `days/${D2}/releases-000.jsonl.zst`;
    const b = readFileSync(join(dir, rel));
    b[b.length - 1] = b[b.length - 1]! ^ 1;
    writeFileSync(join(dir, rel), b);
    age(dir);
    const y = uploader(f, { r: x.r });
    await y.u.run();
    expect(exists(dir, rel)).toBe(true);
    expect(exists(dir, `days/${D2}/frames-000.jsonl.zst`)).toBe(false);
  });

  it('writes the delete into the state file before the file goes', async () => {
    const f = fx();
    const boot = bootId(30, 117);
    makeBoot(f, boot);
    const x = uploader(f);
    const saves: string[] = [];
    const save = x.u.save.bind(x.u);
    x.u.save = () => {
      save();
      const s = JSON.parse(readFileSync(join(f.stateDir, 'state.json'), 'utf8'));
      const rec = s.files[`${boot}/days/${D2}/frames-000.jsonl.zst`];
      if (rec?.deleting) saves.push(existsSync(join(f.root, boot, `days/${D2}/frames-000.jsonl.zst`)) ? 'marked, file still there' : 'marked after the file went');
    };
    await x.u.run();
    expect(saves).toEqual(['marked, file still there']);
  });

  it('a manual run for one day uploads only that day', async () => {
    const f = fx();
    const boot = bootId(30, 118);
    makeBoot(f, boot, { days: [D2, D1] });
    const x = uploader(f, { scope: D1, deleteLocal: false });
    expect(await x.u.run()).toBe(0);
    expect([...x.r.gh.releases.keys()]).toEqual([`rec-${D1}`]);
  });

  it('the same saved state is uploaded once and listed for every boot that restored it', async () => {
    const f = fx();
    const a = bootId(40, 119);
    const b = bootId(30, 120);
    makeBoot(f, a, { state: '{"same":1}' });
    makeBoot(f, b, { state: '{"same":1}' });
    const x = uploader(f);
    expect(await x.u.run()).toBe(0);
    expect(assetNames(x.r).filter((n) => n.includes('deployer-state'))).toEqual([`${a}.deployer-state.json.zst`]);
    const idx = [...x.r.gh.assets.values()].find((v) => v.name === 'index-1.json')!;
    const body = JSON.parse(Buffer.from(idx.bytes).toString().split('\n')[0]!);
    expect(body.files.find((e: { key: string }) => e.key === `${b}/deployer-state.json.zst`)).toMatchObject({ asset: `${a}.deployer-state.json.zst` });
  });

  it('moves to an overflow release past 900 assets', async () => {
    const f = fx();
    makeBoot(f, bootId(30, 121));
    mkdirSync(f.stateDir, { recursive: true });
    writeFileSync(join(f.stateDir, 'state.json'), JSON.stringify({ v: 1, files: {}, shared: {}, releases: { [D2]: { n: 0, count: 900 } }, journal: { offset: 0, days: {}, pending: null }, index: {}, failed_runs: 0 }));
    const x = uploader(f);
    expect(await x.u.run()).toBe(0);
    expect([...x.r.gh.releases.keys()]).toEqual([`rec-${D2}.1`]);
  });
});

describe('a file deleted by someone else during the run (RECORD-BUDGET)', () => {
  it('a file deleted between lstat and hash is skipped, counted and reported, and the run goes on', async () => {
    const f = fx();
    const boot = bootId(30, 140);
    const dir = makeBoot(f, boot);
    const gone = join(dir, `days/${D2}/frames-000.jsonl.zst`);
    fsHooks.beforeStream = (p) => {
      if (p === gone && existsSync(gone)) unlinkSync(gone);
    };
    const x = uploader(f);
    expect(await x.u.run()).toBe(0);
    // The others went up; the vanished one is neither kept nor failed. The delete changed the day folder just now, so
    // the boot is not settled and nothing is deleted in this run.
    expect(assetNames(x.r).filter((a) => a.startsWith(boot))).toEqual([`${boot}.frames-001.jsonl.zst`, `${boot}.manifest.json`, `${boot}.releases-000.jsonl.zst`]);
    expect(exists(dir, `days/${D2}/frames-001.jsonl.zst`)).toBe(true);
    expect(x.status()).toMatchObject({ ok: true, vanished: 1, uploaded: 4, deleted: 0, kept: [], last_error: null });
    expect(x.status().vanished_files).toEqual([`${boot}/days/${D2}/frames-000.jsonl.zst`]);
    expect(x.log.filter((l: string) => l.startsWith('Vanished before upload'))).toEqual([`Vanished before upload: ${boot}/days/${D2}/frames-000.jsonl.zst.`]);
    expect(x.log.at(-1)).toMatch(/ 1 vanished before upload, /);
    expect(x.state().files[`${boot}/days/${D2}/frames-000.jsonl.zst`]).toMatchObject({ vanished_at: NOW });
    // Recorded upstream: the day's signed index names it as vanished, with its listed sha256 and size.
    const listed = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).days[0].files.find((e: { path: string }) => e.path === `days/${D2}/frames-000.jsonl.zst`);
    const idx = indexBody(x.r, 1, `rec-${D2}`);
    expect(idx.vanished).toEqual([{ key: `${boot}/days/${D2}/frames-000.jsonl.zst`, boot, path: `days/${D2}/frames-000.jsonl.zst`, sha256: listed.sha256, bytes: listed.bytes, at: new Date(NOW).toISOString() }]);
    expect(idx.files.map((e: { key: string }) => e.key)).not.toContain(`${boot}/days/${D2}/frames-000.jsonl.zst`);
    // Reported once: a run after the folder settled neither counts it again nor tries to send it, and deletes the others.
    fsHooks.beforeStream = null;
    age(dir);
    const y = uploader(f, { r: x.r });
    expect(await y.u.run()).toBe(0);
    expect(y.status()).toMatchObject({ ok: true, vanished: 0, pending: 0, uploaded: 0, deleted: 2 });
    expect(exists(dir, `days/${D2}/frames-001.jsonl.zst`)).toBe(false);
    expect(exists(dir, `days/${D2}/releases-000.jsonl.zst`)).toBe(false);
  });

  it('a file deleted while its boot folder is walked keeps the boot open for the run (nothing deleted), and the run goes on', async () => {
    const f = fx();
    const boot = bootId(30, 141);
    const dir = makeBoot(f, boot);
    const day = join(dir, 'days', D2);
    const gone = join(day, 'frames-000.jsonl.zst');
    fsHooks.afterReaddir = (d) => {
      if (d === day && existsSync(gone)) unlinkSync(gone);
    };
    const x = uploader(f);
    expect(await x.u.run()).toBe(0);
    expect(assetNames(x.r).filter((a) => a.startsWith(boot))).toEqual([`${boot}.frames-001.jsonl.zst`, `${boot}.releases-000.jsonl.zst`]);
    expect(exists(dir, `days/${D2}/frames-001.jsonl.zst`)).toBe(true);
    expect(x.status()).toMatchObject({ ok: true, vanished: 1, deleted: 0 });
  });

  it('a waiting file deleted while the backlog is measured is left out of it, and the run ends normally', async () => {
    const f = fx();
    const boot = bootId(30, 142);
    const dir = makeBoot(f, boot);
    writeFileSync(f.journal, startLine(boot, new Date(NOW - 30 * H).toISOString()));
    // Sealed less than 15 minutes ago in the running boot: it waits for a later run.
    const young = join(dir, `days/${D2}/releases-000.jsonl.zst`);
    const t = (NOW - 60_000) / 1000;
    utimesSync(young, t, t);
    fsHooks.afterExists = (p, found) => {
      if (p === young && found) unlinkSync(young);
    };
    const x = uploader(f);
    expect(await x.u.run()).toBe(0);
    expect(x.status()).toMatchObject({ ok: true, pending: 0, running: false });
  });
});

/** The transport with the check replies for one file (by its signed file name) changed. */
const tamper = (base: Transport, file: string, edit: (j: Record<string, unknown>) => Record<string, unknown>, times = Infinity): Transport => {
  let left = times;
  return {
    put: base.put,
    check: async (h) => {
      const r = await base.check(h);
      if ((JSON.parse(h.text) as { file: string }).file !== file || left <= 0 || r.json === null) return r;
      left--;
      return { ...r, json: edit(r.json as Record<string, unknown>) };
    },
  };
};
const assetOf = (r: ReturnType<typeof rig>, name: string) => [...r.gh.assets.values()].find((a) => a.name === name)!;
const indexBody = (r: ReturnType<typeof rig>, n: number, release: string) => {
  const a = [...r.gh.assets.values()].find((v) => v.name === `index-${n}.json` && v.browser_download_url.includes(`/download/${release}/`))!;
  return JSON.parse(Buffer.from(a.bytes).toString().split('\n')[0]!);
};

describe('data review: the read-back and index gates', () => {
  /** Run 1 uploads and indexes with deletes off; `between` changes something; run 2 may delete. */
  const twoRuns = async (between: (x: ReturnType<typeof uploader>, boot: string) => Transport | void) => {
    const f = fx();
    const boot = bootId(30, 150);
    const dir = makeBoot(f, boot);
    const x = uploader(f, { deleteLocal: false });
    expect(await x.u.run()).toBe(0);
    const t = between(x, boot);
    const y = uploader(f, { r: x.r, ...(t ? { transport: t } : {}) });
    await y.u.run();
    return { dir, y };
  };

  it.each([
    ['its digest changed', (a: { digest: string | null }) => void (a.digest = `sha256:${'0'.repeat(64)}`)],
    ['its size changed', (a: { size: number }) => void (a.size += 1)],
    ['it is no longer "uploaded"', (a: { state: string }) => void (a.state = 'starter')],
  ])('keeps the local file when, at delete time, GitHub\'s asset shows %s', async (_why, change) => {
    const { dir, y } = await twoRuns((x, boot) => change(assetOf(x.r, `${boot}.frames-000.jsonl.zst`) as never));
    expect(exists(dir, `days/${D2}/frames-000.jsonl.zst`)).toBe(true);
    // The others pass every gate, so the delete run did run.
    expect(exists(dir, `days/${D2}/frames-001.jsonl.zst`)).toBe(false);
    expect(y.status().deleted).toBe(2);
  });

  it.each([
    ['match: false', (j: Record<string, unknown>) => ({ ...j, match: false })],
    ['another digest', (j: Record<string, unknown>) => ({ ...j, digest: `sha256:${'0'.repeat(64)}` })],
    ['another size', (j: Record<string, unknown>) => ({ ...j, size: (j['size'] as number) + 1 })],
    ['a state other than "uploaded"', (j: Record<string, unknown>) => ({ ...j, state: 'starter' })],
    ['another asset id', (j: Record<string, unknown>) => ({ ...j, asset_id: (j['asset_id'] as number) + 1 })],
  ])('keeps the local file when the delete-time check answers ok with %s (each condition on its own)', async (_why, edit) => {
    const { dir, y } = await twoRuns((x) => tamper(inproc(x.r), 'frames-000.jsonl.zst', edit));
    expect(exists(dir, `days/${D2}/frames-000.jsonl.zst`)).toBe(true);
    expect(exists(dir, `days/${D2}/frames-001.jsonl.zst`)).toBe(false);
    expect(y.status().deleted).toBe(2);
  });

  it('a confirmed file the standing index does not list yet is kept when the new index fails to go up', async () => {
    const f = fx();
    const a = bootId(40, 151);
    const dirA = makeBoot(f, a);
    const x = uploader(f, { deleteLocal: false });
    expect(await x.u.run()).toBe(0);
    // A second ended boot of the same day; its files are confirmed, but every index upload now fails.
    const b = bootId(30, 152);
    const dirB = makeBoot(f, b);
    const base = inproc(x.r);
    const t: Transport = {
      put: async (h, path, size) => ((JSON.parse(h.text) as { file: string }).file.startsWith('index-') ? { status: 502, json: { error: 'down' } } : base.put(h, path, size)),
      check: base.check,
    };
    const y = uploader(f, { r: x.r, transport: t });
    expect(await y.u.run()).toBe(1);
    expect(y.state().files[`${b}/days/${D2}/frames-000.jsonl.zst`]).toMatchObject({ verified: true });
    expect(exists(dirB, `days/${D2}/frames-000.jsonl.zst`)).toBe(true);
    expect(exists(dirB, `days/${D2}/releases-000.jsonl.zst`)).toBe(true);
    expect(exists(dirA, `days/${D2}/frames-000.jsonl.zst`)).toBe(false);
  });

  it('an upload whose read-back does not confirm it is not counted, not indexed, and its boot\'s manifest waits until it is', async () => {
    const f = fx();
    const boot = bootId(30, 153);
    const dir = makeBoot(f, boot);
    const r = rig();
    const key = `${boot}/days/${D2}/frames-000.jsonl.zst`;
    // Only the read-back right after the upload answers a mismatch.
    const x = uploader(f, { r, transport: tamper(inproc(r), 'frames-000.jsonl.zst', (j) => ({ ...j, match: false }), 1) });
    expect(await x.u.run()).toBe(1);
    expect(x.state().files[key]).toMatchObject({ verified: false });
    expect(indexBody(r, 1, `rec-${D2}`).files.map((e: { key: string }) => e.key)).not.toContain(key);
    expect(assetNames(r)).not.toContain(`${boot}.manifest.json`);
    expect(exists(dir, `days/${D2}/frames-000.jsonl.zst`)).toBe(true);
    // The next run (after the deletes above have settled) reads it back again, confirms it, lists it, and only then
    // sends the manifest.
    age(dir);
    const y = uploader(f, { r });
    expect(await y.u.run()).toBe(0);
    expect(y.state().files[key]).toMatchObject({ verified: true });
    expect(indexBody(r, 2, `rec-${D2}`).files.map((e: { key: string }) => e.key)).toContain(key);
    expect(assetNames(r)).toContain(`${boot}.manifest.json`);
  });

  it('a file curl cannot read because it was deleted while sent counts as vanished, not as a failure', async () => {
    const f = fx();
    const boot = bootId(30, 154);
    const dir = makeBoot(f, boot);
    const r = rig();
    const base = inproc(r);
    const t: Transport = {
      put: async (h, path, size) => {
        if ((JSON.parse(h.text) as { file: string }).file !== 'frames-000.jsonl.zst') return base.put(h, path, size);
        unlinkSync(path);
        return { status: 0, json: null, error: 'curl exit 26: read error' } as Reply;
      },
      check: base.check,
    };
    const x = uploader(f, { r, transport: t });
    expect(await x.u.run()).toBe(0);
    expect(x.status()).toMatchObject({ ok: true, vanished: 1, vanished_files: [`${boot}/days/${D2}/frames-000.jsonl.zst`], last_error: null });
    expect(exists(dir, `days/${D2}/frames-001.jsonl.zst`)).toBe(true);
  });

  it('after the state file is lost, a taken index number moves to the next free one, and deletes go on', async () => {
    const f = fx();
    const a = bootId(40, 155);
    makeBoot(f, a);
    const x = uploader(f, { deleteLocal: false });
    expect(await x.u.run()).toBe(0);
    rmSync(f.stateDir, { recursive: true, force: true });
    const b = bootId(30, 156);
    const dirB = makeBoot(f, b);
    const y = uploader(f, { r: x.r });
    expect(await y.u.run()).toBe(0);
    expect(y.status().kept).toEqual([]);
    expect(y.state().index[D2]).toMatchObject({ n: 2, verified: true });
    expect(indexBody(x.r, 2, `rec-${D2}`).files.map((e: { key: string }) => e.key)).toContain(`${b}/days/${D2}/frames-000.jsonl.zst`);
    expect(exists(dirB, `days/${D2}/frames-000.jsonl.zst`)).toBe(false);
  });
});

describe('ops review: the index read-back gate and a bounded state', () => {
  it('nothing of a day is deleted when that day\'s standing index no longer reads back', async () => {
    const f = fx();
    const boot = bootId(30, 160);
    const dir = makeBoot(f, boot);
    const x = uploader(f, { deleteLocal: false });
    expect(await x.u.run()).toBe(0);
    // The index asset is gone upstream; the state still holds it as verified with the same content, so no new index is sent.
    x.r.gh.assets.delete(assetOf(x.r, 'index-1.json').id);
    const y = uploader(f, { r: x.r });
    await y.u.run();
    expect(y.status().deleted).toBe(0);
    for (const t of ['frames-000', 'frames-001', 'releases-000']) expect(exists(dir, `days/${D2}/${t}.jsonl.zst`)).toBe(true);
  });

  it('a finished day moves out of state.json into its own file, its done boot is never read again, and a later record for that day is indexed with the archived ones', async () => {
    const f = fx();
    const D4 = day(4);
    const a = bootId(100, 161);
    makeBoot(f, a, { days: [D4] });
    const x = uploader(f);
    expect(await x.u.run()).toBe(0);
    const st = x.state();
    expect(Object.keys(st.files)).toEqual([]);
    expect(st.done_boots[a]).toBe(NOW);
    expect(st.index[D4]).toMatchObject({ n: 1, verified: true, archived: true, keys: [] });
    const archived = JSON.parse(readFileSync(join(f.stateDir, 'days', `${D4}.json`), 'utf8'));
    expect(Object.keys(archived.files).sort()).toEqual([`${a}/days/${D4}/frames-000.jsonl.zst`, `${a}/days/${D4}/frames-001.jsonl.zst`, `${a}/days/${D4}/releases-000.jsonl.zst`, `${a}/manifest.json`]);
    // A second run sends nothing and does not open the done boot's manifest.
    const assets = x.r.gh.assets.size;
    const seen: string[] = [];
    fsHooks.afterReaddir = (d) => void seen.push(d);
    const y = uploader(f, { r: x.r });
    expect(await y.u.run()).toBe(0);
    expect(x.r.gh.assets.size).toBe(assets);
    expect(seen.some((d) => d.startsWith(join(f.root, a)))).toBe(false);
    fsHooks.afterReaddir = null;
    // A new boot with files on that day: the next index lists the archived files and the new ones.
    const b = bootId(99, 162);
    makeBoot(f, b, { days: [D4] });
    const z = uploader(f, { r: x.r });
    expect(await z.u.run()).toBe(0);
    const keys = indexBody(x.r, 2, `rec-${D4}`).files.map((e: { key: string }) => e.key);
    expect(keys).toEqual(expect.arrayContaining([`${a}/days/${D4}/frames-000.jsonl.zst`, `${a}/manifest.json`, `${b}/days/${D4}/frames-000.jsonl.zst`, `${b}/manifest.json`]));
    expect(keys).toHaveLength(8);
    // Once more: the day stays archived with every record, and no index-3 goes up without the archived files.
    const w = uploader(f, { r: x.r });
    expect(await w.u.run()).toBe(0);
    expect(assetNames(x.r)).not.toContain('index-3.json');
    expect(w.state().index[D4]).toMatchObject({ n: 2, verified: true });
    const all = new Set([...Object.keys(JSON.parse(readFileSync(join(f.stateDir, 'days', `${D4}.json`), 'utf8')).files), ...Object.keys(w.state().files)]);
    expect(all.size).toBe(8);
  });

  it('a day of a boot that is not done is never archived, so its uploaded files are never re-listed as vanished', async () => {
    const f = fx();
    const D4 = day(4);
    const D3 = day(3);
    const a = bootId(100, 171);
    makeBoot(f, a, { days: [D4, D3], text: (d, t) => (d === D4 && t === 'releases-000' ? '{"u":"https://x.test/?api-key=PLANTEDVALUE"}\n' : lines(`${a}/${d}/${t}`)) });
    const x = uploader(f);
    await x.u.run();
    const y = uploader(f, { r: x.r });
    await y.u.run();
    const st = y.state();
    expect(st.done_boots[a]).toBeUndefined();
    expect(st.index[D3]?.archived).toBeUndefined();
    const body = indexBody(x.r, st.index[D3].n, `rec-${D3}`);
    expect(body.vanished ?? []).toEqual([]);
  });

  it('with deletes off nothing is archived or marked done, so switching deletes on later still deletes', async () => {
    const f = fx();
    const D4 = day(4);
    const a = bootId(100, 163);
    const dir = makeBoot(f, a, { days: [D4] });
    const x = uploader(f, { deleteLocal: false });
    expect(await x.u.run()).toBe(0);
    expect(x.state().done_boots).toEqual({});
    expect(x.state().index[D4].archived).toBeUndefined();
    const y = uploader(f, { r: x.r });
    expect(await y.u.run()).toBe(0);
    expect(y.status().deleted).toBe(3);
    expect(exists(dir, `days/${D4}/frames-000.jsonl.zst`)).toBe(false);
  });

  it('100 days of 1,000 uploaded files each run under the unit\'s 48 MB heap, and state.json stays small', () => {
    const base = join(tmp, 'heap');
    mkdirSync(join(base, 'recorder'), { recursive: true });
    const driver = join(base, 'driver.mjs');
    writeFileSync(driver, `
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
const up = await import(${JSON.stringify(new URL(`file://${MJS}`).href)});
const [base] = process.argv.slice(2);
const cfg = { root: join(base, 'recorder'), journal: join(base, 'journal.jsonl'), stateDir: join(base, 'state'), key: 'k', values: [], deleteLocal: true, scope: 'all' };
let id = 1;
// The watchdog, answering as GitHub would for exactly the signed bytes.
const transport = {
  put: async (h) => ({ status: 200, json: { ok: true, asset_id: id++, name: JSON.parse(h.text).file } }),
  check: async (h) => { const j = JSON.parse(h.text); return { status: 200, json: { ok: true, match: true, asset_id: j.asset_id, size: j.size, digest: 'sha256:' + j.sha256, state: 'uploaded' } }; },
};
const NOW = Date.now();
for (let d = 120; d > 20; d--) {
  const day = new Date(NOW - d * 86400000).toISOString().slice(0, 10);
  const u = new up.Uploader(cfg, { transport, workerActive: async () => false, now: () => NOW, log: () => {} });
  // What a day of uploads leaves in the state: 1,000 frames files of a boot since removed, each confirmed and deleted.
  const boot = (NOW - d * 86400000).toString(36) + '-' + (1000 + d);
  for (let i = 0; i < 1000; i++) {
    const path = 'days/' + day + '/frames-' + String(i).padStart(3, '0') + '.jsonl.zst';
    const sha256 = createHash('sha256').update(boot + path).digest('hex');
    u.state.files[boot + '/' + path] = { day, boot, path, release: 'rec-' + day, asset: boot + '.frames-' + String(i).padStart(3, '0') + '.jsonl.zst', asset_id: id++, size: 4000000 + i, sha256, verified: true, deleted_at: NOW - 3600000 };
  }
  u.save();
  if ((await u.run()) !== 0) { console.log('run failed for ' + day); process.exit(3); }
}
console.log(JSON.stringify({ state_bytes: statSync(join(cfg.stateDir, 'state.json')).size }));
`);
    const r = spawnSync(process.execPath, ['--max-old-space-size=48', driver, base], { encoding: 'utf8', timeout: 240_000 });
    expect(r.status, `${r.stdout}\n${r.stderr.slice(-2000)}`).toBe(0);
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1)!);
    // 100 days of index records, done boots and release counters; no file records.
    expect(out.state_bytes).toBeLessThan(200_000);
    expect(readdirSync(join(base, 'state', 'days'))).toHaveLength(100);
  }, 300_000);
});

describe('redaction scan', () => {
  it('keeps the same patterns as the worker (packages/worker/src/run/redact.ts)', () => {
    const src = readFileSync(join(ROOT, 'packages/worker/src/run/redact.ts'), 'utf8');
    const block = src.slice(src.indexOf('const PATTERNS: readonly RegExp[] = ['), src.indexOf('];', src.indexOf('const PATTERNS')));
    const worker = block.split('\n').slice(1).map((l) => l.trim().replace(/,$/, '')).filter(Boolean);
    expect(up.PATTERNS.map(String)).toEqual(worker);
    expect(worker).toHaveLength(3);
  });

  it('finds an unredacted key, a bot token or a stored value; "[redacted]" alone is not a hit', () => {
    expect(up.hitIn('https://rpc.test/?api-key=[redacted]&x=1', [])).toBeNull();
    expect(up.hitIn('https://g.alchemy.com/v2/[redacted]', [])).toBeNull();
    expect(up.hitIn('https://rpc.test/?api-key=abc123', [])).toBe('a credential-shaped value');
    expect(up.hitIn('https://rpc.test/?token=[redacted]x', [])).toBe('a credential-shaped value');
    expect(up.hitIn('https://g.alchemy.com/v2/abcdef', [])).toBe('a credential-shaped value');
    expect(up.hitIn('https://api.telegram.org/bot123:AAbb_cc/sendMessage', [])).toBe('a credential-shaped value');
    expect(up.hitIn(`{"x":"${SECRET}"}`, [SECRET])).toBe('a stored credential');
    expect(up.hitIn('{"x":"[redacted]"}', [SECRET])).toBeNull();
  });

  it('keeps a recording that holds a credential-shaped value or a stored credential, and never says which value', async () => {
    const f = fx();
    const boot = bootId(30, 122);
    const dir = makeBoot(f, boot, { text: (d, t) => (t === 'frames-000' ? `{"u":"https://rpc.test/?api-key=abc"}\n` : t === 'releases-000' ? `{"v":"${SECRET}"}\n` : lines(`${d}/${t}`)) });
    const x = uploader(f);
    await x.u.run();
    expect(x.status().kept).toEqual([
      { key: `${boot}/days/${D2}/frames-000.jsonl.zst`, why: 'holds a credential-shaped value' },
      { key: `${boot}/days/${D2}/releases-000.jsonl.zst`, why: 'holds a stored credential' },
    ]);
    // The manifest waits while a file it lists is kept back (its copy would be final); the index carries its content.
    expect(assetNames(x.r)).toEqual([`${boot}.frames-001.jsonl.zst`, 'index-1.json'].sort());
    expect(exists(dir, `days/${D2}/frames-000.jsonl.zst`)).toBe(true);
    expect(exists(dir, `days/${D2}/releases-000.jsonl.zst`)).toBe(true);
    expect(readFileSync(join(f.stateDir, 'status.json'), 'utf8')).not.toContain(SECRET);
    expect(x.log.join('\n')).not.toContain(SECRET);
  });

  it('finds a value that straddles the decompressor\'s pieces, in a long line', async () => {
    const p = join(tmp, 'long.jsonl.zst');
    writeFileSync(p, zstdCompressSync(Buffer.from(`{"a":"${'x'.repeat(65_530)}${SECRET}${'y'.repeat(200_000)}"}\n`)));
    expect(await up.scanFile(p, [SECRET])).toBe('a stored credential');
    writeFileSync(p, zstdCompressSync(Buffer.from(`{"a":"${'x'.repeat(65_530)}?key=abc${'y'.repeat(200_000)}"}\n`)));
    expect(await up.scanFile(p, [])).toBe('a credential-shaped value');
    writeFileSync(p, zstdCompressSync(Buffer.from(`{"a":"${'x'.repeat(300_000)}"}\n`)));
    expect(await up.scanFile(p, [SECRET])).toBeNull();
    // A damaged file cannot be checked: the scan fails, and the uploader keeps it ("holds unreadable text").
    writeFileSync(p, Buffer.from('not zstd at all'));
    await expect(up.scanFile(p, [])).rejects.toThrow();
  });
});

describe('journal days and the signed index', () => {
  it('uploads each ended UTC day of the journal once, never today, and resumes from the saved offset', async () => {
    const f = fx();
    // Days 3 and 2 back: always ended, whatever the time of day (yesterday is still in its 10-minute grace just after midnight).
    const E1 = day(3);
    const E2 = day(2);
    const at = (d: string, h: string) => `${d}T${h}:00:00.000Z`;
    const jl = (d: string, h: string, k: string) => `${JSON.stringify({ seq: 1, ts: at(d, h), boot: 'b', kind: k })}\n`;
    writeFileSync(f.journal, jl(E1, '01', 'start') + jl(E1, '23', 'decision') + jl(E2, '00', 'decision') + jl(E2, '12', 'stop') + jl(TODAY, '00', 'start'));
    const x = uploader(f);
    expect(await x.u.run()).toBe(0);
    expect(assetNames(x.r)).toEqual(['index-1.json', 'index-1.json', `journal-${E1}.jsonl.zst`, `journal-${E2}.jsonl.zst`].sort());
    const j2 = [...x.r.gh.assets.values()].find((a) => a.name === `journal-${E2}.jsonl.zst`)!;
    const { zstdDecompressSync } = await import('node:zlib');
    expect(zstdDecompressSync(Buffer.from(j2.bytes)).toString()).toBe(jl(E2, '00', 'decision') + jl(E2, '12', 'stop'));
    expect(x.state().journal.offset).toBe(Buffer.byteLength(jl(E1, '01', 'start') + jl(E1, '23', 'decision') + jl(E2, '00', 'decision') + jl(E2, '12', 'stop')));
    // The journal is never deleted, and a second run sends nothing new.
    expect(existsSync(f.journal)).toBe(true);
    const before = x.r.gh.assets.size;
    await uploader(f, { r: x.r }).u.run();
    expect(x.r.gh.assets.size).toBe(before);
  });

  it('the uploaded journal never carries the text of a refused command (typed by a person); the server\'s journal is unchanged', async () => {
    const f = fx();
    const E = day(3);
    const typed = '/sell everything to Alice 0412';
    const refused = `${JSON.stringify({ seq: 2, ts: `${E}T02:00:00.000Z`, boot: 'b', kind: 'decision', action: 'command_refused', reasons: [`command ${typed.slice(0, 32)} refused`, 'unknown command'] })}\n`;
    const many = `${JSON.stringify({ seq: 3, ts: `${E}T02:00:01.000Z`, boot: 'b', kind: 'decision', action: 'command_refused', reasons: ['4 more commands refused', 'not journaled one by one (over 6 a minute)'] })}\n`;
    const other = `${JSON.stringify({ seq: 4, ts: `${E}T03:00:00.000Z`, boot: 'b', kind: 'decision', action: 'skip', reasons: ['command refused'] })}\n`;
    const text = `${JSON.stringify({ seq: 1, ts: `${E}T01:00:00.000Z`, boot: 'b', kind: 'start' })}\n${refused}${many}${other}`;
    writeFileSync(f.journal, text);
    const x = uploader(f);
    expect(await x.u.run()).toBe(0);
    const { zstdDecompressSync } = await import('node:zlib');
    const sent = zstdDecompressSync(Buffer.from(assetOf(x.r, `journal-${E}.jsonl.zst`).bytes)).toString();
    expect(sent).not.toContain('Alice');
    expect(sent).not.toContain('/sell');
    const ls = sent.trimEnd().split('\n').map((l) => JSON.parse(l));
    expect(ls.map((l) => l.seq)).toEqual([1, 2, 3, 4]);
    expect(ls[1]).toEqual({ ...JSON.parse(refused), reasons: ['command [redacted] refused', 'unknown command'] });
    expect(ls[2]).toEqual(JSON.parse(many));
    expect(ls[3]).toEqual(JSON.parse(other));
    expect(readFileSync(f.journal, 'utf8')).toBe(text);
  });

  it('a day still inside its 10-minute grace after midnight waits', async () => {
    const f = fx();
    const at = (d: string, hm: string) => `${d}T${hm}:00.000Z`;
    const jl = (d: string, hm: string) => `${JSON.stringify({ seq: 1, ts: at(d, hm), boot: 'b', kind: 'decision' })}\n`;
    const now = Date.parse(`${TODAY}T00:05:00.000Z`);
    writeFileSync(f.journal, jl(D1, '23:59') + jl(TODAY, '00:01'));
    // The watchdog checks the signed time against its own clock: both run on this one.
    vi.useFakeTimers({ toFake: ['Date'], now });
    try {
      const x = uploader(f, { now });
      expect(await x.u.run()).toBe(0);
      expect(assetNames(x.r)).toEqual([]);
      vi.setSystemTime(now + 6 * 60_000);
      const later = uploader(f, { r: x.r, now: now + 6 * 60_000 });
      expect(await later.u.run()).toBe(0);
      expect(assetNames(x.r)).toEqual(['index-1.json', `journal-${D1}.jsonl.zst`]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the index lists every confirmed file with its asset and sha256, ends in an HMAC line, and a change is a new N (never a replacement)', async () => {
    const f = fx();
    const a = bootId(40, 123);
    makeBoot(f, a);
    const x = uploader(f, { deleteLocal: false });
    expect(await x.u.run()).toBe(0);
    const idx1 = [...x.r.gh.assets.values()].find((v) => v.name === 'index-1.json')!;
    const text = Buffer.from(idx1.bytes).toString();
    const [body, mac] = text.trimEnd().split('\n');
    expect(mac).toBe(`hmac-sha256=${createHmac('sha256', KEY).update(`RECORD-INDEX\n${body}`).digest('hex')}`);
    const j = JSON.parse(body!);
    expect(j).toMatchObject({ v: 1, kind: 'zeroed-record-index', day: D2, n: 1 });
    for (const e of j.files) {
      const asset = x.r.gh.assets.get(e.asset_id)!;
      expect(asset.name).toBe(e.asset);
      expect(asset.digest).toBe(`sha256:${e.sha256}`);
    }
    expect(j.boots[a].boot).toBe(a);
    // Unchanged: no new index. A new boot that day: index-2, and index-1 stays.
    await uploader(f, { r: x.r, deleteLocal: false }).u.run();
    expect(assetNames(x.r).filter((s) => s.startsWith('index'))).toEqual(['index-1.json']);
    makeBoot(f, bootId(30, 124));
    await uploader(f, { r: x.r, deleteLocal: false }).u.run();
    expect(assetNames(x.r).filter((s) => s.startsWith('index'))).toEqual(['index-1.json', 'index-2.json']);
    expect(Buffer.from([...x.r.gh.assets.values()].find((v) => v.name === 'index-1.json')!.bytes).toString()).toBe(text);
  });
});

describe('curl transport', () => {
  it('sends the file with its signed headers from curl\'s stdin, no Expect header, and the exact length', async () => {
    const f = fx();
    const file = join(f.outside, 'f.jsonl.zst');
    writeFileSync(file, zstdCompressSync(Buffer.from(lines('curl'))));
    const seen: { headers: Record<string, unknown>; bytes: number }[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      seen.push({ headers: req.headers, bytes: Buffer.concat(chunks).length });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true,"asset_id":7}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const size = statSync(file).size;
    const h = up.signHeader(KEY, { op: 'put', day: D2, release: `rec-${D2}`, boot: 'b-1', file: 'frames-000.jsonl.zst', size, sha256: sha(readFileSync(file)) }, Math.floor(NOW / 1000));
    const r = await up.watchdogTransport(url).put(h, file, size);
    server.close();
    expect(r).toEqual({ status: 200, json: { ok: true, asset_id: 7 } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.bytes).toBe(size);
    expect(seen[0]!.headers['content-length']).toBe(String(size));
    expect(seen[0]!.headers['expect']).toBeUndefined();
    expect(seen[0]!.headers['x-zeroed-record']).toBe(h.text);
    expect(seen[0]!.headers['x-zeroed-signature']).toBe(h.signature);
  });

  it('the signature is the watchdog\'s: RECORD over the header as sent', () => {
    const h = up.signHeader(KEY, { op: 'check', day: D2, release: `rec-${D2}`, boot: null, file: 'index-1.json', size: 5, sha256: 'a'.repeat(64), asset_id: 3 }, 1_800_000_000);
    expect(JSON.parse(h.text)).toMatchObject({ v: 1, op: 'check', t: 1_800_000_000, boot: null, asset_id: 3 });
    expect(h.signature).toBe(`t=1800000000,v1=${createHmac('sha256', KEY).update(`1800000000\nRECORD\n/record\n${h.text}`).digest('hex')}`);
  });
});

describe('command line', () => {
  it('does nothing and says so while the switch is off', () => {
    const r = spawnSync('node', [MJS, '--scope', 'all'], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } });
    // The default host-config path does not exist here: off.
    expect(r.stdout).toContain('Recording upload is off');
  });

  it('refuses a scope that is not "all" or a real day', () => {
    for (const s of ['2026-02-30', 'yesterday', '../x']) expect(spawnSync('node', [MJS, '--scope', s], { encoding: 'utf8' }).status).toBe(2);
  });
});

