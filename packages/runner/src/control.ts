// How the runner starts, kills and stops the worker: a child process (GitHub Actions, tests) or the
// zeroed-worker systemd unit of the OPS-1 host (VPS). Only the runner's drills kill; restarts come from the
// supervisor (here, or systemd's Restart=always), and every start reconciles first.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { cpSync, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, type WriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { EVIDENCE_FILES, STATE_FILES } from './contract.ts';

export interface RestoreDrillResult {
  readonly pass: boolean;
  readonly output: string;
}

export interface WorkerControl {
  /** Bring the worker up (or confirm the host keeps it up). */
  start(): Promise<void>;
  /** Process crash: SIGKILL, no warning, no cleanup. The supervisor restarts it. */
  kill(): Promise<void>;
  /** Reboot: everything stops at once and runtime state (tmpfs) is gone; a cold start follows. */
  reboot(): Promise<void>;
  /**
   * Host loss: the worker dies and its bot state is gone. With `restoreFrom`, the latest backup is restored first
   * (host-loss); without it the worker cold-starts with no state and rebuilds from chain (chain-rebuild). Evidence
   * files (journal, recorder) are kept: they are the run's record. Not possible on the qualifying host.
   */
  wipe(o: { readonly restoreFrom?: string }): Promise<void>;
  /** The host's restore drill (VPS): restore the newest backup into scratch and verify it; never touches live state. */
  restoreDrill?(): Promise<RestoreDrillResult>;
  /** Graceful stop (SIGTERM) at the end of a fallback job. */
  stop(): Promise<void>;
}

export interface LocalOptions {
  readonly entry: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly logPath: string;
  /** The worker's state dir, for reboot and wipe drills. */
  readonly stateDir?: string;
  /** Same as the host unit's RestartSec. */
  readonly restartDelayMs?: number;
  readonly stopTimeoutMs?: number;
}

/** Files a reboot clears: runtime files that live on tmpfs under systemd (the drill token is per boot anyway). */
const RUNTIME_FILES = [STATE_FILES.drillToken];

/** Supervises the worker like systemd does: `--reconcile` first, then the worker; restart after any exit. */
export class LocalControl implements WorkerControl {
  private child: ChildProcess | null = null;
  private stopping = false;
  private holding = false;
  private log: WriteStream | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private readonly o: LocalOptions;
  starts = 0;

  constructor(o: LocalOptions) {
    this.o = o;
  }

  async start(): Promise<void> {
    mkdirSync(dirname(this.o.logPath), { recursive: true });
    this.log = createWriteStream(this.o.logPath, { flags: 'a' });
    this.stopping = false;
    await this.launch();
  }

  private run(args: readonly string[]): ChildProcess {
    const c = spawn(process.execPath, ['--no-warnings', this.o.entry, ...args], { cwd: this.o.cwd, env: this.o.env, stdio: ['ignore', 'pipe', 'pipe'] });
    c.stdout?.pipe(this.log!, { end: false });
    c.stderr?.pipe(this.log!, { end: false });
    return c;
  }

  private async launch(): Promise<void> {
    if (this.stopping || this.holding) return;
    const code = await new Promise<number | null>((res) => this.run(['--reconcile']).on('exit', (c) => res(c)));
    if (this.stopping || this.holding) return;
    if (code !== 0) {
      this.line(`reconcile exited ${code}; retrying`);
      this.scheduleRestart();
      return;
    }
    this.starts += 1;
    const c = this.run([]);
    this.child = c;
    c.on('exit', (code, signal) => {
      if (this.child === c) this.child = null;
      this.line(`worker exited code=${code} signal=${signal}`);
      this.scheduleRestart();
    });
  }

