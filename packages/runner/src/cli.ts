// RUN-1 command line.
//   node packages/runner/src/cli.ts run --mode local|systemd [options]   start or resume a dry run (one segment)
//   node packages/runner/src/cli.ts scan <path>...                       fail if any secret value is in these files
// Prints names, paths and counts only, never a secret value.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_HEALTH_ADDR, ENTRIES, KEY_ENV, MAX_HOURS, RUN_NAME, RUNNER_EXIT, SECRET_NAMES, SEGMENT_MINUTES, segmentAllowed, STUB_ENTRY, WORKER_ENTRY, WORKER_UNIT } from './contract.ts';
import { LocalControl, SystemdControl } from './control.ts';
import type { Label } from './report.ts';
import { runSegment, tickAction } from './runner.ts';
import { scanPaths, secretsFromEnv } from './scan.ts';

const [cmd, ...rest] = process.argv.slice(2);

const runId = (label: Label, commit: string, now = new Date()): string =>
  `${label}-${now.toISOString().slice(0, 16).replace(/[-:]/g, '')}Z-${commit.slice(0, 12)}`;

const gitCommit = (mode: string): string => {
  if (process.env['GITHUB_SHA']) return process.env['GITHUB_SHA'];
  // On the host the release folder is named by its commit (OPS-1 update gate), and it holds no .git.
  if (mode === 'systemd') {
    try {
      return basename(readlinkSync('/opt/zeroed/current'));
    } catch {}
  }
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};

const runs = (rootDir: string): { id: string; meta: { name?: string }; finished: boolean }[] =>
  existsSync(rootDir)
    ? readdirSync(rootDir)
        .sort()
        .flatMap((id) => {
          try {
            const meta = JSON.parse(readFileSync(join(rootDir, id, 'run.json'), 'utf8')) as { name?: string };
            return [{ id, meta, finished: existsSync(join(rootDir, id, 'report.json')) }];
          } catch {
            return [];
          }
        })
    : [];

const runByName = (rootDir: string, name: string): string | undefined => runs(rootDir).find((r) => r.meta.name === name)?.id;

/** The host's off-site backup switch (ops/host-config.json in the deployed release); off unless it says true. */
const offsiteBackupOn = (): boolean => {
  try {
    return (JSON.parse(readFileSync('/opt/zeroed/current/ops/host-config.json', 'utf8')) as { offsite_backup?: unknown }).offsite_backup === true;
  } catch {
    return false;
  }
};

const output = (k: string, v: string): void => {
  const f = process.env['GITHUB_OUTPUT'];
  if (f) appendFileSync(f, `${k}=${v}\n`);
};

