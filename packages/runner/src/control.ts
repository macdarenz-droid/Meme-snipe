// How the runner starts, kills and stops the worker: a child process (GitHub Actions, tests) or the
// zeroed-worker systemd unit of the OPS-1 host (VPS). Only the runner's drills kill; restarts come from the
// supervisor (here, or systemd's Restart=always), and every start reconciles first.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, type WriteStream } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { EVIDENCE_FILES, STATE_FILES } from './contract.ts';

/** A second worker started beside the live one in `--reconcile-only` mode on its own state dir and loopback port. */
export interface Tabletop {
  readonly healthAddr: string;
  readonly stateDir: string;
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
  /**
   * Host loss on the qualifying host, as a tabletop: a second worker in `--reconcile-only` mode cold-starts beside
   * the live one, from the newest backup (`restore`) or from an empty state dir (rebuild from chain). It sends
   * nothing. The live worker and the run's evidence are untouched.
   */
  tabletop(o: { readonly restore: boolean; readonly restoreFrom?: string }): Promise<Tabletop>;
  endTabletop(): Promise<void>;
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

  private table: { child: ChildProcess; dir: string } | null = null;

  async tabletop(o: { readonly restore: boolean; readonly restoreFrom?: string }): Promise<Tabletop> {
    const dir = mkdtempSync(join(tmpdir(), 'zeroed-tabletop-'));
    if (o.restore && o.restoreFrom && existsSync(o.restoreFrom)) cpSync(o.restoreFrom, dir, { recursive: true });
    const healthAddr = `127.0.0.1:${await freePort()}`;
    const child = spawn(process.execPath, ['--no-warnings', this.o.entry, '--reconcile-only'], {
      cwd: this.o.cwd,
      env: { ...this.o.env, ZEROED_STATE_DIR: dir, ZEROED_HEALTH_ADDR: healthAddr, ZEROED_DRILLS: 'off' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.pipe(this.log!, { end: false });
    child.stderr?.pipe(this.log!, { end: false });
    this.table = { child, dir };
    this.line(`drill: tabletop ${o.restore ? 'from the backup' : 'from an empty state dir'} on ${healthAddr}`);
    return { healthAddr, stateDir: dir };
  }

  async endTabletop(): Promise<void> {
    const t = this.table;
    this.table = null;
    if (!t) return;
    if (t.child.exitCode === null && t.child.signalCode === null) {
      const exited = new Promise<void>((res) => t.child.once('exit', () => res()));
      t.child.kill('SIGTERM');
      const k = setTimeout(() => t.child.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(k);
    }
    rmSync(t.dir, { recursive: true, force: true });
  }

  private stateDir(): string {
    if (!this.o.stateDir) throw new Error('reboot and wipe drills need the state dir');
    return this.o.stateDir;
  }

  async stop(): Promise<void> {
    await this.endTabletop();
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

const emptyDir = (dir: string): void => {
  if (existsSync(dir)) for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true });
};

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const srv = createServer().listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => res(port));
    });
    srv.on('error', rej);
  });

/** VPS: the OPS-1 unit owns the process (Restart=always, ExecStartPre reconcile). The runner only drills. */
type Exec = (file: string, args: readonly string[], opts?: { timeout?: number }) => Promise<unknown>;

export class SystemdControl implements WorkerControl {
  private readonly unit: string;
  private readonly run: Exec;
  private readonly tableDir: string;
  constructor(unit = 'zeroed-worker.service', run: Exec = exec, tableDir = SystemdControl.TABLETOP_DIR) {
    this.unit = unit;
    this.run = run;
    this.tableDir = tableDir;
  }
  async start(): Promise<void> {
    await this.run('systemctl', ['start', this.unit]);
  }
  async kill(): Promise<void> {
    await this.run('systemctl', ['kill', '--signal=SIGKILL', this.unit]);
  }
  async reboot(): Promise<void> {
    // zeroed-dryrun-reboot.service reboots the host; this runner dies with it and resumes by name after boot.
    await this.run('systemctl', ['start', '--no-block', 'zeroed-dryrun-reboot.service']);
  }
  async wipe(): Promise<void> {
    throw new Error('wipe drills are never run on the qualifying host: it runs the tabletop instead');
  }
  /** The tabletop worker's unit (OPS-1d installs it): `--reconcile-only`, its own state dir and port, the worker's credentials. */
  static readonly TABLETOP_UNIT = 'zeroed-worker-tabletop.service';
  static readonly TABLETOP_DIR = '/var/lib/zeroed-tabletop';
  static readonly TABLETOP_ADDR = '127.0.0.1:8789';

  async tabletop(o: { readonly restore: boolean }): Promise<Tabletop> {
    const dir = this.tableDir;
    // The dir is a StateDirectory of both units: empty it, never remove it.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    emptyDir(dir);
    if (o.restore) {
      // The newest hourly backup, decrypted with the host key into the tabletop's own state dir (never the live one).
      await this.run('/bin/sh', ['-c', 'set -e; b="$(ls -1 /var/backups/zeroed/zeroed-*.tar.age | LC_ALL=C sort -r | head -n 1)"; [ -n "$b" ]; age -d -i /etc/zeroed/age/host.key "$b" | tar -x -C "$1" --no-same-owner', 'sh', dir], { timeout: 120_000 });
    }
    await this.run('systemctl', ['start', SystemdControl.TABLETOP_UNIT]);
    return { healthAddr: SystemdControl.TABLETOP_ADDR, stateDir: dir };
  }

  async endTabletop(): Promise<void> {
    await this.run('systemctl', ['stop', SystemdControl.TABLETOP_UNIT]).catch(() => undefined);
    emptyDir(this.tableDir);
  }

  async stop(): Promise<void> {
    // The qualifying run ends with the worker still running: it is the bot, not a test process.
  }
}
