// BT-WALL c: a failed publish never loses the published report (upload under another name first, then swap).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import { LATEST, NEXT, PREVIOUS } from '../src/publish.ts';

const dir = mkdtempSync(join(tmpdir(), 'publish-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

/** An in-memory `backtest` release behind GitHub's REST API; `failAt` fails the n-th changing call (1-based). */
const fakeGitHub = (initial: Record<string, string> | null, failAt = 0) => {
  let nextId = 1;
  const assets = new Map<number, { name: string; body: string }>();
  for (const [name, body] of Object.entries(initial ?? {})) assets.set(nextId++, { name, body });
  let exists = initial !== null;
  let changes = 0;
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  const release = () => ({ id: 7, upload_url: 'https://uploads.github.com/repos/o/r/releases/7/assets{?name,label}', assets: [...assets].map(([id, a]) => ({ id, name: a.name })) });
  const taken = (name: string) => [...assets.values()].some((a) => a.name === name);
  const fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    if (method !== 'GET' && ++changes === failAt) return new Response('boom', { status: 502 });
    if (method === 'GET' && url.pathname.endsWith('/releases/tags/backtest')) return exists ? json(release()) : new Response('', { status: 404 });
    if (method === 'POST' && url.pathname.endsWith('/releases')) {
      exists = true;
      return json(release(), 201);
    }
    if (method === 'POST' && url.host === 'uploads.github.com') {
      const name = url.searchParams.get('name')!;
      if (taken(name)) return json({ message: 'already_exists' }, 422);
      const id = nextId++;
      assets.set(id, { name, body: String(init.body) });
      return json({ id, name }, 201);
    }
    const m = /\/releases\/assets\/(\d+)$/.exec(url.pathname);
    if (m !== null && assets.has(Number(m[1]))) {
      const id = Number(m[1]);
      if (method === 'DELETE') {
        assets.delete(id);
        return new Response(null, { status: 204 });
      }
      if (method === 'PATCH') {
        const name = (JSON.parse(String(init.body)) as { name: string }).name;
        if (taken(name)) return json({ message: 'already_exists' }, 422);
        assets.get(id)!.name = name;
        return json({ id, name });
      }
    }
    return new Response('not found', { status: 404 });
  };
  const byName = () => Object.fromEntries([...assets.values()].map((a) => [a.name, a.body]));
  return { fetch, byName, changes: () => changes };
};

const report = (n: number) => {
  const body = `${JSON.stringify({ schemaVersion: 1, mode: 'backtest', codeCommit: 'a'.repeat(40), n })}\n`;
  const file = join(dir, `report-${n}.json`);
  writeFileSync(file, body);
  return { file, body };
};

/** Runs the publish script itself, its network replaced by the fake. */
const publish = async (gh: ReturnType<typeof fakeGitHub>, file: string): Promise<unknown> => {
  vi.stubGlobal('fetch', gh.fetch);
  vi.stubEnv('GITHUB_TOKEN', 'test-token');
  vi.stubEnv('GITHUB_EVENT_NAME', 'workflow_dispatch');
  vi.stubEnv('GITHUB_HEAD_REF', '');
  const argv = process.argv;
  process.argv = [argv[0]!, 'publish-report.ts', file, 'o/r'];
  vi.resetModules();
  try {
    await import('../scripts/publish-report.ts');
    return null;
  } catch (e) {
    return e;
  } finally {
    process.argv = argv;
    vi.unstubAllEnvs();
  }
};

describe('publishing the backtest report (BT-WALL c)', () => {
  test('publishes over an old report, and on a first publish creates the release', async () => {
    const gh = fakeGitHub({ [LATEST]: 'old' });
    const r = report(1);
    expect(await publish(gh, r.file)).toBeNull();
    expect(gh.byName()).toEqual({ [LATEST]: r.body });
    const fresh = fakeGitHub(null);
    expect(await publish(fresh, r.file)).toBeNull();
    expect(fresh.byName()).toEqual({ [LATEST]: r.body });
  });

  test('a failure at any step fails the publish and never loses the published report; the next publish repairs', async () => {
    const r = report(2);
    const steps = fakeGitHub({ [LATEST]: 'old' });
    await publish(steps, r.file);
    const n = steps.changes();
    expect(n).toBeGreaterThan(1);
    for (let k = 1; k <= n; k++) {
      const gh = fakeGitHub({ [LATEST]: 'old' }, k);
      expect(await publish(gh, r.file), `step ${k}`).toBeInstanceOf(Error);
      const after = gh.byName();
      // Either the old report or the new one holds the name; the new one, until it does, sits under another name.
      expect([...Object.values(after)].includes('old') || after[LATEST] === r.body, `step ${k}: ${JSON.stringify(after)}`).toBe(true);
      expect(after[LATEST] === 'old' || after[LATEST] === r.body, `step ${k}: ${JSON.stringify(after)}`).toBe(true);
      // The next publish, with nothing failing, leaves only the newest report.
      const again = report(3);
      const healed = fakeGitHub(after);
      expect(await publish(healed, again.file), `step ${k} repair`).toBeNull();
      expect(healed.byName(), `step ${k} repair`).toEqual({ [LATEST]: again.body });
    }
  });

  test('left-overs of a publish that failed between its renames are repaired: the previous report is restored first', async () => {
    const gh = fakeGitHub({ [PREVIOUS]: 'old', [NEXT]: 'half' });
    const r = report(4);
    expect(await publish(gh, r.file)).toBeNull();
    expect(gh.byName()).toEqual({ [LATEST]: r.body });
    // Failing the restore keeps the previous report where it is.
    const failing = fakeGitHub({ [PREVIOUS]: 'old' }, 1);
    expect(await publish(failing, r.file)).toBeInstanceOf(Error);
    expect(failing.byName()).toEqual({ [PREVIOUS]: 'old' });
    // Restored before anything else: an upload that then fails leaves the old report published, never nothing.
    const late = fakeGitHub({ [PREVIOUS]: 'old' }, 2);
    expect(await publish(late, r.file)).toBeInstanceOf(Error);
    expect(late.byName()).toEqual({ [LATEST]: 'old' });
  });
});