if (cmd === 'scan') {
  const secrets = secretsFromEnv(SECRET_NAMES);
  const findings = scanPaths(rest, secrets);
  console.log(`Secret scan: ${secrets.size} secret values, ${rest.length} paths.`);
  for (const f of findings) console.log(`FOUND ${f.what} in ${f.path}`);
  if (secrets.size === 0) console.log('Warning: no secret values in the environment, so only keypair shapes were checked.');
  process.exit(findings.length ? 1 : 0);
} else if (cmd === 'run') {
  const { values: v } = parseArgs({
    args: rest,
    options: {
      mode: { type: 'string' },
      'run-id': { type: 'string' },
      'evidence-root': { type: 'string', default: 'evidence/dryrun' },
      'state-dir': { type: 'string' },
      entry: { type: 'string', default: WORKER_ENTRY },
      hours: { type: 'string', default: '48' },
      'segment-minutes': { type: 'string' },
      'health-addr': { type: 'string', default: DEFAULT_HEALTH_ADDR },
      'recorded-dir': { type: 'string' },
      'recorded-artifact': { type: 'string' },
      commit: { type: 'string' },
      'sample-ms': { type: 'string' },
      'backup-minutes': { type: 'string', default: '60' },
      'run-name': { type: 'string' },
      segment: { type: 'string', default: '1' },
    },
  });
  const mode = v.mode;
  if (mode !== 'local' && mode !== 'systemd') throw new Error('--mode local|systemd');
  // The label follows the mode and cannot be chosen: only a run on the host can be a VPS run (§15).
  const label: Label = mode === 'systemd' && process.env['GITHUB_ACTIONS'] !== 'true' ? 'vps' : 'rehearsal';
  const keyVars = Object.keys(process.env).filter((k) => KEY_ENV.test(k));
  if (keyVars.length) {
    console.error(`Refused: key material in the environment (${keyVars.join(', ')}). A dry run has no signing key.`);
    process.exit(2);
  }
  const hours = Number(v.hours);
  if (!segmentAllowed(Number(v.segment), hours)) {
    console.error(`Refused: segment ${v.segment} of a ${v.hours} h run (at most ${MAX_HOURS} h, and ${SEGMENT_MINUTES}-minute jobs plus 2).`);
    process.exit(RUNNER_EXIT.refused);
  }
  if (mode === 'local' && !ENTRIES.includes(v.entry)) {
    console.error(`Refused: entry ${v.entry} is not one of ${ENTRIES.join(', ')}.`);
    process.exit(RUNNER_EXIT.refused);
  }
  const name = v['run-name'];
  if (mode === 'systemd' && !(name !== undefined && RUN_NAME.test(name))) {
    console.error('Refused: a host run needs --run-name (from packages/runner/qualifying-run.json).');
    process.exit(RUNNER_EXIT.refused);
  }
  const stateDir = resolve(v['state-dir'] ?? (mode === 'systemd' ? '/var/lib/zeroed' : 'dryrun-state'));
  const commit = v.commit ?? gitCommit(mode);
  if (mode === 'local' && !existsSync(v.entry)) {
    console.error(`Worker entry ${v.entry} not found. The real worker arrives with WORKER-1; ${STUB_ENTRY} rehearses the pipeline.`);
    process.exit(RUNNER_EXIT.refused);
  }
  // A host run is found again by its name after a reboot or a runner crash; only vps-tick starts a name.
  const id = v['run-id'] ?? (name !== undefined ? runByName(v['evidence-root'], name) : undefined) ?? runId(label, commit);
  const evidenceDir = resolve(v['evidence-root'], id);
  const sampleMs = v['sample-ms'] ? Number(v['sample-ms']) : 10_000;
  const targetMs = hours * 3_600_000;
  const segmentEnd = v['segment-minutes'] ? Date.now() + Number(v['segment-minutes']) * 60_000 : Number.POSITIVE_INFINITY;
  mkdirSync(stateDir, { recursive: true });
  const control =
    mode === 'systemd'
      ? new SystemdControl(WORKER_UNIT)
      : new LocalControl({
          entry: v.entry,
          cwd: process.cwd(),
          logPath: join(evidenceDir, 'logs', 'worker.log'),
          stateDir,
          env: {
            ...process.env,
            ZEROED_STATE_DIR: stateDir,
            ZEROED_MODE: 'paper',
            ZEROED_RECORDER: 'on',
            ZEROED_SIMULATE: 'on',
            ZEROED_DRILLS: 'on',
            ZEROED_HEALTH_ADDR: v['health-addr'],
            ZEROED_RUN_ID: id,
            ZEROED_RUN_LABEL: label,
            ZEROED_GIT_SHA: commit,
          },
        });
  const res = await runSegment({
    control,
    healthAddr: v['health-addr'],
    stateDir,
    evidenceDir,
    identity: { label, commit },
    newRun: { runId: id, ...(name === undefined ? {} : { name }), targetMs, entry: mode === 'systemd' ? `systemd:${WORKER_UNIT}` : v.entry },
    segmentEnd,
    keepRecorded: mode === 'systemd' ? 'host' : 'copy',
    handover: mode === 'local',
    // Wipe drills and the runner's own backups exist only where losing the state loses nothing real.
    ...(mode === 'local' ? { hostDrills: 'wipe' as const, backupEveryMs: Number(v['backup-minutes']) * 60_000 } : { hostDrills: 'tabletop' as const, offsiteBackup: offsiteBackupOn() }),
    ...(v['recorded-dir'] ? { recordedDir: resolve(v['recorded-dir']) } : {}),
    ...(v['recorded-artifact'] ? { recordedArtifact: v['recorded-artifact'] } : {}),
    sampleMs,
  });
  output('run_id', id);
  output('done', String(res.done));
  if (res.report) console.log(`Report: ${join(evidenceDir, 'REPORT.md')} (${res.report.pass ? 'pass' : 'not passed'}).`);
  process.exit(res.aborted ? RUNNER_EXIT.aborted : RUNNER_EXIT.ok);
} else if (cmd === 'check-segment') {
  // Before the fallback starts its next job: the chain stops itself.
  const { values: v } = parseArgs({ args: rest, options: { segment: { type: 'string' }, hours: { type: 'string' } } });
  const ok = segmentAllowed(Number(v.segment), Number(v.hours));
  console.log(ok ? `Segment ${v.segment} allowed.` : `Refused: segment ${v.segment} of a ${v.hours} h run.`);
  process.exit(ok ? RUNNER_EXIT.ok : RUNNER_EXIT.refused);
} else if (cmd === 'vps-tick') {
  // Run every 5 minutes by zeroed-dryrun-tick.timer on the host. Pull-based start: a merged commit that adds
  // packages/runner/qualifying-run.json asks for one run by name; the host starts that name once, and resumes
  // an unfinished run after a reboot or a runner crash. Nobody logs in to the host.
  const evidenceRoot = '/var/lib/zeroed-dryrun/evidence';
  const startedDir = '/var/lib/zeroed-dryrun/started';
  let request: unknown = null;
  try {
    request = (JSON.parse(readFileSync('/opt/zeroed/current/packages/runner/qualifying-run.json', 'utf8')) as { run?: unknown }).run;
  } catch {}
  let active: string[] = [];
  try {
    active = execFileSync('systemctl', ['list-units', 'zeroed-dryrun@*', '--state=active,activating', '--plain', '--no-legend'], { encoding: 'utf8' })
      .split('\n')
      .flatMap((l) => /^zeroed-dryrun@(\S+)\.service/.exec(l)?.[1] ?? []);
  } catch {}
  const unfinished = runs(evidenceRoot).find((r) => !r.finished && typeof r.meta.name === 'string')?.meta.name ?? null;
  const action = tickAction({ request, started: existsSync(startedDir) ? readdirSync(startedDir) : [], unfinished, active });
  if (action.start) {
    if (action.mark) {
      mkdirSync(startedDir, { recursive: true });
      appendFileSync(join(startedDir, action.start), `${new Date().toISOString()}\n`);
    }
    execFileSync('systemctl', ['start', '--no-block', `zeroed-dryrun@${action.start}.service`]);
  }
  console.log(action.why);
} else {
  console.error('usage: cli.ts run --mode local|systemd [...] | cli.ts scan <path>... | cli.ts check-segment --segment N --hours H | cli.ts vps-tick');
  process.exit(2);
}
