// BT-1e: the owner-program supplement script (scripts/owner-programs.ts) on a fixture dataset: owners, the dry run, a
// fetch against a local RPC, and the RPC URL and key kept out of every output and file, failures included.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { decodeBase58, encodeBase58, isOnCurve, pumpPoolAuthority, type Address } from '../../core/src/chain/index.ts';
import { bps } from '../../core/src/units/index.ts';
import { manifestHash } from '../src/dataset/dataset.ts';
import { readOwnerPrograms, OWNER_PROGRAMS_FILE, OWNER_PROGRAMS_MANIFEST } from '../src/dataset/owner-programs.ts';
import type { AmmSwapRow, EventRow, MovementRow } from '../src/dataset/rows.ts';
import { writeDataset } from './dataset-writer.ts';

const SCRIPT = fileURLToPath(new URL('../scripts/owner-programs.ts', import.meta.url));
const raw = (label: string): string => encodeBase58(createHash('sha256').update(label).digest());
const find = (label: string, onCurve: boolean): string => {
  for (let k = 0; ; k++) {
    const a = raw(`${label}:${k}`);
    if (isOnCurve(decodeBase58(a)) === onCurve) return a;
  }
};
const pda = (label: string) => find(label, false);
const wallet = (label: string) => find(label, true);

const T0 = 1_759_536_000; // 2025-10-04T00:00:00Z
const amm = (k: number, owner: string): AmmSwapRow => ({
  kind: 'amm', slot: BigInt(1000 + k), blockTime: T0 + k, txIdx: 1, evIdx: 0, signature: `s${k}`, pool: raw('pool'), baseMint: raw('mint'), quoteMint: 'Q', side: 'buy',
  mode: 'exact-base', amount: 1n, baseAmount: 1n, quoteAmount: 0n, userQuote: 0n, pre: { baseReserve: 1n, quoteVault: 0n, virtualQuoteReserves: 0n },
  fees: { split: { lp: bps(0), protocol: bps(0), creator: bps(0) }, buybackFeeBps: bps(0), instruction: 'v1' }, baseSupply: 0n, ixName: 'buy', user: 'SIGNER',
  userTokenAccount: raw(`ata${k}`), userTokenOwner: owner, lpFee: 0n, quoteLpAdjusted: 0n, extraHex: '',
});
const move = (k: number, from: string, to: string): MovementRow => ({
  slot: BigInt(2000 + k), blockTime: T0 + 100 + k, txIdx: 2, outerIx: 0, innerIx: null, mint: raw('mint'), kind: 'transfer', fromOwner: from, toOwner: to, amount: 1n,
  fromAccount: from === '' ? '' : raw(`fa${k}`), toAccount: to === '' ? '' : raw(`ta${k}`),
});

// 150 PDA owners across trades and movements (twice, to check uniqueness), plus wallets and empty owners that must not count.
const PDAS = Array.from({ length: 150 }, (_, k) => pda(`owner${k}`));
const PROGRAM = raw('locker-program');
const KEY = `TESTKEY${createHash('sha256').update(String(Math.random())).digest('hex')}`;

let tmp = '';
let dataset = '';
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'bt1e-'));
  dataset = join(tmp, 'data-2025-10-04-2025-10-05');
  writeDataset(dataset, [...PDAS.slice(0, 100).map((o, k) => amm(k, o)), amm(200, wallet('w1')), amm(201, ''), amm(202, PDAS[0]!)], {
    movements: [...PDAS.slice(100).map((o, k) => move(k, wallet(`w${k}`), o)), move(90, PDAS[1]!, ''), move(91, '', wallet('w2'))],
  });
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

type Run = { code: number | null; out: string; err: string };
const run = (args: string[], env: Record<string, string> = {}): Promise<Run> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings', SCRIPT, ...args], { env: { PATH: process.env['PATH'] ?? '', ...env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err }));
  });