  private scheduleRestart(delayMs = this.o.restartDelayMs ?? 5000): void {
    if (this.stopping || this.holding) return;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => void this.launch(), delayMs);
  }

  private line(s: string): void {
    this.log?.write(`[runner ${new Date().toISOString()}] ${s}\n`);
  }

  /** SIGKILL, then `prepare` while restarts are held, then the supervisor's restart after `delayMs`. */
  private async killThen(what: string, prepare: () => void, delayMs?: number): Promise<void> {
    this.holding = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const c = this.child;
    this.line(`drill: ${what}`);
    if (c && c.exitCode === null && c.signalCode === null) {
      const exited = new Promise<void>((res) => c.once('exit', () => res()));
      c.kill('SIGKILL');
      await exited;
    }
    prepare();
    this.holding = false;
    this.scheduleRestart(delayMs);
  }

  async kill(): Promise<void> {
    await this.killThen('SIGKILL', () => {});
  }

  async reboot(): Promise<void> {
    const dir = this.stateDir();
    // A reboot takes longer than a crash restart: the host boots before systemd starts the unit.
    await this.killThen('reboot', () => RUNTIME_FILES.forEach((f) => rmSync(join(dir, f), { force: true })), 2 * (this.o.restartDelayMs ?? 5000));
  }

  async wipe(o: { readonly restoreFrom?: string }): Promise<void> {
    const dir = this.stateDir();
    await this.killThen(o.restoreFrom ? 'host loss, restore from backup' : 'host loss, no backup: rebuild from chain', () => {
      for (const name of readdirSync(dir)) if (!EVIDENCE_FILES.includes(name)) rmSync(join(dir, name), { recursive: true, force: true });
      if (o.restoreFrom && existsSync(o.restoreFrom)) {
        for (const name of readdirSync(o.restoreFrom)) if (!EVIDENCE_FILES.includes(name)) cpSync(join(o.restoreFrom, name), join(dir, name), { recursive: true });
      }
    });
  }

  private stateDir(): string {
    if (!this.o.stateDir) throw new Error('reboot and wipe drills need the state dir');
    return this.o.stateDir;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const c = this.child;
    if (c && c.exitCode === null && c.signalCode === null) {
      const exited = new Promise<void>((res) => c.once('exit', () => res()));
      c.kill('SIGTERM');
      const t = setTimeout(() => c.kill('SIGKILL'), this.o.stopTimeoutMs ?? 30_000);
      await exited;
      clearTimeout(t);
    }
    this.child = null;
    await new Promise<void>((res) => (this.log ? this.log.end(() => res()) : res()));
  }
}

/** Copies the bot state (not the evidence) into `to`: the runner's own backup for local host-loss drills. */
export const snapshotState = (stateDir: string, to: string): void => {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(stateDir)) if (!EVIDENCE_FILES.includes(name)) cpSync(join(stateDir, name), join(to, name), { recursive: true });
};

const exec = promisify(execFile);

/** VPS: the OPS-1 unit owns the process (Restart=always, ExecStartPre reconcile). The runner only drills. */
export class SystemdControl implements WorkerControl {
  private readonly unit: string;
  constructor(unit = 'zeroed-worker.service') {
    this.unit = unit;
  }
  async start(): Promise<void> {
    await exec('systemctl', ['start', this.unit]);
  }
  async kill(): Promise<void> {
    await exec('systemctl', ['kill', '--signal=SIGKILL', this.unit]);
  }
  async reboot(): Promise<void> {
    // zeroed-dryrun-reboot.service reboots the host; this runner dies with it and resumes by name after boot.
    await exec('systemctl', ['start', '--no-block', 'zeroed-dryrun-reboot.service']);
  }
  async wipe(): Promise<void> {
    throw new Error('wipe drills are never run on the qualifying host');
  }
  async restoreDrill(): Promise<RestoreDrillResult> {
    try {
      const { stdout } = await exec('/usr/local/sbin/zeroed-restore-drill', ['/etc/zeroed/age/host.key'], { timeout: 300_000 });
      return { pass: /^PASS:/m.test(stdout), output: stdout.trim().split('\n').slice(-1)[0] ?? '' };
    } catch (e) {
      const out = (e as { stdout?: string }).stdout ?? '';
      return { pass: false, output: out.trim().split('\n').slice(-1)[0] || String((e as Error).message).slice(0, 200) };
    }
  }
  async stop(): Promise<void> {
    // The qualifying run ends with the worker still running: it is the bot, not a test process.
  }
}
