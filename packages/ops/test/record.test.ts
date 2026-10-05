// RECORD-UPLOAD, watchdog side: the signed header and its allowlist, the one-use nonce, the destination check, the
// fixed-length upload with its read-back by id, the 422 rules, op check, and the route staying outside the Durable Object.
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sign, verifySignature } from '../src/watchdog/logic.ts';
import { assetName, NONCE_TTL_S, parseRecordHeader, RECORD_MAX_BYTES, recordSignedText, takeNonceIn, type RecordHeader } from '../src/watchdog/record.ts';
import worker, { type Env } from '../src/watchdog/worker.ts';
import { fakeGitHub, KEY, REPO, rig, sha } from './record-fakes.ts';

afterEach(() => vi.unstubAllGlobals());

let nonceN = 0;
const header = (over: Partial<RecordHeader> & Record<string, unknown> = {}, body = 'frames bytes\n') => ({
  v: 1, op: 'put', t: Math.floor(Date.now() / 1000), nonce: (++nonceN).toString(16).padStart(32, '0'), day: '2026-10-05', release: 'rec-2026-10-05',
  boot: 'mg3abc12-4242', file: 'frames-000.jsonl.zst', size: Buffer.byteLength(body), sha256: sha(body), ...over,
});

/** A request as the host sends it: the header JSON, its RECORD signature, and the body. */
async function send(r: ReturnType<typeof rig>, h: Record<string, unknown>, body: string | null = 'frames bytes\n', o: { sigMethod?: string; sigPath?: string; key?: string; path?: string; len?: string } = {}) {
  const text = JSON.stringify(h);
  const t = Number(h['t']);
  const sig = createHmac('sha256', o.key ?? KEY).update(`${t}\n${o.sigMethod ?? 'RECORD'}\n${o.sigPath ?? '/record'}\n${text}`).digest('hex');
  const headers: Record<string, string> = { 'x-zeroed-record': text, 'x-zeroed-signature': `t=${t},v1=${sig}` };
  if (body !== null) headers['content-length'] = o.len ?? String(Buffer.byteLength(body));
  const res = await worker.fetch(new Request(`https://w.test${o.path ?? '/record'}`, { method: 'POST', headers, ...(body === null ? {} : { body, duplex: 'half' }) } as RequestInit), r.env);
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

describe('record header', () => {
  it('signs "t\\nRECORD\\n/record\\n<header>"; a RECORD signature never verifies as POST, and a POST one never as RECORD', async () => {
    const text = JSON.stringify(header());
    const t = 1_800_000_000;
    const rec = await sign(KEY, t, 'RECORD', '/record', text);
    expect(rec).toBe(createHmac('sha256', KEY).update(recordSignedText(t, text)).digest('hex'));
    expect(await verifySignature(`t=${t},v1=${rec}`, 'RECORD', '/record', text, KEY, t)).toBe(t);
    expect(await verifySignature(`t=${t},v1=${rec}`, 'POST', '/heartbeat', text, KEY, t)).toBeNull();
    expect(await verifySignature(`t=${t},v1=${rec}`, 'POST', '/record', text, KEY, t)).toBeNull();
    const post = await sign(KEY, t, 'POST', '/record', text);
    expect(await verifySignature(`t=${t},v1=${post}`, 'RECORD', '/record', text, KEY, t)).toBeNull();
  });

  it('takes only the allowlisted files, the release of its own day, and a size under the body limit', () => {
    const ok = (o: Record<string, unknown>) => parseRecordHeader(JSON.stringify(header(o))) !== null;
    expect(ok({})).toBe(true);
    expect(ok({ file: 'releases-012.jsonl.zst' })).toBe(true);
    expect(ok({ file: 'manifest.json' })).toBe(true);
    expect(ok({ file: 'deployer-state.json.zst' })).toBe(true);
    expect(ok({ file: 'deployer-state.json' })).toBe(true);
    expect(ok({ boot: null, file: 'journal-2026-10-05.jsonl.zst' })).toBe(true);
    expect(ok({ boot: null, file: 'index-3.json' })).toBe(true);
    expect(ok({ release: 'rec-2026-10-05.1' })).toBe(true);
    // Never raw, delays, older seed files, or anything else.
    for (const file of ['raw-000.jsonl.zst', 'delays-000.jsonl.zst', 'pre-000.jsonl.zst', 'frames-000.jsonl', '../manifest.json', 'frames-0000.jsonl.zst', 'journal.jsonl', 'saved-state.zst']) expect(ok({ file }), file).toBe(false);
    expect(ok({ boot: null, file: 'frames-000.jsonl.zst' })).toBe(false);
    expect(ok({ file: 'journal-2026-10-05.jsonl.zst' })).toBe(false);
    expect(ok({ boot: null, file: 'journal-2026-10-04.jsonl.zst' })).toBe(false);
    expect(ok({ boot: null, file: 'index-0.json' })).toBe(false);
    expect(ok({ boot: 'a/b' })).toBe(false);
    expect(ok({ boot: '' })).toBe(false);
    expect(ok({ release: 'rec-2026-10-04' })).toBe(false);
    expect(ok({ release: 'latest' })).toBe(false);
    expect(ok({ day: '2026-02-30', release: 'rec-2026-02-30' })).toBe(false);
    expect(ok({ size: RECORD_MAX_BYTES })).toBe(true);
    expect(ok({ size: RECORD_MAX_BYTES + 1 })).toBe(false);
    expect(ok({ size: 0 })).toBe(false);
    expect(ok({ sha256: 'A'.repeat(64) })).toBe(false);
    expect(ok({ nonce: 'short' })).toBe(false);
    expect(ok({ v: 2 })).toBe(false);
    expect(ok({ extra: 1 })).toBe(false);
    expect(ok({ asset_id: 5 })).toBe(false);
    expect(ok({ op: 'check' })).toBe(false);
    expect(ok({ op: 'check', asset_id: 5 })).toBe(true);
    expect(ok({ op: 'delete', asset_id: 5 })).toBe(false);
    expect(assetName({ boot: 'b1', file: 'frames-000.jsonl.zst' })).toBe('b1.frames-000.jsonl.zst');
    expect(assetName({ boot: null, file: 'index-2.json' })).toBe('index-2.json');
  });

  it('nonces are one use, kept 15 minutes, and the book is pruned', () => {
    const now = 1_800_000_000;
    const a = takeNonceIn({}, 'n1', now, now)!;
    expect(takeNonceIn(a, 'n1', now, now + 10)).toBeNull();
    expect(takeNonceIn(a, 'n1', now, now + NONCE_TTL_S + 1)).toEqual({ n1: now });
    expect(Object.keys(takeNonceIn({ old: now - NONCE_TTL_S - 1, fresh: now }, 'n2', now, now)!)).toEqual(['fresh', 'n2']);
  });
});

describe('POST /record', () => {
  it('uploads to a new prerelease that never becomes latest, reads the asset back by id, and runs outside the Durable Object', async () => {
    const r = rig();
    const res = await send(r, header());
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, name: 'mg3abc12-4242.frames-000.jsonl.zst', size: 13, state: 'uploaded', digest: `sha256:${sha('frames bytes\n')}` });
    expect(r.gh.releases.get('rec-2026-10-05')?.body).toMatchObject({ tag_name: 'rec-2026-10-05', prerelease: true, make_latest: 'false' });
    expect(r.gh.calls.filter((c) => c.startsWith('POST UP'))).toHaveLength(1);
    expect(r.gh.calls).toContain(`GET /repos/${REPO}/releases/assets/${res.json!['asset_id']}`);
    expect(r.doPaths).toEqual(['/record-nonce']);
    // The reply names no token, repository or URL.
    expect(JSON.stringify(res.json)).not.toMatch(/github_pat|zeroed-data|https?:/);
  });

  it('refuses a bad or missing signature, a POST signature, another key and a stale time, before reading the body', async () => {
    const r = rig();
    let read = false;
    const body = () => new ReadableStream({ pull: (c) => ((read = true), c.close()) }, { highWaterMark: 0 });
    const h = header();
    const text = JSON.stringify(h);
    for (const sig of [null, `t=${h.t},v1=${'0'.repeat(64)}`, `t=${h.t},v1=${await sign(KEY, h.t, 'POST', '/record', text)}`, `t=${h.t},v1=${await sign('other', h.t, 'RECORD', '/record', text)}`, `t=${h.t - 400},v1=${await sign(KEY, h.t - 400, 'RECORD', '/record', text)}`]) {
      const headers: Record<string, string> = { 'x-zeroed-record': text, 'content-length': '13' };
      if (sig) headers['x-zeroed-signature'] = sig;
      const res = await worker.fetch(new Request('https://w.test/record', { method: 'POST', headers, body: body(), duplex: 'half' } as RequestInit), r.env);
      expect(res.status).toBe(401);
    }
    expect(read).toBe(false);
    expect(r.gh.calls).toEqual([]);
    expect(r.doPaths).toEqual([]);
    // A header that does not match its signed time, or no header at all.
    expect((await send(r, { ...header(), t: h.t }, 'x', { len: '1' })).status).toBe(400);
  });

  it('a RECORD signature never opens /heartbeat, and a heartbeat signature never opens /record', async () => {
    const r = rig();
    const hb = JSON.stringify({ seq: 1, ts: 1, boot: 'b', git_sha: 'a', signer: 's', paused: false, unresolved_intents: { count: 0 } });
    const t = Math.floor(Date.now() / 1000);
    const res = await worker.fetch(new Request('https://w.test/heartbeat', { method: 'POST', body: hb, headers: { 'x-zeroed-signature': `t=${t},v1=${await sign(KEY, t, 'RECORD', '/heartbeat', hb)}` } }), r.env);
    expect(res.status).toBe(401);
    expect((await send(r, header(), 'frames bytes\n', { sigMethod: 'POST' })).status).toBe(401);
    expect((await send(r, header(), 'frames bytes\n', { sigPath: '/heartbeat' })).status).toBe(401);
  });

  it('refuses a replayed nonce', async () => {
    const r = rig();
    const h = header();
    expect((await send(r, h)).status).toBe(200);
    const again = await send(r, h);
    expect(again.status).toBe(409);
    expect(again.json).toEqual({ error: 'replayed request' });
    expect(r.gh.calls.filter((c) => c.startsWith('POST UP'))).toHaveLength(1);
  });

  it('refuses a body whose length differs from the signed size, before taking the nonce', async () => {
    const r = rig();
    expect((await send(r, header(), 'frames bytes\n', { len: '12' })).status).toBe(400);
    expect((await send(r, header(), null)).status).toBe(400);
    expect(r.doPaths).toEqual([]);
    expect(r.gh.calls).toEqual([]);
  });

  it('writes nothing to a public repository, to this code repository, to a renamed one, or without the setup', async () => {
    for (const [gh, env, reason] of [
      [fakeGitHub({ private: false }), {}, 'DATA_REPO is not private'],
      [fakeGitHub({ full_name: 'owner-x/other' }), {}, 'repository check names another repository'],
      [fakeGitHub(), { DATA_REPO: 'MacDarenz-Droid/meme-snipe' }, 'DATA_REPO is the public code repository'],
      [fakeGitHub(), { DATA_REPO: '' }, 'DATA_REPO is not set'],
      [fakeGitHub(), { REPORTS_TOKEN: '' }, 'REPORTS_TOKEN is not set'],
    ] as const) {
      const r = rig(gh, env as Partial<Env>);
      const res = await send(r, header());
      expect(res.status, reason).toBe(503);
      expect(res.json).toEqual({ error: reason });
      expect(gh.calls.filter((c) => !c.endsWith(`/repos/${REPO}`) && !c.includes('/repos/owner-x/other'))).toEqual([]);
    }
  });

  it('deletes an asset whose bytes differ from the signed file, or whose size does', async () => {
    for (const knob of ['corrupt', 'wrongSize'] as const) {
      const r = rig();
      r.gh.knobs[knob] = true;
      const res = await send(r, header());
      expect(res.status, knob).toBe(422);
      expect(String(res.json!['error'])).toContain('asset deleted');
      expect(r.gh.assets.size, knob).toBe(0);
    }
  });

  it('keeps an asset GitHub gave no digest for, and does not count it as uploaded', async () => {
    const r = rig();
    r.gh.knobs.noDigest = true;
    const res = await send(r, header());
    expect(res.status).toBe(502);
    expect(res.json).toMatchObject({ digest: null, asset_id: expect.any(Number) });
    expect(res.json!['ok']).toBeUndefined();
    expect(r.gh.assets.size).toBe(1);
  });

  it('a name that exists: the same finished bytes count as uploaded without sending them again', async () => {
    const r = rig();
    expect((await send(r, header())).status).toBe(200);
    const again = await send(r, header());
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ ok: true, existed: true });
    expect(r.gh.calls.filter((c) => c.startsWith('POST UP'))).toHaveLength(1);
    // Not in the release listing: the upload's 422 finds it by name.
    r.gh.knobs.listAssetsInRelease = false;
    const third = await send(r, header());
    expect(third.json).toMatchObject({ ok: true, existed: true });
    expect(r.gh.calls.filter((c) => c.startsWith('POST UP'))).toHaveLength(2);
  });

  it('a name that exists with other finished bytes is never replaced', async () => {
    const r = rig();
    expect((await send(r, header())).status).toBe(200);
    const other = 'other bytes!\n';
    const res = await send(r, header({ size: Buffer.byteLength(other), sha256: sha(other) }), other);
    expect(res.status).toBe(409);
    expect([...r.gh.assets.values()].map((a) => Buffer.from(a.bytes).toString())).toEqual(['frames bytes\n']);
    r.gh.knobs.listAssetsInRelease = false;
    expect((await send(r, header({ size: Buffer.byteLength(other), sha256: sha(other) }), other)).status).toBe(409);
    expect(r.gh.assets.size).toBe(1);
  });

  it('an unfinished upload under the name is removed: sent at once when listed, otherwise the host sends again', async () => {
    const r = rig();
    r.gh.knobs.unfinished = true;
    expect((await send(r, header())).status).toBe(422); // not "uploaded": deleted as not the signed bytes
    r.gh.knobs.unfinished = true;
    r.gh.knobs.noDigest = true;
    expect((await send(r, header())).status).toBe(502); // no digest: kept, unfinished
    r.gh.knobs.unfinished = false;
    r.gh.knobs.noDigest = false;
    const res = await send(r, header());
    expect(res.json).toMatchObject({ ok: true, state: 'uploaded' });
    expect([...r.gh.assets.values()].map((a) => a.state)).toEqual(['uploaded']);
    // Found only through the upload's 422: removed, and the host is told to send again.
    const r2 = rig();
    r2.gh.knobs.unfinished = true;
    r2.gh.knobs.noDigest = true;
    await send(r2, header());
    r2.gh.knobs.unfinished = false;
    r2.gh.knobs.noDigest = false;
    r2.gh.knobs.listAssetsInRelease = false;
    const again = await send(r2, header());
    expect(again.status).toBe(503);
    expect(again.json).toMatchObject({ retry: true });
    expect(r2.gh.assets.size).toBe(0);
  });

  it('a body shorter than the signed size fails the upload', async () => {
    const r = rig();
    const h = header({ size: 20 });
    const res = await send(r, h, 'frames bytes\n', { len: '20' });
    expect(res.status).toBe(502);
    expect(r.gh.assets.size).toBe(0);
  });

  it('op check reads the asset back by id under the signed name and release', async () => {
    const r = rig();
    const put = await send(r, header());
    const id = put.json!['asset_id'] as number;
    const ok = await send(r, header({ op: 'check', asset_id: id }), null);
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ ok: true, asset_id: id, size: 13, state: 'uploaded', digest: `sha256:${sha('frames bytes\n')}`, match: true });
    expect((await send(r, header({ op: 'check', asset_id: id, sha256: sha('x') }), null)).json).toMatchObject({ match: false });
    expect((await send(r, header({ op: 'check', asset_id: id, file: 'frames-001.jsonl.zst' }), null)).status).toBe(409);
    expect((await send(r, header({ op: 'check', asset_id: id, release: 'rec-2026-10-05.1' }), null)).status).toBe(409);
    expect((await send(r, header({ op: 'check', asset_id: 99999 }), null)).status).toBe(404);
  });

  it('the Worker routes only POST /record to the record handler; the nonce path is never reachable from outside', async () => {
    const r = rig();
    for (const [method, path] of [['POST', '/record-nonce'], ['GET', '/record'], ['PUT', '/record'], ['POST', '/record/'], ['POST', '/check']] as const) {
      const res = await worker.fetch(new Request(`https://w.test${path}`, { method, ...(method === 'GET' ? {} : { body: '{}' }) }), r.env);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect(r.doPaths).toEqual([]);
  });
});
