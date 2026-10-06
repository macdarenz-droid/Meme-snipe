import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STUB_ENTRY, type Health } from '../src/contract.ts';
import { LocalControl } from '../src/control.ts';
import { nativeStub } from './native-stub.ts';
import { journalLines, tradePhases } from './trade-phases.ts';

const root = join(import.meta.dirname, '../../..');
const freePort = (): Promise<number> => new Promise((resolve) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const port = (server.address() as { port: number }).port;
    server.close(() => resolve(port));
  });
});

describe('native compilation of the synthetic fixture', () => {
  it('only strips types and rewrites the contract import, retaining the exact source hashes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-stub-parity-'));
    const entry = nativeStub(dir);
    const worker = readFileSync(join(root, STUB_ENTRY), 'utf8');
    const contract = readFileSync(join(import.meta.dirname, '../src/contract.ts'), 'utf8');
    expect(readFileSync(entry, 'utf8')).toBe(stripTypeScriptTypes(worker).replace("'../src/contract.ts'", "'./contract.mjs'"));
    expect(readFileSync(join(dirname(entry), 'contract.mjs'), 'utf8')).toBe(stripTypeScriptTypes(contract));
    expect(JSON.parse(readFileSync(join(dirname(entry), 'source.json'), 'utf8'))).toMatchObject({ worker_sha256: createHash('sha256').update(worker).digest('hex'), contract_sha256: createHash('sha256').update(contract).digest('hex') });
  });

  it('the source and compiled child both reconcile the actual state, serve the same contract and stop cleanly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-stub-parity-'));
    const compiled = nativeStub(dir);
    const observe = async (entry: string, name: string) => {
      const stateDir = join(dir, name);
      mkdirSync(stateDir);
      const position = { trade: 'kept', openedAt: 0, universe: 'U2', exitPlanned: true };
      writeFileSync(join(stateDir, 'stub-state.json'), JSON.stringify({ trades: 1, position, intent: { trade: 'kept', leg: 'entry' } }));
      const phase = tradePhases(stateDir, 'hold');
      const addr = `127.0.0.1:${await freePort()}`;
      const control = new LocalControl({ entry, cwd: root, logPath: join(stateDir, 'worker.log'), stateDir, restartDelayMs: 200,
        env: { PATH: process.env['PATH'] ?? '', ZEROED_STATE_DIR: stateDir, ZEROED_MODE: 'paper', ZEROED_RECORDER: 'on', ZEROED_SIMULATE: 'on', ZEROED_DRILLS: 'on', ZEROED_HEALTH_ADDR: addr, ZEROED_GIT_SHA: 'c0ffee', ZEROED_STUB_TICK_MS: '50', ZEROED_STUB_TRADE_PHASE_FILE: phase.file } });
      let health: Health;
      try {
        await control.start();
        health = await phase.wait(addr, Date.now() + 6000, (h) => h.reconciled && h.exit_capable);
      } finally {
        await control.stop();
      }
      expect(control.starts).toBe(1);
      expect(readFileSync(join(stateDir, 'clean_stop'), 'utf8')).toMatch(/^20/);
      expect(journalLines(stateDir).filter((l) => l.kind === 'entry')).toEqual([]);
      return {
        health: { git_sha: health.git_sha, policy_version: health.policy_version, mode: health.mode, recorder: health.recorder, simulation: health.simulation, reconciled: health.reconciled, exit_capable: health.exit_capable, pending_exits: health.pending_exits, unresolved_intents: health.unresolved_intents, position: health.open_position && { trade: health.open_position.trade, universe: health.open_position.universe }, feeds: Object.keys(health.feeds).sort() },
        state: JSON.parse(readFileSync(join(stateDir, 'stub-state.json'), 'utf8')),
        journal: journalLines(stateDir).filter((l) => ['start', 'reconcile', 'recovered', 'exit_capable', 'stop'].includes(l.kind)).map(({ ts: _ts, boot: _boot, ...line }) => line),
      };
    };
    const source = await observe(STUB_ENTRY, 'source');
    const native = await observe(compiled, 'compiled');
    expect(native).toEqual(source);
    expect(native.health).toMatchObject({ reconciled: true, exit_capable: true, pending_exits: ['kept'], unresolved_intents: { count: 0 }, position: { trade: 'kept', universe: 'U2' } });
    expect(native.journal.map((l) => l.kind)).toEqual(['start', 'reconcile', 'recovered', 'exit_capable', 'stop']);
  }, 30_000);

  it.each([
    ['unset paper mode', [], { ZEROED_MODE: undefined }, 2],
    ['non-paper mode', [], { ZEROED_MODE: 'live' }, 2],
    ['normal startup reconcile failure', [], { ZEROED_MODE: 'paper', ZEROED_STUB_FAIL_RECONCILE: '1' }, 3],
    ['ExecStartPre reconcile failure', ['--reconcile'], { ZEROED_MODE: 'paper', ZEROED_STUB_FAIL_RECONCILE: '1' }, 3],
  ] as const)('retains refusal for %s', (_, args, overrides, exit) => {
    const dir = mkdtempSync(join(tmpdir(), 'native-stub-refusal-'));
    const compiled = nativeStub(dir);
    for (const entry of [STUB_ENTRY, compiled]) {
      const child = spawnSync(process.execPath, ['--no-warnings', entry, ...args], { cwd: root, encoding: 'utf8', timeout: 6000, env: { PATH: process.env['PATH'] ?? '', ZEROED_STATE_DIR: join(dir, entry === compiled ? 'compiled' : 'source'), ...overrides } });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(exit);
    }
  });
});
