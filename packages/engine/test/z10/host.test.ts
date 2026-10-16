// Card Z10: the recorder's host contract (health.ts) and the "no key, no send path" guard.
import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { DEFAULT_PROVIDERS } from '../../src/m14/defaults.ts';
import { cgroupMemory, heartbeatBody, memoryWatch, parseLoopback, reconcile, signHeartbeat } from '../../src/recorder-main/health.ts';
import { credentialSecrets, SECRET_FILES } from '../../src/recorder-main/rpc.ts';
import { tempDir } from '../helpers.ts';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

describe('Z10 host contract', () => {
  it('reconcile writes open_intents and open_positions = 0, and never overwrites another worker\'s count that is not 0', () => {
    const d = tempDir('z10-reconcile');
    assert.deepEqual(reconcile(d), { ok: true, intents: '0', positions: '0' });
    assert.equal(readFileSync(join(d, 'open_intents'), 'utf8'), '0\n');
    assert.equal(readFileSync(join(d, 'open_positions'), 'utf8'), '0\n');
    assert.equal(reconcile(d).ok, true, 'a 0 left by the recorder itself is fine');
    writeFileSync(join(d, 'open_positions'), 'unknown\n');
    const r = reconcile(d);
    assert.ok(!r.ok && /open_positions=unknown/.test(r.reason));
    assert.equal(readFileSync(join(d, 'open_positions'), 'utf8'), 'unknown\n', 'kept');
    writeFileSync(join(d, 'open_positions'), '0\n');
    writeFileSync(join(d, 'open_intents'), '2\n');
    assert.equal(reconcile(d).ok, false);
  });

  it('health and API routes bind loopback only', () => {
    assert.deepEqual(parseLoopback('127.0.0.1:8787'), { host: '127.0.0.1', port: 8787 });
    assert.deepEqual(parseLoopback('[::1]:8788'), { host: '::1', port: 8788 });
    for (const bad of ['0.0.0.0:8787', '10.0.0.1:8787', 'localhost:8787', '127.0.0.1:0', '127.0.0.1:70000', '127.0.0.1']) assert.equal(parseLoopback(bad), null, bad);
  });

  it('the heartbeat has every field the watchdog requires, a u64 slot as a JSON number, no intent, signer not used, and the stand-in\'s signature form', () => {
    const body = heartbeatBody({ seq: 3, boot: 'b', gitSha: 'a'.repeat(40), lastSlot: 453_967_949n, critical: ['Recording halted: disk.'], ownerChat: '42', uptimeS: 9 }, 1_791_307_800_000, false);
    const hb = JSON.parse(body) as Record<string, unknown>;
    // packages/ops/src/watchdog/logic.ts:146-147: seq, ts, boot, git_sha, unresolved_intents, signer, paused.
    assert.equal(hb.seq, 3); assert.equal(hb.ts, 1_791_307_800_000); assert.equal(hb.boot, 'b'); assert.equal(hb.git_sha, 'a'.repeat(40));
    assert.deepEqual(hb.unresolved_intents, { count: 0, oldest_age_s: null });
    assert.equal(hb.signer, 'not-used'); assert.equal(hb.paused, false); assert.equal(hb.open_position, null); assert.equal(hb.sol_reserve, null);
    assert.match(body, /"last_processed_slot":453967949,/);
    assert.deepEqual(hb.critical, ['Recording halted: disk.']);
    assert.equal(signHeartbeat('k', 100, body), createHmac('sha256', 'k').update(`100\nPOST\n/heartbeat\n${body}`).digest('hex'));
  });

  it('the 75% memory alert: one alert per episode on anonymous memory, cleared below 70%, nothing without a limit', () => {
    let reading: { anonBytes: number; limitBytes: number | null } | null = { anonBytes: 700, limitBytes: 1_000 };
    const alerts: number[] = [];
    let cleared = 0;
    const w = memoryWatch({ read: () => (reading === null ? null : { ...reading, source: 'anon' as const }), alert: (r) => alerts.push(r.pct), cleared: () => { cleared++; } });
    assert.equal(w.check(), false);
    reading = { anonBytes: 749, limitBytes: 1_000 }; assert.equal(w.check(), false);
    reading = { anonBytes: 750, limitBytes: 1_000 }; assert.equal(w.check(), true);
    reading = { anonBytes: 900, limitBytes: 1_000 }; w.check();
    reading = { anonBytes: 720, limitBytes: 1_000 }; assert.equal(w.check(), true, 'held until below 70%');
    reading = { anonBytes: 699, limitBytes: 1_000 }; assert.equal(w.check(), false);
    assert.deepEqual(alerts, [75]); assert.equal(cleared, 1);
    reading = { anonBytes: 10_000, limitBytes: null }; assert.equal(w.check(), false, 'no limit, no alert');
    reading = null; assert.equal(w.check(), false);
  });

  it('cgroupMemory reads anon from memory.stat and memory.max of the process cgroup (v2), never page cache', () => {
    const root = tempDir('z10-cg');
    mkdirSync(join(root, 'system.slice/zeroed-worker.service'), { recursive: true });
    writeFileSync(join(root, 'self'), '0::/system.slice/zeroed-worker.service\n');
    writeFileSync(join(root, 'system.slice/zeroed-worker.service/memory.max'), '1073741824\n');
    writeFileSync(join(root, 'system.slice/zeroed-worker.service/memory.stat'), 'anon 314572800\nfile 900000000\n');
    assert.deepEqual(cgroupMemory(root, join(root, 'self')), { anonBytes: 314_572_800, limitBytes: 1_073_741_824, source: 'anon' });
    writeFileSync(join(root, 'system.slice/zeroed-worker.service/memory.max'), 'max\n');
    assert.deepEqual(cgroupMemory(root, join(root, 'self')), { anonBytes: 314_572_800, limitBytes: null, source: 'anon' });
    assert.equal(cgroupMemory(join(root, 'none'), join(root, 'missing')), null);
    // Ruling Z10-12: no `anon` field: memory.current minus the page cache (`file`), and the reading says which.
    writeFileSync(join(root, 'system.slice/zeroed-worker.service/memory.max'), '1073741824\n');
    writeFileSync(join(root, 'system.slice/zeroed-worker.service/memory.stat'), 'file 200000000\nkernel 1000\n');
    writeFileSync(join(root, 'system.slice/zeroed-worker.service/memory.current'), '600000000\n');
    assert.deepEqual(cgroupMemory(root, join(root, 'self')), { anonBytes: 400_000_000, limitBytes: 1_073_741_824, source: 'current_minus_file' });
    writeFileSync(join(root, 'system.slice/zeroed-worker.service/memory.stat'), 'kernel 1000\n');
    assert.equal(cgroupMemory(root, join(root, 'self')), null, 'neither field: no reading (no alert on a guess)');
  });
});

