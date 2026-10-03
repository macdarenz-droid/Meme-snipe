// How the runner starts, kills and stops the worker: a child process (GitHub Actions, tests) or the
// zeroed-worker systemd unit of the OPS-1 host (VPS). Only the runner's drills kill; restarts come from the
// supervisor (here, or systemd's Restart=always), and every start reconciles first.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

export interface WorkerControl {
  /** Bring the worker up (or confirm the host keeps it up). */
  start(): Promise<void>;
  /** The restart drill: SIGKILL, no warning, no cleanup. The supervisor restarts it. */
  kill(): Promise<void>;
  /** Graceful stop (SIGTERM) at the end of a fallback job. */
  stop(): Promise<void>;
}

export interface LocalOptions {
  readonly entry: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly logPath: string;
  /** Same as the host unit's RestartSec. */
  readonly restartDelayMs?: number;
  readonly stopTimeoutMs?: number;
}

/** Supervises the worker like systemd does: `--reconcile` first, then the worker; restart after any exit. */
export class LocalControl implements WorkerControl {
  private child: ChildProcess | null = null;
  private stopping = false;
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
    if (this.stopping) return;
    const code = await new Promise<number | null>((res) => this.run(['--reconcile']).on('exit', (c) => res(c)));
    if (this.stopping) return;
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

  private scheduleRestart(): void {
    if (this.stopping) return;
    this.restartTimer = setTimeout(() => void this.launch(), this.o.restartDelayMs ?? 5000);
  }

  private line(s: string): void {
    this.log?.write(`[runner ${new Date().toISOString()}] ${s}\n`);
  }

  async kill(): Promise<void> {
    this.line('drill: SIGKILL');
    this.child?.kill('SIGKILL');
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

const exec = promisify(execFile);

/** VPS: the OPS-1 unit owns the process (Restart=always, ExecStartPre reconcile). The runner only kills. */
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
  async stop(): Promise<void> {
    // The qualifying run ends with the worker still running: it is the bot, not a test process.
  }
}
