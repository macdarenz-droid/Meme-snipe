// RED TEAM B round 4 (integration merge), A2-GATE x RC-STATE: the regime's graduates series and the restart holes
// saved with it (A2-GATE R2-6 `unobserved`, PERSIST-2) live in deployer-state.json, which RC-STATE's hourly backup
// leaves out with the deployer index. A host-loss restore then has no graduates series: the regime has to rebuild its
// survival history before any entry is judged (fail closed, but the bot cannot trade until then). Asserts the series
// is in the backup, so it FAILS on the merge.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const BACKUP = join(root, 'ops/host/files/usr/local/sbin/zeroed-backup');
const has = (b: string) => spawnSync('bash', ['-c', `command -v ${b}`]).status === 0;
const tmp = mkdtempSync(join(tmpdir(), 'rtb-backup-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe.skipIf(!has('age') || !has('age-keygen'))('RB-14 backup and the regime series', () => {
  it('RB-14a the graduates series and its saved holes survive a backup and restore', () => {
    const src = join(tmp, 'state');
    const out = join(tmp, 'out');
    const bin = join(tmp, 'bin');
    mkdirSync(src);
    mkdirSync(bin);
    writeFileSync(join(src, 'ledger.sqlite'), 'ledger');
    for (const f of ['control.json', 'account.json', 'exits.json', 'paper.json']) writeFileSync(join(src, f), '{}');
    // PERSIST-2: the saved graduates series (with A2-GATE's unobserved stretches) is a field of deployer-state.json.
    writeFileSync(join(src, 'deployer-state.json'), JSON.stringify({ graduates: { asOfMs: 1, items: [], unobserved: [{ fromMs: 0, toMs: 1 }] } }));
    writeFileSync(join(bin, 'sqlite3'), `#!/usr/bin/env bash
case "$*" in *".backup '"*) d="\${3#.backup \\'}"; cp "$1" "\${d%\\'}";; *integrity_check*) echo ok;; esac
`);
    chmodSync(join(bin, 'sqlite3'), 0o755);
    const key = join(tmp, 'id.key');
    spawnSync('age-keygen', ['-o', key]);
    writeFileSync(join(tmp, 'recipients'), `${spawnSync('age-keygen', ['-y', key], { encoding: 'utf8' }).stdout.trim()}\n`);
    const r = spawnSync('bash', [BACKUP], { encoding: 'utf8', env: { PATH: `${bin}:${process.env['PATH']}`, ZEROED_BACKUP_SRC: src, ZEROED_BACKUP_OUT: out, ZEROED_BACKUP_RECIPIENTS: join(tmp, 'recipients') } });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const file = readdirSync(out).find((f) => f.endsWith('.tar.age'))!;
    const restored = join(tmp, 'restored');
    mkdirSync(restored);
    const x = spawnSync('bash', ['-c', `age -d -i "${key}" "${join(out, file)}" | tar -C "${restored}" -x`], { encoding: 'utf8' });
    expect(x.status, x.stderr).toBe(0);
    expect(readdirSync(restored)).toContain('account.json');
    expect(readdirSync(restored)).toContain('deployer-state.json');
  });
});