/** A local getMultipleAccounts endpoint; `reply` decides each answer. */
const rpc = async (reply: (addresses: string[], url: string) => { status: number; body: string }) => {
  const calls: { addresses: string[]; url: string }[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const addresses = (JSON.parse(body) as { params: [string[]] }).params[0];
      calls.push({ addresses, url: req.url ?? '' });
      const r = reply(addresses, req.url ?? '');
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(r.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/?api-key=${KEY}`;
  return { url, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
};

const filesUnder = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)) : []);
const noKey = (r: Run, dirs: string[]) => {
  expect(r.out + r.err).not.toContain(KEY);
  expect(r.out + r.err).not.toContain('127.0.0.1');
  for (const f of dirs.flatMap(filesUnder)) expect(readFileSync(f, 'utf8'), f).not.toContain(KEY);
};

describe('owners', () => {
  test('lists every off-curve owner of trades and movements once, sorted; wallets and empty owners are left out', async () => {
    const r = await run(['owners', '--dataset', dataset]);
    expect(r.code, r.err).toBe(0);
    expect(r.out.trim().split('\n')).toEqual([...PDAS].sort());
  });

  test('checks SHA256SUMS when the release has one, and refuses a changed file', async () => {
    const flat = join(tmp, 'flat');
    mkdirSync(flat);
    // The release layout: day files flattened to DAY__name, with SHA256SUMS over everything.
    for (const f of filesUnder(dataset)) {
      const rel = f.slice(dataset.length + 1);
      copyFileSync(f, join(flat, rel.startsWith('days/') ? `${rel.split('/')[1]}__${rel.split('/')[2]}` : rel));
    }
    const sums = readdirSync(flat).sort().map((n) => `${createHash('sha256').update(readFileSync(join(flat, n))).digest('hex')}  ${n}`).join('\n');
    writeFileSync(join(flat, 'SHA256SUMS'), `${sums}\n`);
    const ok = await run(['owners', '--dataset', flat]);
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out.trim().split('\n')).toHaveLength(150);
    const day = readdirSync(flat).find((n) => n.includes('__amm_trades'))!;
    writeFileSync(join(flat, day), Buffer.concat([readFileSync(join(flat, day)), Buffer.from('x')]));
    const bad = await run(['owners', '--dataset', flat]);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/sha256 .* does not match SHA256SUMS/);
  });

  test("lists a CreatePoolEvent's off-curve creator, which the holder book credits; not pump's pool authority or a wallet", async () => {
    const pool = (k: number, creator: string, mintKey: 'mint' | 'base_mint', mint: string): EventRow => ({
      kind: 'event', slot: BigInt(3000 + k), blockTime: T0 + 200 + k, txIdx: 3, evIdx: 0, signature: `p${k}`, program: 'pump_amm', event: 'CreatePoolEvent',
      fields: { [mintKey]: mint, pool: raw(`pool${k}`), creator, base_amount_in: '1', pool_base_amount: '1', user_base_token_account: raw(`ub${k}`) },
    });
    const m2 = raw('mint2');
    const creators = join(tmp, 'creators');
    writeDataset(creators, [
      pool(0, PDAS[5]!, 'base_mint', raw('mint')), pool(1, pda('creator-pda'), 'base_mint', m2),
      pool(2, pumpPoolAuthority(m2 as Address), 'base_mint', m2), pool(3, wallet('creator-wallet'), 'base_mint', m2), pool(4, '', 'base_mint', m2),
      { ...pool(5, pda('other-event'), 'base_mint', m2), event: 'CreateEvent' },
    ]);
    expect(isOnCurve(decodeBase58(pumpPoolAuthority(m2 as Address)))).toBe(false);
    const r = await run(['owners', '--dataset', creators]);
    expect(r.code, r.err).toBe(0);
    expect(r.out.trim().split('\n')).toEqual([PDAS[5]!, pda('creator-pda')].sort());
  });
});

describe('fetch', () => {
  const ownersFile = () => {
    const f = join(tmp, 'owners.txt');
    writeFileSync(f, [...PDAS].sort().join('\n') + '\n');
    return f;
  };
  const sources = () => {
    const f = join(tmp, 'datasets.json');
    writeFileSync(f, JSON.stringify([{ tag: 'data-2025-10-04-2025-10-05', manifestSha256: manifestHash(dataset) }]));
    return f;
  };

  test('the dry run plans the calls, writes only the plan and reads no RPC, even with a key set', async () => {
    const server = await rpc((a) => ({ status: 200, body: JSON.stringify({ result: { value: a.map(() => ({ owner: PROGRAM })) } }) }));
    const out = join(tmp, 'dry');
    const r = await run(['fetch', '--owners', ownersFile(), '--datasets', sources(), '--out', out, '--dry-run'], { RPC_URL: server.url, HELIUS_API_KEY: KEY });
    await server.close();
    expect(r.code, r.err).toBe(0);
    expect(server.calls).toEqual([]);
    expect(readdirSync(out)).toEqual(['owner-programs.plan.json']);
    expect(JSON.parse(readFileSync(join(out, 'owner-programs.plan.json'), 'utf8'))).toEqual({ owners: 150, calls: 2, accountsPerCall: 100, datasets: [{ tag: 'data-2025-10-04-2025-10-05', manifestSha256: manifestHash(dataset) }] });
    noKey(r, [out]);
  });

  test('looks every owner up in calls of at most 100 and writes a supplement that reads back, with its datasets', async () => {
    const server = await rpc((a) => ({ status: 200, body: JSON.stringify({ result: { value: a.map((o) => (o === PDAS[7] ? null : { owner: PROGRAM })) } }) }));
    const out = join(tmp, 'real');
    const r = await run(['fetch', '--owners', ownersFile(), '--datasets', sources(), '--out', out], { RPC_URL: server.url, RPC_NAME: 'local' });
    await server.close();
    expect(r.code, r.err).toBe(0);
    expect(server.calls.map((c) => c.addresses.length)).toEqual([100, 50]);
    const back = readOwnerPrograms(out);
    expect(back.size).toBe(150);
    expect(back.get(PDAS[7]!)).toBeNull();
    expect(back.get(PDAS[8]!)).toBe(PROGRAM);
    const m = JSON.parse(readFileSync(join(out, OWNER_PROGRAMS_MANIFEST), 'utf8')) as Record<string, unknown>;
    expect(m).toMatchObject({ file: OWNER_PROGRAMS_FILE, rows: 150, calls: 2, accounts: 150, source: 'local', datasets: [{ tag: 'data-2025-10-04-2025-10-05' }] });
    expect(m['sha256']).toBe(createHash('sha256').update(readFileSync(join(out, OWNER_PROGRAMS_FILE))).digest('hex'));
    noKey(r, [out]);
  });

  test('HELIUS_API_KEY alone selects Helius and names it in the manifest (no network here: the dry run proves the switch)', async () => {
    const out = join(tmp, 'helius-dry');
    const r = await run(['fetch', '--owners', ownersFile(), '--out', out, '--dry-run'], { HELIUS_API_KEY: KEY });
    expect(r.code, r.err).toBe(0);
    const none = await run(['fetch', '--owners', ownersFile(), '--out', join(tmp, 'no-rpc')]);
    expect(none.code).toBe(1);
    expect(none.err).toContain('RPC_URL or HELIUS_API_KEY is required (or --dry-run)');
    expect(readFileSync(SCRIPT, 'utf8')).toContain("name: 'helius'");
  });

  test.each([
    ['an HTTP error whose body echoes the URL', () => ({ status: 400, body: `{"bad":"${'http://127.0.0.1/?api-key=' + KEY}"}` })],
    ['an RPC error naming the key', () => ({ status: 200, body: JSON.stringify({ error: { code: -32602, message: `invalid api-key ${KEY}` } }) })],
    ['a reply that is not JSON', () => ({ status: 200, body: `<html>${KEY}</html>` })],
    ['a reply with the wrong number of accounts', () => ({ status: 200, body: JSON.stringify({ result: { value: [] } }) })],
    ['an account without a valid owner', (a: string[]) => ({ status: 200, body: JSON.stringify({ result: { value: a.map(() => ({ owner: KEY })) } }) })],
  ])('fails on %s, writes no supplement and never shows the URL or the key', async (_, reply) => {
    const server = await rpc(reply);
    const out = join(tmp, `fail-${Math.random()}`);
    const r = await run(['fetch', '--owners', ownersFile(), '--out', out], { RPC_URL: server.url });
    await server.close();
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^owner-programs: getMultipleAccounts/);
    expect(existsSync(join(out, OWNER_PROGRAMS_FILE))).toBe(false);
    noKey(r, [out]);
  });

  test('a refused connection is reported without the URL', async () => {
    const server = await rpc(() => ({ status: 200, body: '{}' }));
    const url = server.url;
    await server.close();
    const r = await run(['fetch', '--owners', ownersFile(), '--out', join(tmp, 'refused')], { RPC_URL: url });
    expect(r.code).toBe(1);
    expect(r.err).toContain('getMultipleAccounts: request failed');
    noKey(r, []);
  });

  test('an owners file with a wallet or junk is refused before any call', async () => {
    const f = join(tmp, 'bad-owners.txt');
    writeFileSync(f, `${PDAS[0]}\n${wallet('w9')}\n`);
    const r = await run(['fetch', '--owners', f, '--out', join(tmp, 'bad'), '--dry-run']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('is not an off-curve address');
  });
});

test('the BT-1d form (--dataset --out) still works, and records the dataset it read', async () => {
  const server = await rpc((a) => ({ status: 200, body: JSON.stringify({ result: { value: a.map(() => ({ owner: PROGRAM })) } }) }));
  const out = join(tmp, 'legacy');
  const r = await run(['--dataset', dataset, '--out', out], { RPC_URL: server.url });
  await server.close();
  expect(r.code, r.err).toBe(0);
  expect(readOwnerPrograms(out).size).toBe(150);
  expect(JSON.parse(readFileSync(join(out, OWNER_PROGRAMS_MANIFEST), 'utf8')).datasets).toEqual([{ tag: dataset, manifestSha256: manifestHash(dataset) }]);
  noKey(r, [out]);
});
