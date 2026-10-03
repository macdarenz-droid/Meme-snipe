// RUN-1 command line.
//   node packages/runner/src/cli.ts run --mode local|systemd [options]   start or resume a dry run (one segment)
//   node packages/runner/src/cli.ts scan <path>...                       fail if any secret value is in these files
// Prints names, paths and counts only, never a secret value.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_HEALTH_ADDR, KEY_ENV, SECRET_NAMES, STUB_ENTRY, WORKER_ENTRY } from './contract.ts';
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

/** The newest run in the evidence root that has no report yet (a restarted runner on the host picks it up). */
const unfinishedRun = (rootDir: string): string | undefined => {
  if (!existsSync(rootDir)) return undefined;
  return readdirSync(rootDir)
    .filter((d) => existsSync(join(rootDir, d, 'run.json')) && !existsSync(join(rootDir, d, 'report.json')))
    .sort()
    .at(-1);
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
      'resume-latest': { type: 'boolean', default: false },
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
  const stateDir = resolve(v['state-dir'] ?? (mode === 'systemd' ? '/var/lib/zeroed' : 'dryrun-state'));
  const commit = v.commit ?? gitCommit(mode);
  if (mode === 'local' && !existsSync(v.entry)) {
    console.error(`Worker entry ${v.entry} not found. The real worker arrives with WORKER-1; ${STUB_ENTRY} rehearses the pipeline.`);
    process.exit(2);
  }
  const id = v['run-id'] ?? (v['resume-latest'] ? unfinishedRun(v['evidence-root']) : undefined) ?? runId(label, commit);
  const evidenceDir = resolve(v['evidence-root'], id);
  const sampleMs = v['sample-ms'] ? Number(v['sample-ms']) : 10_000;
  const targetMs = Number(v.hours) * 3_600_000;
  const segmentEnd = v['segment-minutes'] ? Date.now() + Number(v['segment-minutes']) * 60_000 : Number.POSITIVE_INFINITY;
  mkdirSync(stateDir, { recursive: true });
  const control =
    mode === 'systemd'
      ? new SystemdControl()
      : new LocalControl({
          entry: v.entry,
          cwd: process.cwd(),
          logPath: join(evidenceDir, 'logs', 'worker.log'),
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
    newRun: { runId: id, label, commit, targetMs, entry: v.entry },
    segmentEnd,
    keepRecorded: mode === 'systemd' ? 'host' : 'copy',
    handover: mode === 'local',
    ...(v['recorded-dir'] ? { recordedDir: resolve(v['recorded-dir']) } : {}),
    ...(v['recorded-artifact'] ? { recordedArtifact: v['recorded-artifact'] } : {}),
    sampleMs,
  });
  output('run_id', id);
  output('done', String(res.done));
  if (res.report) console.log(`Report: ${join(evidenceDir, 'REPORT.md')} (${res.report.pass ? 'pass' : 'not passed'}).`);
  process.exit(res.aborted ? 1 : 0);
} else if (cmd === 'vps-tick') {
  // Run every 5 minutes by zeroed-dryrun-tick.timer on the host. Pull-based start: a merged commit that adds
  // packages/runner/qualifying-run.json asks for one run; the host starts it once, and resumes an unfinished run
  // after a reboot or a runner crash. Nobody logs in to the host.
  const evidenceRoot = '/var/lib/zeroed-dryrun/evidence';
  const startedDir = '/var/lib/zeroed-dryrun/started';
  let request: string | null = null;
  try {
    request = (JSON.parse(readFileSync('/opt/zeroed/current/packages/runner/qualifying-run.json', 'utf8')) as { run?: unknown }).run as string;
  } catch {}
  let active = false;
  try {
    execFileSync('systemctl', ['is-active', '--quiet', 'zeroed-dryrun.service']);
    active = true;
  } catch {}
  const action = tickAction({ request, started: existsSync(startedDir) ? readdirSync(startedDir) : [], unfinished: unfinishedRun(evidenceRoot) !== undefined, active });
  if (action.start) {
    if (action.mark) {
      mkdirSync(startedDir, { recursive: true });
      appendFileSync(join(startedDir, action.mark), `${new Date().toISOString()}\n`);
    }
    execFileSync('systemctl', ['start', '--no-block', 'zeroed-dryrun.service']);
  }
  console.log(action.why);
} else {
  console.error('usage: cli.ts run --mode local|systemd [...] | cli.ts scan <path>... | cli.ts vps-tick');
  process.exit(2);
}
