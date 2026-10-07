// RED TEAM C probes: host decision helpers (ops/host/files/usr/local/lib/zeroed/logic.sh) that fail OPEN on a missing
// or malformed input. Same harness as packages/ops/test/host-logic.test.ts. Each test asserts the correct behaviour, so
// it FAILS on the current code.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const LOGIC = join(root, 'ops/host/files/usr/local/lib/zeroed/logic.sh');
const sh = (script: string, input = '') => {
  const r = spawnSync('bash', ['-c', `set -euo pipefail; . "${LOGIC}"; ${script}`], { input, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
};
const tmp = mkdtempSync(join(tmpdir(), 'rtc-host-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('worker_entry: the release worker the reviewed host-config asks for', () => {
  const release = (name: string, config: string, withMain: boolean) => {
    const d = join(tmp, name);
    mkdirSync(join(d, 'ops'), { recursive: true });
    writeFileSync(join(d, 'ops/host-config.json'), config);
    if (withMain) {
      mkdirSync(join(d, 'packages/worker/src'), { recursive: true });
      writeFileSync(join(d, 'packages/worker/src/main.ts'), '');
    }
    return d;
  };

  it('never falls back to the stand-in when the config says "release" but the entry file is missing', () => {
    // logic.sh worker_entry: `... = release ] && [ -f main.ts ]` else the stub. The stub then passes worker-smoke
    // (worker-smoke:19 exits 0 for it) and zeroed-update's answers() (the stub reports git_sha = the release folder
    // name), so the switch "succeeds" with no trading worker and the watchdog sees healthy (stub) heartbeats.
    const r = sh(`worker_entry "${release('nomain', '{"worker":"release"}', false)}"`);
    expect(r.out).not.toBe('/opt/zeroed/stub/worker.mjs');
  });

  it('never falls back to the stand-in on a host-config that cannot be read', () => {
    // `jq ... 2>/dev/null || echo stub`: a malformed config silently means "stub"; worker_shakedown refuses the same file.
    const r = sh(`worker_entry "${release('badjson', '{"worker":"release",', true)}"`);
    expect(r.status === 0 && r.out === '/opt/zeroed/stub/worker.mjs').toBe(false);
  });
});

describe('record_alerts: the recording upload must not stay silent when it never reports', () => {
  it('raises an alert when the switch is on and the uploader never wrote a status', () => {
    // zeroed-check feeds '{}' when /var/lib/zeroed-record-upload/status.json is missing while "record_upload": true.
    // `.at` is not a number, so $on is false and every alert is "off" (CLEARED): an uploader that never runs (timer not
    // enabled: zeroed-update's `systemctl enable --now ... || true`, or a crash before the first status) is never
    // reported, while RECORD-BUDGET deletes the un-uploaded recordings at its cap.
    const lines = sh(`record_alerts ${Math.floor(Date.now() / 1000)}`, '{}').out.split('\n');
    expect(lines.some((l) => l.startsWith('on|'))).toBe(true);
  });
});
