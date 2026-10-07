// RED TEAM C probe: the hourly host backup (ops/host/files/usr/local/sbin/zeroed-backup), which the host-loss restore
// (runner control.ts:281, ARCHITECTURE.md "Restart causes") unpacks as the bot state, holds only *.sqlite / *.db files.
// The worker's own state files are left out: control.json (owner pause + risk latches), account.json (paper wallet,
// opening equity, trades), exits.json (each open position's exit plan and stop), entry-seeds.json, paper.json,
// exposure.json. A restore then starts with no latches, no pause and a fresh bankroll. Asserts the correct behaviour,
// so it FAILS on the current code.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const BACKUP = join(root, 'ops/host/files/usr/local/sbin/zeroed-backup');
const has = (b: string) => spawnSync('bash', ['-c', `command -v ${b}`]).status === 0;
const tmp = mkdtempSync(join(tmpdir(), 'rtc-backup-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe.skipIf(!has('age') || !has('age-keygen'))('zeroed-backup coverage', () => {
  it('backs up every bot-state file the worker restores from, not only the SQLite ledger', () => {
    const src = join(tmp, 'state');
    const out = join(tmp, 'out');
    const bin = join(tmp, 'bin');
    mkdirSync(src);
    mkdirSync(bin);
    // The worker's state dir as it is on the host (ledger plus its JSON state files; worker.ts 760-775, state.ts).
    writeFileSync(join(src, 'ledger.sqlite'), 'ledger');
    for (const f of ['control.json', 'account.json', 'exits.json', 'entry-seeds.json', 'paper.json', 'exposure.json']) writeFileSync(join(src, f), '{}');
    // sqlite3 is not on this machine: a stand-in that copies for ".backup" and answers "ok" to the integrity check.
    writeFileSync(join(bin, 'sqlite3'), `#!/usr/bin/env bash
case "$*" in *".backup '"*) d="\${3#.backup \\'}"; cp "$1" "\${d%\\'}";; *integrity_check*) echo ok;; esac
`);
    chmodSync(join(bin, 'sqlite3'), 0o755);
    const key = join(tmp, 'id.key');
    spawnSync('age-keygen', ['-o', key]);
    const pub = spawnSync('age-keygen', ['-y', key], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(tmp, 'recipients'), `${pub}\n`);
    const r = spawnSync('bash', [BACKUP], { encoding: 'utf8', env: { PATH: `${bin}:${process.env['PATH']}`, ZEROED_BACKUP_SRC: src, ZEROED_BACKUP_OUT: out, ZEROED_BACKUP_RECIPIENTS: join(tmp, 'recipients') } });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const file = readdirSync(out).find((f) => f.endsWith('.tar.age'))!;
    const list = spawnSync('bash', ['-c', `age -d -i "$1" "$2" | tar -t`, 'x', key, join(out, file)], { encoding: 'utf8' }).stdout;
    const names = list.split('\n').map((l) => l.replace(/^\.\//, '')).filter(Boolean);
    expect(names).toContain('ledger.sqlite');
    expect(names).toEqual(expect.arrayContaining(['control.json', 'account.json', 'exits.json']));
  });
});