describe('Z10 guard: no key and no send path', () => {
  /** Every source file the recorder process can load, from scripts/recorder.ts through relative and @bot/* imports. */
  function importGraph(): Set<string> {
    const pkgs = resolve(SRC, '../../');
    const seen = new Set<string>();
    const todo = [join(SRC, '../scripts/recorder.ts')];
    while (todo.length > 0) {
      const f = todo.pop() as string;
      if (seen.has(f)) continue;
      seen.add(f);
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/^\s*(?:import|export)\s(?!type\b)[^'"]*?from\s+'([^']+)'/gm)) {
        const spec = m[1] as string;
        if (spec.startsWith('.')) todo.push(resolve(dirname(f), spec));
        else if (spec.startsWith('@bot/')) {
          const [, name, sub] = /^@bot\/([a-z]+)(?:\/([a-z]+))?$/.exec(spec) ?? [];
          todo.push(join(pkgs, name as string, 'src', sub === undefined ? 'index.ts' : `${sub}.ts`));
        }
      }
    }
    return seen;
  }

  it('the recorder reaches no signer, transaction builder or send module, and no npm package at run time', () => {
    const files = [...importGraph()].map((f) => f.replace(resolve(SRC, '../../'), ''));
    assert.ok(files.length > 60, `the graph was walked (${files.length} files)`);
    assert.ok(files.some((f) => f.endsWith('venue/src/pda.ts')) && files.some((f) => f.endsWith('m04/tracker.ts')));
    const forbidden = files.filter((f) => /\/signer\/|\/exitpath\/|\/tx\/|landing|sender|jito|send\.ts$/i.test(f));
    assert.deepEqual(forbidden, []);
    for (const f of importGraph()) {
      for (const m of readFileSync(f, 'utf8').matchAll(/^\s*(?:import|export)\s(?!type\b)[^'"]*?from\s+'([^']+)'/gm)) {
        const spec = m[1] as string;
        assert.ok(spec.startsWith('node:') || spec.startsWith('.') || spec.startsWith('@bot/'), `${f}: ${spec}`);
      }
    }
  });

  it('the read providers have read roles only, and the recorder never asks for a send', () => {
    assert.ok(DEFAULT_PROVIDERS.every((p) => p.roles.every((r) => r === 'read')));
    const dir = join(SRC, 'recorder-main');
    for (const f of readdirSync(dir)) {
      const t = readFileSync(join(dir, f), 'utf8');
      assert.doesNotMatch(t, /role:\s*'send'|sendTransaction|signer\.sock/, f);
    }
    assert.match(readFileSync(join(dir, 'rpc.ts'), 'utf8'), /sendEnabled: false/);
  });

  it('only four credentials are ever read: the two RPC URLs, the heartbeat key and the paired chat id', () => {
    const d = tempDir('z10-cred');
    for (const n of ['rpc_shyft_url', 'rpc_chainstack_url', 'helius_api_key', 'alchemy_api_key', 'jupiter_api_key', 'telegram_bot_token']) writeFileSync(join(d, n), `${n}-value`);
    const s = credentialSecrets(d);
    assert.equal(s.get('RPC_SHYFT_URL'), 'rpc_shyft_url-value');
    assert.equal(s.get('RPC_CHAINSTACK_URL'), 'rpc_chainstack_url-value');
    for (const n of ['HELIUS_API_KEY', 'helius_api_key', 'ALCHEMY_API_KEY', 'JUPITER_API_KEY', 'TELEGRAM_BOT_TOKEN']) assert.equal(s.get(n), undefined, n);
    assert.deepEqual(Object.values(SECRET_FILES).sort(), ['rpc_chainstack_url', 'rpc_shyft_url']);
    const main = readFileSync(join(SRC, 'recorder-main/run.ts'), 'utf8');
    assert.deepEqual([...main.matchAll(/cred\('([a-z_]+)'\)/g)].map((m) => m[1]).sort(), ['heartbeat_hmac_key', 'telegram_chat_id']);
  });
});
